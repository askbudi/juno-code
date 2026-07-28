#!/usr/bin/env python3
"""Helpers for multi-task Kanban + workflow task sets.

This is a guardrail/helper, not a new task store. It validates reusable task-set
contracts and can render a simple workflow YAML from a JSON manifest so task IDs,
tags, dependencies, and E2E exclusions come from one source.
"""
from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

ROOT = Path(__file__).resolve().parents[2]
MAX_TAG_LEN = 50
TAG_RE = re.compile(r"^[A-Za-z0-9_-]+$")
REQUIRED_SECTIONS = [
    "Context:",
    "ASCII flow:",
    "MUST:",
    "MUST NOT:",
    "Failure mode prevented:",
    "Runtime contract enforced:",
    "Exact validation gate:",
    "Why tests/backing implementation matter:",
]
HIGH_COMPUTE_MARKERS = ("High-compute contract:", "HIGH_COMPUTE", "write-capable high-compute")
HIGH_COMPUTE_REQUIRED_TERMS = ["run_id", "attempt_id", "checkpoint", "resume", "telemetry", "early", "denominator"]
CONSERVATIVE_READ_FIRST = [
    ".juno_task/wiki/parallel_runner_task_creation_best_practices.md",
    ".juno_task/wiki/parallel_runner_and_spec_review.md",
]
ROLE_READ_FIRST = {
    "implementation": ["AGENTS.md"],
    "review": ["AGENTS.md", ".juno_task/wiki/parallel_runner_and_spec_review.md"],
    "planning": ["AGENTS.md", ".juno_task/wiki/parallel_runner_task_creation_best_practices.md"],
}


class FinalizeReviewError(RuntimeError):
    """Final review evidence could not be produced safely."""


class TaskSetCreationError(RuntimeError):
    """A symbolic task set could not be created transactionally."""


def fail(msg: str) -> None:
    print(f"FAIL: {msg}", file=sys.stderr)
    raise SystemExit(1)


def warn(msg: str) -> None:
    print(f"WARN: {msg}", file=sys.stderr)


def validate_tag(tag: str, *, e2e: bool = False) -> list[str]:
    errors: list[str] = []
    if not tag:
        errors.append("tag is empty")
    if len(tag) > MAX_TAG_LEN:
        errors.append(f"tag '{tag}' is {len(tag)} chars; max supported helper length is {MAX_TAG_LEN}")
    if not TAG_RE.match(tag):
        errors.append(f"tag '{tag}' must contain only letters, numbers, underscores, and hyphens")
    if e2e and not tag.endswith("_E2E_post_deploy"):
        errors.append(f"E2E tag '{tag}' must end with _E2E_post_deploy")
    if not e2e and tag.endswith("_E2E_post_deploy"):
        errors.append(f"implementation tag '{tag}' must not end with _E2E_post_deploy")
    return errors


def validate_body(path: Path) -> list[str]:
    raw = path.read_bytes()
    text = raw.decode("utf-8")
    errors = [f"{path}: missing section {section}" for section in REQUIRED_SECTIONS if section not in text]
    if b"\x00" in raw:
        errors.append(f"{path}: contains a file-unsafe NUL byte")
    if b"\r\n" in raw or b"\r" in raw:
        errors.append(f"{path}: contains CRLF or carriage-return line endings; use LF")
    for line_number, line in enumerate(text.splitlines(), start=1):
        if line.endswith((" ", "\t")):
            errors.append(f"{path}:{line_number}: trailing whitespace is forbidden")
    if raw and not raw.endswith(b"\n"):
        errors.append(f"{path}: must end with a final newline")
    if "[blocked_by]" in text and "Blocked by:" not in text:
        errors.append(f"{path}: has [blocked_by] markup but no Blocked by section label")
    return errors


def validate_high_compute_body(path: Path) -> list[str]:
    text = path.read_text(encoding="utf-8")
    if not any(marker in text for marker in HIGH_COMPUTE_MARKERS):
        return []
    lowered = text.lower()
    errors = [f"{path}: high-compute body missing term '{term}'" for term in HIGH_COMPUTE_REQUIRED_TERMS if term not in lowered]
    if "small" not in lowered or "fixture" not in lowered or "full" not in lowered:
        errors.append(f"{path}: high-compute body must distinguish small/fixture/canary evidence from full-denominator evidence")
    return errors


def load_manifest(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        fail("manifest must be a JSON object")
    return data


def manifest_errors(manifest: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    impl_tag = str(manifest.get("implementation_tag", ""))
    e2e_tag = str(manifest.get("e2e_tag", ""))
    errors.extend(validate_tag(impl_tag, e2e=False))
    errors.extend(validate_tag(e2e_tag, e2e=True))
    if impl_tag == e2e_tag:
        errors.append("implementation_tag and e2e_tag must differ")
    tasks = manifest.get("tasks")
    if not isinstance(tasks, list) or not tasks:
        errors.append("manifest.tasks must be a non-empty list")
        return errors
    seen: set[str] = set()
    for i, task in enumerate(tasks):
        if not isinstance(task, dict):
            errors.append(f"tasks[{i}] must be an object")
            continue
        task_id = str(task.get("id", ""))
        role = str(task.get("role", ""))
        if not task_id:
            errors.append(f"tasks[{i}] missing id")
        if task_id in seen:
            errors.append(f"duplicate task id {task_id}")
        seen.add(task_id)
        if role == "post_deploy_e2e":
            errors.append(f"post-deploy E2E task {task_id} must be excluded from implementation workflow tasks")
        body_file = task.get("body_file")
        if body_file:
            body_path = (ROOT / body_file).resolve() if not Path(body_file).is_absolute() else Path(body_file)
            errors.extend(validate_body(body_path))
            errors.extend(validate_high_compute_body(body_path))
    for e2e_id in manifest.get("e2e_task_ids", []) or []:
        if e2e_id in seen:
            errors.append(f"E2E task {e2e_id} appears in implementation tasks list")
    return errors


SYMBOLIC_KEY_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]*$")
TASK_REFERENCE_RE = re.compile(r"\{\{task\.([A-Za-z][A-Za-z0-9_-]*)\}\}")
VALIDATOR_PLACEHOLDER_RE = re.compile(r"\{\{([a-z_]+)\}\}")
VALIDATOR_PLACEHOLDERS = {
    "body_file",
    "task_key",
    "role",
    "status",
    "tags_json",
    "dependencies_json",
}


def symbolic_task_set_errors(manifest: dict[str, Any], *, manifest_dir: Path | None = None, validate_files: bool = True) -> list[str]:
    errors: list[str] = []
    errors.extend(validate_tag(str(manifest.get("implementation_tag", "")), e2e=False))
    errors.extend(validate_tag(str(manifest.get("e2e_tag", "")), e2e=True))
    tasks = manifest.get("tasks")
    if not isinstance(tasks, list) or not tasks:
        return errors + ["manifest.tasks must be a non-empty list"]
    keys: list[str] = []
    validators = manifest.get("task_body_validators", []) or []
    if not isinstance(validators, list):
        errors.append("manifest.task_body_validators must be a list")
        validators = []
    for index, validator in enumerate(validators):
        if not isinstance(validator, dict):
            errors.append(f"task_body_validators[{index}] must be an object")
            continue
        name = str(validator.get("name", ""))
        command = validator.get("command")
        roles = validator.get("roles", []) or []
        if not name:
            errors.append(f"task_body_validators[{index}] missing name")
        if not isinstance(command, list) or not command or not all(isinstance(arg, str) and arg for arg in command):
            errors.append(f"task_body_validators[{index}] command must be a non-empty string list")
        else:
            unknown = sorted({match for arg in command for match in VALIDATOR_PLACEHOLDER_RE.findall(arg)} - VALIDATOR_PLACEHOLDERS)
            if unknown:
                errors.append(f"task_body_validators[{index}] command has unknown placeholders: {', '.join(unknown)}")
        if not isinstance(roles, list) or not all(isinstance(role, str) and role for role in roles):
            errors.append(f"task_body_validators[{index}] roles must be a string list")
        try:
            if float(validator.get("timeout_seconds", 30)) <= 0:
                raise ValueError
        except (TypeError, ValueError):
            errors.append(f"task_body_validators[{index}] timeout_seconds must be positive")
    for index, task in enumerate(tasks):
        if not isinstance(task, dict):
            errors.append(f"tasks[{index}] must be an object")
            continue
        key = str(task.get("key", ""))
        if not SYMBOLIC_KEY_RE.fullmatch(key):
            errors.append(f"tasks[{index}] has invalid or missing symbolic key '{key}'")
        elif key in keys:
            errors.append(f"duplicate symbolic task key {key}")
        keys.append(key)
        role = str(task.get("role", ""))
        tags = [str(tag) for tag in task.get("tags", []) or []]
        if role == "post_deploy_e2e" and manifest.get("implementation_tag") in tags:
            errors.append(f"post-deploy E2E task {key} must not carry the implementation tag")
        if role != "post_deploy_e2e" and manifest.get("e2e_tag") in tags:
            errors.append(f"implementation task {key} must not carry the E2E tag")
        body_file = task.get("body_file")
        if not body_file:
            errors.append(f"task {key or index} missing body_file")
        elif validate_files:
            base = manifest_dir or ROOT
            body_path = Path(body_file)
            if not body_path.is_absolute():
                body_path = base / body_path
            if not body_path.is_file():
                errors.append(f"task {key} body file does not exist: {body_path}")
            else:
                errors.extend(validate_body(body_path))
                errors.extend(validate_high_compute_body(body_path))
        if role == "post_deploy_e2e":
            matching_validators = [
                validator
                for validator in validators
                if isinstance(validator, dict)
                and (not (validator.get("roles", []) or []) or role in validator.get("roles", []))
            ]
            if not matching_validators:
                errors.append(
                    f"task {key or index} role post_deploy_e2e requires a canonical task_body_validator"
                )
    key_set = set(keys)
    by_key = {str(task.get("key")): task for task in tasks if isinstance(task, dict)}

    def ancestors(key: str) -> set[str]:
        found: set[str] = set()
        pending = list(by_key.get(key, {}).get("blocked_by", []) or [])
        while pending:
            dependency = str(pending.pop())
            if dependency in found or dependency not in by_key:
                continue
            found.add(dependency)
            pending.extend(by_key[dependency].get("blocked_by", []) or [])
        return found

    for task in tasks:
        if not isinstance(task, dict):
            continue
        key = str(task.get("key"))
        for dependency in task.get("blocked_by", []) or []:
            if str(dependency) not in key_set:
                errors.append(f"task {key} has unknown symbolic dependency {dependency}")
        if validate_files and task.get("body_file"):
            body_path = Path(task["body_file"])
            if not body_path.is_absolute():
                body_path = (manifest_dir or ROOT) / body_path
            if body_path.is_file():
                for reference in TASK_REFERENCE_RE.findall(body_path.read_text(encoding="utf-8")):
                    if reference not in key_set:
                        errors.append(f"task {key} body has unknown symbolic task reference {reference}")
                    elif reference not in ancestors(key):
                        errors.append(f"task {key} body references {reference}, which is not a true dependency ancestor")
    if not errors:
        try:
            topological_task_keys(tasks)
        except ValueError as exc:
            errors.append(str(exc))
    return errors


def topological_task_keys(tasks: list[dict[str, Any]]) -> list[str]:
    by_key = {str(task["key"]): task for task in tasks}
    remaining = {key: set(map(str, task.get("blocked_by", []) or [])) for key, task in by_key.items()}
    result: list[str] = []
    while remaining:
        ready = [key for key in by_key if key in remaining and not remaining[key]]
        if not ready:
            raise ValueError("symbolic task dependency graph contains a cycle")
        for key in ready:
            result.append(key)
            remaining.pop(key)
            for dependencies in remaining.values():
                dependencies.discard(key)
    return result


def q(value: str) -> str:
    return value.replace("'", "''")


def render_workflow(manifest: dict[str, Any]) -> str:
    workflow_id = manifest.get("workflow_id") or manifest.get("id") or "task_set_workflow"
    name = manifest.get("name") or workflow_id.replace("_", " ").title()
    description = manifest.get("description") or "Generated Kanban task-set workflow."
    impl_tag = manifest["implementation_tag"]
    e2e_tag = manifest["e2e_tag"]
    parent = manifest.get("parent_task", "")
    kanban_wrapper = str(manifest.get("kanban_wrapper", "./.juno_task/scripts/kanban.sh"))
    kanban_cmd = shlex.quote(kanban_wrapper)
    lines: list[str] = [
        "# Generated by .juno_task/scripts/task_workflow_helper.py render-workflow",
        f"# E2E tag excluded from implementation workflow: {e2e_tag}",
        "schema_version: 1",
        f"workflow_id: {workflow_id}",
        f"name: {name}",
        f"description: {description}",
        "vars:",
        f"  implementation_tag: {impl_tag}",
        f"  e2e_tag: {e2e_tag}",
        f"  parent_task: {parent}",
        "steps:",
        "  - id: preflight",
        "    description: Resolve selected Kanban tasks and prove E2E tag isolation",
        "    capture_session: false",
        "    fail_workflow: true",
        "    command: |",
        "      set -eu",
    ]
    if parent:
        lines.append(f"      {kanban_cmd} get {parent} --compact >/dev/null")
    for task in manifest["tasks"]:
        lines.append(f"      {kanban_cmd} get {task['id']} --compact >/dev/null")
    for e2e_id in manifest.get("e2e_task_ids", []) or []:
        lines.append(f"      {kanban_cmd} get {e2e_id} --compact >/dev/null")
    lines.extend([
        "      printf '%s\\n' 'Implementation tag table:'",
        f"      {kanban_cmd} search --tag {impl_tag} --format table --limit 50",
        "      printf '%s\\n' 'Post-deploy E2E tag table:'",
        f"      {kanban_cmd} search --tag {e2e_tag} --format table --limit 50",
        f"      printf '%s\\n' 'Post-deploy E2E tag {e2e_tag} is excluded from implementation agent steps.'",
    ])
    for idx, task in enumerate(manifest["tasks"], start=1):
        task_id = task["id"]
        step_id = task.get("step_id") or f"task_{idx}_{task_id}"
        title = task.get("title") or f"Run Kanban task {task_id}"
        if "read_first" in task:
            read_first = task["read_first"]
        else:
            read_first = ROLE_READ_FIRST.get(str(task.get("role", "")), CONSERVATIVE_READ_FIRST)
        read_lines = "\n".join(f"        - `{path}`" for path in read_first) if read_first else "        (none explicitly supplied)"
        prior = task.get("prior_step")
        prior_block = f"\n\n        Prior step response:\n        {{{{ steps.{prior}.response }}}}" if prior else ""
        terminal_guard = []
        if str(task.get("role", "")) == "review":
            terminal_guard = [
                "        - MUST NOT run workflow doctor for the currently running workflow; its manifest is not terminal.",
                "        - The terminal owner runs `finalize-review` after the workflow has completed.",
            ]
        lines.extend([
            f"  - id: {step_id}",
            f"    description: {title}",
            "    capture_session: false",
            "    fail_workflow: true",
            "    command:",
            "      - yy",
            "      - pi",
            "      - |",
            f"        You are an empty-context agent for Kanban task {task_id}.",
            "",
            "        Read first:",
            read_lines,
            "",
            "        Then run only this Kanban task:",
            f"        - Get task: `{kanban_wrapper} get {task_id} --compact`",
            "        - Fetch a particular related task separately only when its complete body is required.",
            "        - Mark in_progress with a response-file.",
            "        - Follow every MUST/MUST NOT and exact validation gate in the task body.",
            "        - Mark done only when validation evidence satisfies the task; otherwise leave a clear blocker response.",
            f"        - Do not run post-deploy E2E or use tag `{e2e_tag}`.",
            *terminal_guard,
            "",
            f"        Parent task: {parent}",
            f"        Shared implementation tag: {impl_tag}" + prior_block,
        ])
    return "\n".join(lines) + "\n"


def run(cmd: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, cwd=str(ROOT), text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def atomic_write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(f".{path.name}.tmp")
    tmp_path.write_text(content, encoding="utf-8")
    os.replace(str(tmp_path), str(path))


def atomic_write_json(path: Path, data: Any) -> None:
    atomic_write_text(path, json.dumps(data, indent=2, sort_keys=True) + "\n")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def preflight_task_set(manifest: dict[str, Any], manifest_path: Path) -> list[dict[str, Any]]:
    """Render the complete symbolic plan and run every project canonical validator.

    Preview IDs are stable non-Kanban tokens. They let validators inspect fully
    substituted bodies and dependency structure before any create call occurs.
    """
    preview_ids = {key: f"JUNO_PREFLIGHT_{key}" for key in topological_task_keys(manifest["tasks"])}
    by_key = {str(task["key"]): task for task in manifest["tasks"]}
    validators = manifest.get("task_body_validators", []) or []
    rows: list[dict[str, Any]] = []
    validation_errors: list[str] = []
    with tempfile.TemporaryDirectory(prefix="juno-task-set-preflight-") as temporary:
        body_dir = Path(temporary)
        for key in topological_task_keys(manifest["tasks"]):
            task = by_key[key]
            source_path = Path(task["body_file"])
            if not source_path.is_absolute():
                source_path = manifest_path.parent / source_path
            source_body = source_path.read_text(encoding="utf-8")
            resolved_body = TASK_REFERENCE_RE.sub(
                lambda match: preview_ids[match.group(1)], source_body
            )
            body_path = body_dir / f"{key}.md"
            body_path.write_text(resolved_body, encoding="utf-8")
            role = str(task.get("role", ""))
            required_tag = (
                manifest["e2e_tag"]
                if role == "post_deploy_e2e"
                else manifest["implementation_tag"]
            )
            tags = list(
                dict.fromkeys([required_tag] + [str(tag) for tag in task.get("tags", []) or []])
            )
            dependencies = [preview_ids[str(dep)] for dep in task.get("blocked_by", []) or []]
            status = str(task.get("status", "todo"))
            row = {
                "key": key,
                "role": role,
                "status": status,
                "tags": tags,
                "dependencies": dependencies,
                "body_sha256": hashlib.sha256(resolved_body.encode("utf-8")).hexdigest(),
            }
            rows.append(row)
            values = {
                "body_file": str(body_path),
                "task_key": key,
                "role": role,
                "status": status,
                "tags_json": json.dumps(tags, separators=(",", ":")),
                "dependencies_json": json.dumps(dependencies, separators=(",", ":")),
            }
            for validator in validators:
                roles = validator.get("roles", []) or []
                if roles and role not in roles:
                    continue
                command = [
                    VALIDATOR_PLACEHOLDER_RE.sub(lambda match: values[match.group(1)], arg)
                    for arg in validator["command"]
                ]
                timeout_seconds = float(validator.get("timeout_seconds", 30))
                env = os.environ.copy()
                env.update({f"JUNO_TASK_{name.upper()}": value for name, value in values.items()})
                env["JUNO_TASK_VALIDATION_ONLY"] = "1"
                try:
                    proc = subprocess.run(
                        command,
                        cwd=str(manifest_path.parent),
                        env=env,
                        text=True,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        stdin=subprocess.DEVNULL,
                        timeout=timeout_seconds,
                    )
                except (OSError, subprocess.TimeoutExpired) as exc:
                    validation_errors.append(
                        f"task {key} validator {validator['name']} body {source_path}: {exc}"
                    )
                    continue
                if proc.returncode != 0:
                    detail = proc.stderr.strip() or proc.stdout.strip() or f"exit {proc.returncode}"
                    for line in detail.splitlines():
                        validation_errors.append(
                            f"task {key} validator {validator['name']} body {source_path}: {line}"
                        )
    if validation_errors:
        raise TaskSetCreationError("canonical task-body preflight failed: " + "; ".join(validation_errors))
    return rows


def parse_kanban_task(stdout: str) -> dict[str, Any]:
    data = json.loads(stdout)
    if isinstance(data, list):
        if len(data) != 1:
            raise ValueError(f"expected one Kanban task, got {len(data)}")
        data = data[0]
    if not isinstance(data, dict) or not data.get("id"):
        raise ValueError("Kanban output does not contain one task object with an id")
    return data


def resolved_task_set(manifest: dict[str, Any], ids: dict[str, str] | None = None) -> dict[str, Any]:
    ids = ids or {}
    tasks = manifest["tasks"]
    by_key = {str(task["key"]): task for task in tasks}
    rows = []
    for key in topological_task_keys(tasks):
        task = by_key[key]
        key = str(task["key"])
        row = dict(task)
        row["id"] = ids.get(key)
        row["blocked_by_ids"] = [ids.get(str(dep)) for dep in task.get("blocked_by", []) or []]
        rows.append(row)
    implementation = [row for row in rows if row.get("role") != "post_deploy_e2e"]
    e2e = [row for row in rows if row.get("role") == "post_deploy_e2e"]
    mutation_claims = []
    for claim in manifest.get("mutation_claims", []) or []:
        resolved_claim = dict(claim)
        task_key = resolved_claim.pop("task_key", None)
        if task_key is not None:
            resolved_claim["task_id"] = ids.get(str(task_key))
        mutation_claims.append(resolved_claim)
    return {
        "workflow_id": manifest.get("workflow_id", "task_set_workflow"),
        "name": manifest.get("name"),
        "description": manifest.get("description"),
        "implementation_tag": manifest["implementation_tag"],
        "e2e_tag": manifest["e2e_tag"],
        "parent_task": manifest.get("parent_task", ""),
        "owned_paths": manifest.get("owned_paths", []) or [],
        "baseline_dirty_paths": manifest.get("baseline_dirty_paths", []) or [],
        "mutation_claims": mutation_claims,
        "kanban_wrapper": manifest.get("kanban_wrapper", "./.juno_task/scripts/kanban.sh"),
        "creation_order": [{"key": key, "id": ids.get(key)} for key in topological_task_keys(tasks)],
        "tasks": implementation,
        "e2e_tasks": e2e,
        "e2e_task_ids": [row["id"] for row in e2e if row.get("id")],
    }


def workflow_manifest_from_resolved(resolved: dict[str, Any]) -> dict[str, Any]:
    tasks = []
    for row in resolved["tasks"]:
        task = dict(row)
        task["id"] = task.get("id") or f"UNCREATED_{task['key']}"
        task.pop("key", None)
        task.pop("blocked_by_ids", None)
        tasks.append(task)
    return {
        "workflow_id": resolved["workflow_id"],
        "name": resolved.get("name"),
        "description": resolved.get("description"),
        "implementation_tag": resolved["implementation_tag"],
        "e2e_tag": resolved["e2e_tag"],
        "parent_task": resolved.get("parent_task", ""),
        "owned_paths": resolved.get("owned_paths", []),
        "baseline_dirty_paths": resolved.get("baseline_dirty_paths", []),
        "mutation_claims": resolved.get("mutation_claims", []),
        "kanban_wrapper": resolved.get("kanban_wrapper", "./.juno_task/scripts/kanban.sh"),
        "tasks": tasks,
        "e2e_task_ids": resolved.get("e2e_task_ids", []),
    }


def render_parent_response(resolved: dict[str, Any], *, mode: str) -> str:
    lines = [
        f"Task-set {mode} artifacts generated from the symbolic manifest.",
        "",
        f"- Implementation tag: `{resolved['implementation_tag']}`",
        f"- Post-deploy E2E tag: `{resolved['e2e_tag']}`",
        "- Human semantic acceptance remains required.",
        "",
        "Resolved tasks:",
    ]
    for row in resolved["creation_order"]:
        lines.append(f"- `{row['key']}` -> `{row.get('id') or 'DRY_RUN_UNCREATED'}`")
    return "\n".join(lines) + "\n"


def create_task_set(manifest_path: Path, output_dir: Path, *, execute: bool = False, kanban_wrapper: str = "./.juno_task/scripts/kanban.sh") -> dict[str, Any]:
    manifest_path = manifest_path.resolve()
    output_dir = output_dir.resolve()
    manifest = load_manifest(manifest_path)
    errors = symbolic_task_set_errors(manifest, manifest_dir=manifest_path.parent)
    if errors:
        raise TaskSetCreationError("invalid symbolic task set: " + "; ".join(errors))
    preflight_rows = preflight_task_set(manifest, manifest_path)
    output_dir.mkdir(parents=True, exist_ok=True)
    mode = "execute" if execute else "dry_run"
    receipt: dict[str, Any] = {
        "schema": "juno_symbolic_task_set_receipt.v1",
        "mode": mode,
        "status": "running" if execute else "planned",
        "started_at": utc_now(),
        "manifest": str(manifest_path),
        "kanban_wrapper": kanban_wrapper,
        "created_tasks": {},
        "create_results": [],
        "archive_results": [],
        "preflight": {"status": "passed", "tasks": preflight_rows},
        "human_acceptance_required": True,
    }
    ids: dict[str, str] = {}
    atomic_write_json(output_dir / "receipt.json", receipt)
    if execute:
        by_key = {str(task["key"]): task for task in manifest["tasks"]}
        try:
            for key in topological_task_keys(manifest["tasks"]):
                task = by_key[key]
                body_path = Path(task["body_file"])
                if not body_path.is_absolute():
                    body_path = manifest_path.parent / body_path
                source_body = body_path.read_text(encoding="utf-8")
                resolved_body = TASK_REFERENCE_RE.sub(lambda match: ids[match.group(1)], source_body)
                body_path = output_dir / "resolved_bodies" / f"{key}.md"
                atomic_write_text(body_path, resolved_body)
                role = str(task.get("role", ""))
                required_tag = manifest["e2e_tag"] if role == "post_deploy_e2e" else manifest["implementation_tag"]
                tags = list(dict.fromkeys([required_tag] + [str(tag) for tag in task.get("tags", []) or []]))
                dependencies = [ids[str(dep)] for dep in task.get("blocked_by", []) or []]
                cmd = [kanban_wrapper, "-f", "json", "create", "--body-file", str(body_path), "--status", str(task.get("status", "todo")), "--tags", *tags]
                if dependencies:
                    cmd.extend(["--blocked-by", *dependencies])
                proc = run(cmd)
                if proc.returncode != 0:
                    raise TaskSetCreationError(f"create failed for {key}: {proc.stderr.strip() or proc.stdout.strip()}")
                created = parse_kanban_task(proc.stdout)
                task_id = str(created["id"])
                ids[key] = task_id
                receipt["created_tasks"][key] = task_id
                readback_proc = run([kanban_wrapper, "-f", "json", "get", task_id])
                readback = parse_kanban_task(readback_proc.stdout) if readback_proc.returncode == 0 else {}
                observed_tags = readback.get("feature_tags") or []
                observed_dependencies = [str(value) for value in (readback.get("blocked_by") or [])]
                forbidden_tag = manifest["implementation_tag"] if role == "post_deploy_e2e" else manifest["e2e_tag"]
                verified = (
                    readback_proc.returncode == 0
                    and str(readback.get("id")) == task_id
                    and str(readback.get("status")) == str(task.get("status", "todo"))
                    and all(tag in observed_tags for tag in tags)
                    and forbidden_tag not in observed_tags
                    and observed_dependencies == dependencies
                )
                receipt["create_results"].append({"key": key, "id": task_id, "verified": verified})
                atomic_write_json(output_dir / "receipt.json", receipt)
                if not verified:
                    raise TaskSetCreationError(f"read-after-write verification failed for {key}/{task_id}")
            receipt["status"] = "created"
        except Exception as exc:
            receipt["error"] = str(exc)
            for key, task_id in reversed(list(ids.items())):
                archive_proc = run([kanban_wrapper, "archive", task_id])
                readback_proc = run([kanban_wrapper, "-f", "json", "get", task_id])
                try:
                    archived = parse_kanban_task(readback_proc.stdout)
                except Exception:
                    archived = {}
                receipt["archive_results"].append({
                    "key": key,
                    "id": task_id,
                    "archive_exit_code": archive_proc.returncode,
                    "verified": archive_proc.returncode == 0 and archived.get("status") == "archive",
                })
            receipt["status"] = "partial_create_archived" if ids and all(row["verified"] for row in receipt["archive_results"]) else "partial_create_cleanup_failed" if ids else "create_failed"
            receipt["completed_at"] = utc_now()
            atomic_write_json(output_dir / "receipt.json", receipt)
            raise TaskSetCreationError(str(exc)) from exc
    manifest_for_resolution = json.loads(json.dumps(manifest))
    manifest_for_resolution["kanban_wrapper"] = kanban_wrapper
    for task in manifest_for_resolution["tasks"]:
        body_file = Path(task["body_file"])
        if not body_file.is_absolute():
            task["body_file"] = str((manifest_path.parent / body_file).resolve())
    resolved = resolved_task_set(manifest_for_resolution, ids)
    atomic_write_json(output_dir / "resolved_manifest.json", resolved)
    atomic_write_text(output_dir / "workflow.yaml", render_workflow(workflow_manifest_from_resolved(resolved)))
    atomic_write_text(output_dir / "parent_response.md", render_parent_response(resolved, mode=mode))
    receipt["artifacts"] = {
        "resolved_manifest": str(output_dir / "resolved_manifest.json"),
        "workflow": str(output_dir / "workflow.yaml"),
        "parent_response": str(output_dir / "parent_response.md"),
    }
    receipt["completed_at"] = utc_now()
    atomic_write_json(output_dir / "receipt.json", receipt)
    return receipt


def verify_mutation_claims(claims: dict[str, Any], output: Path, kanban_wrapper: str = "./.juno_task/scripts/kanban.sh") -> dict[str, Any]:
    rows = claims.get("claims")
    if not isinstance(rows, list) or not rows:
        raise ValueError("claims must contain a non-empty claims list")
    receipt: dict[str, Any] = {
        "schema": "juno_kanban_mutation_claim_receipt.v1",
        "checked_at": utc_now(),
        "status": "verified",
        "results": [],
        "human_acceptance_required": True,
    }
    for claim in rows:
        task_id = str(claim.get("task_id", ""))
        expected = claim.get("expected", {}) or {}
        proc = run([kanban_wrapper, "-f", "json", "get", task_id])
        mismatches: list[str] = []
        observed: dict[str, Any] = {}
        if proc.returncode != 0:
            mismatches.append(f"read failed with exit code {proc.returncode}")
        else:
            try:
                task = parse_kanban_task(proc.stdout)
                observed = {field: task.get(field) for field in ("id", "status", "commit_hash", "last_modified", "feature_tags")}
                for field in ("status", "commit_hash", "last_modified"):
                    if field in expected and task.get(field) != expected[field]:
                        mismatches.append(f"{field}: expected {expected[field]!r}, observed {task.get(field)!r}")
                for tag in expected.get("tags_include", []) or []:
                    if tag not in (task.get("feature_tags") or []):
                        mismatches.append(f"feature_tags missing {tag!r}")
                response = str(task.get("agent_response", ""))
                for needle in expected.get("response_contains", []) or []:
                    if str(needle) not in response:
                        mismatches.append(f"agent_response missing required text {needle!r}")
            except Exception as exc:
                mismatches.append(f"invalid readback: {exc}")
        receipt["results"].append({"task_id": task_id, "verified": not mismatches, "mismatches": mismatches, "observed": observed})
    if any(not row["verified"] for row in receipt["results"]):
        receipt["status"] = "failed"
    atomic_write_json(output, receipt)
    return receipt


def dirty_path(status_line: str) -> str:
    path = status_line[3:].strip()
    if " -> " in path:
        path = path.split(" -> ", 1)[1]
    return path.strip('"')


def path_matches(path: str, patterns: Iterable[str]) -> bool:
    return any(path == pattern.rstrip("/") or path.startswith(pattern.rstrip("/") + "/") or fnmatch.fnmatch(path, pattern) for pattern in patterns)


def classify_dirty_tree(status: str, owned_paths: Iterable[str], baseline_paths: Iterable[str]) -> dict[str, list[str]]:
    buckets: dict[str, list[str]] = {"owned": [], "baseline": [], "unexpected": []}
    for line in status.splitlines():
        path = dirty_path(line)
        if path_matches(path, owned_paths):
            buckets["owned"].append(path)
        elif path_matches(path, baseline_paths):
            buckets["baseline"].append(path)
        else:
            buckets["unexpected"].append(path)
    return {key: sorted(set(paths)) for key, paths in buckets.items()}


def workflow_packet(run_dir: Path, task_ids: Iterable[str], e2e_tag: str | None = None, task_set_manifest: Path | None = None) -> dict[str, Any]:
    manifest_path = run_dir / "manifest.json"
    summary_path = run_dir / "summary.md"
    packet: dict[str, Any] = {"run_dir": str(run_dir), "manifest_exists": manifest_path.exists(), "summary_exists": summary_path.exists()}
    if manifest_path.exists():
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
        packet["workflow_id"] = data.get("workflow_id")
        packet["run_id"] = data.get("run_id")
        packet["steps"] = [
            {"id": s.get("id"), "status": s.get("status"), "exit_code": s.get("exit_code"), "response_path": s.get("response_path")}
            for s in data.get("steps", [])
        ]
    owned_paths: list[str] = []
    baseline_paths: list[str] = []
    kanban_wrapper = "./.juno_task/scripts/kanban.sh"
    if task_set_manifest:
        task_set = load_manifest(task_set_manifest)
        owned_paths = [str(path) for path in task_set.get("owned_paths", []) or []]
        baseline_paths = [str(path) for path in task_set.get("baseline_dirty_paths", []) or []]
        kanban_wrapper = str(task_set.get("kanban_wrapper", kanban_wrapper))
    statuses = []
    for task_id in task_ids:
        proc = run([kanban_wrapper, "-f", "json", "get", task_id])
        statuses.append({"id": task_id, "ok": proc.returncode == 0, "raw": proc.stdout if proc.returncode == 0 else proc.stderr})
    packet["kanban_tasks"] = statuses
    if e2e_tag:
        proc = run([kanban_wrapper, "search", "--tag", e2e_tag, "--format", "table", "--limit", "50"])
        packet["e2e_tag_table"] = proc.stdout if proc.returncode == 0 else proc.stderr
    status = run(["git", "status", "--short"]).stdout
    packet["git_status_short"] = status
    packet["dirty_tree"] = classify_dirty_tree(status, owned_paths, baseline_paths)
    return packet


def packet_summary(packet: dict[str, Any], output: Path | None = None) -> str:
    steps = packet.get("steps", []) or []
    failed_steps = sum(1 for step in steps if step.get("status") not in {"done", "success", "succeeded", "completed"})
    lookups = packet.get("kanban_tasks", []) or []
    failed_lookups = sum(1 for row in lookups if not row.get("ok"))
    dirty = packet.get("dirty_tree", {}) or {}
    parts = [
        f"workflow={packet.get('workflow_id') or 'unknown'}",
        f"run={packet.get('run_id') or 'unknown'}",
        f"steps={len(steps)}",
        f"failed_steps={failed_steps}",
        f"kanban_lookup_failures={failed_lookups}",
        f"owned_paths={len(dirty.get('owned', []))}",
        f"baseline_paths={len(dirty.get('baseline', []))}",
        f"unexpected_paths={len(dirty.get('unexpected', []))}",
        "human_acceptance_required=true",
    ]
    if output:
        parts.append(f"full_packet={output}")
    return " ".join(parts)


def finalize_review(run_dir: Path, manifest_path: Path) -> dict[str, Path]:
    run_dir = run_dir.resolve()
    manifest_path = manifest_path.resolve()
    if not run_dir.is_dir():
        raise FinalizeReviewError(f"run directory does not exist: {run_dir}")
    if not (run_dir / "manifest.json").is_file():
        raise FinalizeReviewError(f"run manifest does not exist: {run_dir / 'manifest.json'}")
    if not manifest_path.is_file():
        raise FinalizeReviewError(f"task-set manifest does not exist: {manifest_path}")
    try:
        manifest = load_manifest(manifest_path)
        errors = manifest_errors(manifest)
    except Exception as exc:
        raise FinalizeReviewError(f"cannot load task-set manifest: {exc}") from exc
    if errors:
        raise FinalizeReviewError("invalid task-set manifest: " + "; ".join(errors))

    task_ids = [str(task["id"]) for task in manifest["tasks"]]
    e2e_tag = str(manifest["e2e_tag"])
    doctor_cmd = ["./.juno_task/scripts/workflow_runner.sh", "doctor", "--json", str(run_dir)]
    doctor_proc = run(doctor_cmd)
    try:
        doctor = json.loads(doctor_proc.stdout)
    except Exception as exc:
        raise FinalizeReviewError(f"doctor output is not parseable JSON: {exc}") from exc
    doctor_errors = [finding for finding in doctor.get("findings", []) if finding.get("level") == "error"]
    if doctor_proc.returncode != 0 or doctor_errors:
        raise FinalizeReviewError("workflow doctor reported error findings or command failure")

    packet_output = run_dir / "final_review" / "workflow_review_packet.json"
    packet_cmd = [
        sys.executable,
        str(Path(__file__).resolve()),
        "workflow-review-packet",
        str(run_dir),
        "--tasks",
        ",".join(task_ids),
        "--e2e-tag",
        e2e_tag,
        "--manifest",
        str(manifest_path),
        "--output",
        str(packet_output),
    ]
    packet_proc = run(packet_cmd)
    try:
        packet = json.loads(packet_output.read_text(encoding="utf-8")) if packet_output.is_file() else json.loads(packet_proc.stdout)
    except Exception as exc:
        raise FinalizeReviewError(f"workflow review packet is not parseable JSON: {exc}") from exc
    if packet_proc.returncode != 0:
        raise FinalizeReviewError("workflow review packet command failed")
    failed_lookups = [row["id"] for row in packet.get("kanban_tasks", []) if not row.get("ok")]
    if failed_lookups:
        raise FinalizeReviewError(f"Kanban task lookup failed: {', '.join(failed_lookups)}")
    mutation_receipt_path: Path | None = None
    mutation_claims = manifest.get("mutation_claims", []) or []
    if mutation_claims:
        mutation_receipt_path = run_dir / "final_review" / "mutation_claim_receipt.json"
        mutation_receipt = verify_mutation_claims(
            {"claims": mutation_claims},
            mutation_receipt_path,
            str(manifest.get("kanban_wrapper", "./.juno_task/scripts/kanban.sh")),
        )
        if mutation_receipt["status"] != "verified":
            raise FinalizeReviewError(f"mutation claims failed read-after-write verification; inspect {mutation_receipt_path}")
    command_manifest = {
        "evidence_only": True,
        "human_acceptance_required": True,
        "inputs": {
            "run_dir": str(run_dir),
            "task_set_manifest": str(manifest_path),
            "task_ids": task_ids,
            "e2e_tag": e2e_tag,
        },
        "commands": [
            {"argv": doctor_cmd, "return_code": doctor_proc.returncode},
            {"argv": packet_cmd, "return_code": packet_proc.returncode},
        ],
        "mutation_claim_receipt": str(mutation_receipt_path) if mutation_receipt_path else None,
        "status": "evidence_only",
    }
    readme = """# Final workflow review evidence

**Evidence only.** These artifacts do not grant semantic acceptance.

- `evidence_only=true`
- `human_acceptance_required=true`
- `doctor.json` records workflow artifact diagnostics.
- `workflow_review_packet.json` records workflow, Kanban, E2E-isolation, and tree evidence.
- `command_manifest.json` records derived inputs and command return codes.
- `mutation_claim_receipt.json`, when declared, records read-after-write task verification.

A human reviewer must inspect the task contract, implementation, tests, and these artifacts before accepting or rejecting the work.
"""
    final_dir = run_dir / "final_review"
    artifacts = {
        "final_dir": final_dir,
        "doctor": final_dir / "doctor.json",
        "packet": final_dir / "workflow_review_packet.json",
        "command_manifest": final_dir / "command_manifest.json",
        "readme": final_dir / "README.md",
    }
    try:
        atomic_write_json(artifacts["doctor"], doctor)
        atomic_write_json(artifacts["packet"], packet)
        atomic_write_json(artifacts["command_manifest"], command_manifest)
        atomic_write_text(artifacts["readme"], readme)
    except Exception as exc:
        raise FinalizeReviewError(f"cannot write final review artifacts: {exc}") from exc
    missing = [str(path) for key, path in artifacts.items() if key != "final_dir" and not path.is_file()]
    if missing:
        raise FinalizeReviewError("missing expected final review artifacts: " + ", ".join(missing))
    return artifacts


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Validate/render Kanban task-set workflow helpers", allow_abbrev=False)
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_tags = sub.add_parser("validate-tags")
    p_tags.add_argument("--implementation-tag", required=True)
    p_tags.add_argument("--e2e-tag", required=True)
    p_body = sub.add_parser("validate-task-body")
    p_body.add_argument("paths", nargs="+")
    p_high = sub.add_parser("validate-high-compute-body")
    p_high.add_argument("paths", nargs="+")
    p_manifest = sub.add_parser("validate-manifest")
    p_manifest.add_argument("manifest")
    p_render = sub.add_parser("render-workflow")
    p_render.add_argument("--manifest", required=True)
    p_render.add_argument("--output", required=True)
    p_create = sub.add_parser("create-task-set", allow_abbrev=False, help="plan by default; --execute creates and verifies Kanban tasks")
    p_create.add_argument("manifest")
    p_create.add_argument("--output-dir", required=True)
    p_create.add_argument("--execute", action="store_true", help="explicitly authorize Kanban task creation; does not push or deploy")
    p_create.add_argument("--kanban-wrapper", default="./.juno_task/scripts/kanban.sh")
    p_claims = sub.add_parser("verify-mutation-claims", allow_abbrev=False)
    p_claims.add_argument("claims")
    p_claims.add_argument("--output", required=True)
    p_claims.add_argument("--kanban-wrapper", default="./.juno_task/scripts/kanban.sh")
    p_packet = sub.add_parser("workflow-review-packet", allow_abbrev=False)
    p_packet.add_argument("run_dir")
    p_packet.add_argument("--tasks", default="", help="comma-separated Kanban task IDs")
    p_packet.add_argument("--e2e-tag", default="")
    p_packet.add_argument("--manifest", help="task-set manifest with optional owned_paths and baseline_dirty_paths")
    p_packet.add_argument("--output", help="persist full JSON and print only a concise evidence summary")
    p_finalize = sub.add_parser("finalize-review", allow_abbrev=False)
    p_finalize.add_argument("run_dir")
    p_finalize.add_argument("--manifest", required=True)
    args = parser.parse_args(argv)

    errors: list[str] = []
    if args.cmd == "validate-tags":
        errors.extend(validate_tag(args.implementation_tag, e2e=False))
        errors.extend(validate_tag(args.e2e_tag, e2e=True))
    elif args.cmd == "validate-task-body":
        for path in args.paths:
            errors.extend(validate_body(Path(path)))
            errors.extend(validate_high_compute_body(Path(path)))
    elif args.cmd == "validate-high-compute-body":
        for path in args.paths:
            errors.extend(validate_high_compute_body(Path(path)))
    elif args.cmd == "validate-manifest":
        errors.extend(manifest_errors(load_manifest(Path(args.manifest))))
    elif args.cmd == "render-workflow":
        manifest = load_manifest(Path(args.manifest))
        errors.extend(manifest_errors(manifest))
        if not errors:
            Path(args.output).write_text(render_workflow(manifest), encoding="utf-8")
            print(f"wrote {args.output}")
    elif args.cmd == "create-task-set":
        try:
            receipt = create_task_set(Path(args.manifest), Path(args.output_dir), execute=args.execute, kanban_wrapper=args.kanban_wrapper)
        except TaskSetCreationError as exc:
            print(f"FAIL: {exc}", file=sys.stderr)
            return 1
        print(f"mode={receipt['mode']} status={receipt['status']} receipt={Path(args.output_dir).resolve() / 'receipt.json'}")
    elif args.cmd == "verify-mutation-claims":
        receipt = verify_mutation_claims(load_manifest(Path(args.claims)), Path(args.output), args.kanban_wrapper)
        print(f"status={receipt['status']} claims={len(receipt['results'])} receipt={Path(args.output).resolve()}")
        if receipt["status"] != "verified":
            return 1
    elif args.cmd == "workflow-review-packet":
        task_ids = [x.strip() for x in args.tasks.split(",") if x.strip()]
        packet = workflow_packet(
            Path(args.run_dir), task_ids, args.e2e_tag or None,
            Path(args.manifest).resolve() if args.manifest else None,
        )
        if args.output:
            output = Path(args.output).resolve()
            atomic_write_json(output, packet)
            print(packet_summary(packet, output))
        else:
            print(json.dumps(packet, indent=2))
    elif args.cmd == "finalize-review":
        try:
            artifacts = finalize_review(Path(args.run_dir), Path(args.manifest))
        except FinalizeReviewError as exc:
            print(f"FAIL: {exc}", file=sys.stderr)
            return 1
        print("evidence_only=true human_acceptance_required=true")
        for key in ("doctor", "packet", "command_manifest", "readme"):
            print(f"{key}: {artifacts[key]}")
    if errors:
        for error in errors:
            print(f"FAIL: {error}", file=sys.stderr)
        return 1
    if args.cmd not in {"create-task-set", "verify-mutation-claims", "workflow-review-packet", "finalize-review"}:
        print("OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
