#!/usr/bin/env python3
"""Run ordered YAML workflows from a project root.

The workflow file is the source of truth. Steps are arbitrary shell commands,
rendered sequentially against builtins, workflow vars, and prior step results.
Artifacts make failures visible even though failed steps do not fail the overall
process unless a step opts into fail-fast behavior.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any


JUNO_COMMANDS = {"juno-code", "yy", "ypl"}
TEMPLATE_RE = re.compile(r"{{\s*([^}]+?)\s*}}")
SAFE_ID_RE = re.compile(r"[^A-Za-z0-9_.-]+")
ANSI_RESET = "\033[0m"
STEP_COLORS = [196, 39, 208, 35, 201, 220, 27, 118, 163, 45, 214, 99]

STALE_CHECK_ENV = "JUNO_CODE_SKIP_SCRIPT_STALE_CHECK"
TEMPLATE_DIR_ENV = "JUNO_CODE_SCRIPT_TEMPLATE_DIR"
SCOPED_CONTINUITY_KEY_PREFIXES = (
    "JUNO_CODE_LAST_SESSION_ID_SCOPE_",
    "JUNO_CODE_LAST_EXECUTION_SETTINGS_SCOPE_",
)
LEGACY_CONTINUITY_KEYS = {
    "JUNO_CODE_LAST_SESSION_ID",
    "JUNO_CODE_LAST_EXECUTION_SETTINGS",
}


def child_process_environment(base: dict[str, str]) -> dict[str, str]:
    """Preserve child config/routing while dropping historical continuity values."""
    return {
        name: value
        for name, value in base.items()
        if name not in LEGACY_CONTINUITY_KEYS and not name.startswith(SCOPED_CONTINUITY_KEY_PREFIXES)
    }


def sanitize_current_process_environment() -> None:
    environment = child_process_environment(dict(os.environ))
    os.environ.clear()
    os.environ.update(environment)


def ensure_controller_python_environment(controller_env: dict[str, str]) -> None:
    """Run under the controller's .venv_juno, matching the Kanban launcher contract."""
    root = Path(controller_env["JUNO_TASK_ROOT"]).resolve()
    venv = root / ".venv_juno"
    python = venv / "bin" / "python"
    if not python.is_file():
        installer = root / ".juno_task" / "scripts" / "install_requirements.sh"
        if not installer.is_file():
            raise WorkflowError(
                f"controller Python environment is missing ({python}) and installer was not found ({installer})"
            )
        completed = subprocess.run(
            ["bash", str(installer)], cwd=root, stdin=subprocess.DEVNULL, check=False
        )
        if completed.returncode != 0 or not python.is_file():
            raise WorkflowError(f"failed to create controller Python environment: {venv}")

    env = dict(os.environ)
    env.update(controller_env)
    env["VIRTUAL_ENV"] = str(venv)
    env["PATH"] = os.pathsep.join(
        [str(venv / "bin"), *[part for part in env.get("PATH", "").split(os.pathsep) if part != str(venv / "bin")]]
    )
    env.pop("PYTHONHOME", None)
    os.environ.clear()
    os.environ.update(env)

    try:
        already_selected = Path(sys.executable).resolve() == python.resolve()
    except OSError:
        already_selected = False
    if os.environ.get("JUNO_DEBUG", "false") == "true":
        print(f"[DEBUG] workflow_runner.sh Python runtime: {python}", file=sys.stderr)
    if not already_selected:
        os.execve(str(python), [str(python), str(Path(__file__).resolve()), *sys.argv[1:]], env)


def _display_path(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(Path.cwd().resolve()))
    except ValueError:
        return str(path)


def _is_package_template_path(path: Path) -> bool:
    parts = path.parts
    template_suffixes = (("dist", "templates", "scripts"), ("src", "templates", "scripts"))
    for suffix in template_suffixes:
        suffix_len = len(suffix)
        if len(parts) >= suffix_len + 1 and tuple(parts[-suffix_len - 1 : -1]) == suffix:
            return True
    return False


def _installed_template_candidates(script_name: str) -> list[Path]:
    candidates: list[Path] = []
    env_template_dir = os.environ.get(TEMPLATE_DIR_ENV)
    if env_template_dir:
        candidates.append(Path(env_template_dir).expanduser() / script_name)

    for command_name in ("yy", "juno-code", "ypl"):
        command_path = shutil.which(command_name)
        if not command_path:
            continue
        try:
            resolved = Path(command_path).resolve()
        except OSError:
            resolved = Path(command_path)
        for parent in (resolved.parent, *resolved.parents):
            candidates.append(parent / "dist" / "templates" / "scripts" / script_name)
            candidates.append(parent / "templates" / "scripts" / script_name)

    seen: set[str] = set()
    unique: list[Path] = []
    for candidate in candidates:
        key = str(candidate)
        if key not in seen:
            seen.add(key)
            unique.append(candidate)
    return unique


def warn_if_runtime_script_is_stale(script_name: str) -> None:
    if os.environ.get(STALE_CHECK_ENV) == "1":
        return
    try:
        runtime_path = Path(__file__).resolve()
        if not os.environ.get(TEMPLATE_DIR_ENV) and _is_package_template_path(runtime_path):
            return
        runtime_hash = hashlib.sha256(runtime_path.read_bytes()).hexdigest()
        for template_path in _installed_template_candidates(script_name):
            try:
                installed_path = template_path.resolve()
            except OSError:
                installed_path = template_path
            if installed_path == runtime_path or not template_path.is_file():
                continue
            installed_hash = hashlib.sha256(template_path.read_bytes()).hexdigest()
            if runtime_hash != installed_hash:
                print(
                    f"{script_name}: warning: this runtime script differs from the installed juno-code template.\n"
                    f"  runtime: {_display_path(runtime_path)}\n"
                    f"  installed template: {installed_path}\n"
                    "  update with: yy scripts update --force",
                    file=sys.stderr,
                )
            return
    except Exception:
        return


class WorkflowError(Exception):
    pass


RUN_CONTRACT_SCHEMA = "juno_workflow_run_contract.v1"


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def canonical_sha256(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return sha256_bytes(encoded)


def file_sha256(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def dotted_get(value: Any, field: str) -> tuple[bool, Any]:
    current = value
    for part in field.split("."):
        if isinstance(current, dict) and part in current:
            current = current[part]
        else:
            return False, None
    return True, current


def normalize_receipt_contracts(workflow: dict[str, Any]) -> dict[str, dict[str, Any]]:
    raw = workflow.get("receipts") or []
    if isinstance(raw, dict):
        items = [{"id": key, **(value if isinstance(value, dict) else {})} for key, value in raw.items()]
    elif isinstance(raw, list):
        items = raw
    else:
        raise WorkflowError("receipts must be a list or mapping")
    contracts: dict[str, dict[str, Any]] = {}
    for item in items:
        if not isinstance(item, dict):
            raise WorkflowError("each receipt contract must be a mapping")
        receipt_id = str(item.get("id") or "").strip()
        if not receipt_id or not re.match(r"^[a-z][a-z0-9_]*$", receipt_id):
            raise WorkflowError(
                f"invalid receipt id: {receipt_id!r}; use lowercase letters, numbers, and underscores, "
                "starting with a letter, so template and environment lookups remain unambiguous"
            )
        if receipt_id in contracts:
            raise WorkflowError(f"duplicate receipt id: {receipt_id}")
        producer = str(item.get("producer") or "").strip()
        path = str(item.get("path") or "").strip()
        schema_version = str(item.get("schema_version") or "").strip()
        required_fields = item.get("required_fields") or []
        expected_fields = item.get("expected_fields") or {}
        if not producer or not path or not schema_version:
            raise WorkflowError(f"receipt {receipt_id} requires producer, path, and schema_version")
        if not isinstance(required_fields, list) or not all(isinstance(field, str) and field for field in required_fields):
            raise WorkflowError(f"receipt {receipt_id} required_fields must be a list of dotted field names")
        if "producer_step_digest" not in required_fields:
            raise WorkflowError(
                f"receipt {receipt_id} required_fields must include producer_step_digest so lint and runtime bind the same producer"
            )
        if not isinstance(expected_fields, dict) or not all(
            isinstance(field, str) and field for field in expected_fields
        ):
            raise WorkflowError(f"receipt {receipt_id} expected_fields must be a mapping of dotted fields to values")
        contracts[receipt_id] = {
            "id": receipt_id,
            "producer": producer,
            "path": path,
            "schema_version": schema_version,
            "required_fields": required_fields,
            "expected_fields": expected_fields,
        }
    return contracts


def validate_receipt_payload(
    contract: dict[str, Any], payload: Any, producer_step_digest: str, *, location: str
) -> None:
    receipt_id = contract["id"]
    if not isinstance(payload, dict):
        raise WorkflowError(f"receipt[{receipt_id}] {location}: expected JSON object")
    actual_schema = payload.get("schema_version")
    if actual_schema != contract["schema_version"]:
        raise WorkflowError(
            f"receipt[{receipt_id}].schema_version: expected={contract['schema_version']!r} actual={actual_schema!r}"
        )
    actual_digest = payload.get("producer_step_digest")
    if actual_digest != producer_step_digest:
        raise WorkflowError(
            f"receipt[{receipt_id}].producer_step_digest: expected={producer_step_digest!r} actual={actual_digest!r}"
        )
    for field in contract["required_fields"]:
        present, _ = dotted_get(payload, field)
        if not present:
            raise WorkflowError(f"receipt[{receipt_id}].required_field[{field}]: missing at {location}")
    for field, expected in contract.get("expected_fields", {}).items():
        present, actual = dotted_get(payload, field)
        if not present:
            raise WorkflowError(f"receipt[{receipt_id}].expected_field[{field}]: missing at {location}")
        if actual != expected:
            raise WorkflowError(
                f"receipt[{receipt_id}].expected_field[{field}]: expected={expected!r} actual={actual!r}"
            )


def load_json_object(path: Path, description: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise WorkflowError(f"{description} not found: {path}") from exc
    except Exception as exc:
        raise WorkflowError(f"invalid {description} at {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise WorkflowError(f"{description} must be a JSON object: {path}")
    return value


def color_enabled() -> bool:
    return sys.stdout.isatty() and os.environ.get("NO_COLOR") is None


def step_color(index: int) -> str:
    return f"\033[38;5;{STEP_COLORS[(index - 1) % len(STEP_COLORS)]}m"


def colorize(text: str, index: int) -> str:
    if not color_enabled():
        return text
    return f"{step_color(index)}{text}{ANSI_RESET}"


def step_separator(label: str, index: int, step_id: str, details: str = "") -> str:
    suffix = f" {details}" if details else ""
    return colorize(f"{'=' * 18} {label}: step {index} [{step_id}]{suffix} {'=' * 18}", index)


def parse_scalar(value: str) -> Any:
    value = value.strip()
    if value == "":
        return ""
    if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
        return value[1:-1]
    lowered = value.lower()
    if lowered in {"true", "yes", "on"}:
        return True
    if lowered in {"false", "no", "off"}:
        return False
    if lowered in {"null", "none", "~"}:
        return None
    try:
        return int(value)
    except ValueError:
        pass
    try:
        return float(value)
    except ValueError:
        return value


def count_indent(line: str) -> int:
    return len(line) - len(line.lstrip(" "))


def read_literal_block(lines: list[str], start: int, parent_indent: int) -> tuple[str, int]:
    i = start
    block_lines: list[str] = []
    block_indent: int | None = None
    while i < len(lines):
        line = lines[i]
        if not line.strip():
            block_lines.append("")
            i += 1
            continue
        indent = count_indent(line)
        if indent <= parent_indent:
            break
        if block_indent is None:
            block_indent = indent
        block_lines.append(line[min(block_indent, len(line)) :])
        i += 1
    return "\n".join(block_lines).rstrip("\n"), i


def read_scalar_list(lines: list[str], start: int, parent_indent: int) -> tuple[list[Any], int]:
    values: list[Any] = []
    i = start
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            i += 1
            continue
        indent = count_indent(line)
        if indent <= parent_indent:
            break
        if not stripped.startswith("-"):
            raise WorkflowError(f"expected scalar list item near line {i + 1}: {line}")
        item = stripped[1:].strip()
        if item == "|":
            literal, i = read_literal_block(lines, i + 1, indent)
            values.append(literal)
            continue
        values.append(parse_scalar(item))
        i += 1
    return values, i


def parse_yaml_like(text: str) -> dict[str, Any]:
    """Parse workflow YAML without making PyYAML a hard runtime dependency.

    JSON is accepted. When PyYAML is installed, it is used for full YAML support.
    The fallback supports the documented workflow shape: root scalars/mappings,
    literal blocks, and a list of step mappings.
    """
    try:
        loaded = json.loads(text)
        if isinstance(loaded, dict):
            return loaded
    except json.JSONDecodeError:
        pass

    try:
        import yaml  # type: ignore

        loaded = yaml.safe_load(text)
        if not isinstance(loaded, dict):
            raise WorkflowError("workflow must be a YAML mapping")
        return loaded
    except ImportError:
        pass
    except Exception as exc:  # pragma: no cover - exact PyYAML error varies
        raise WorkflowError(f"failed to parse workflow YAML: {exc}") from exc

    advanced_yaml_keys = sorted(
        set(
            re.findall(
                r"(?m)^(?:receipts|frozen_inputs|validation_ownership):\s*(?:#.*)?$",
                text,
            )
        )
    )
    if advanced_yaml_keys:
        raise WorkflowError(
            "advanced workflow contracts require Python PyYAML or JSON input; "
            "install PyYAML in the runner environment or encode the workflow as JSON"
        )

    lines = text.splitlines()
    root: dict[str, Any] = {}
    i = 0
    while i < len(lines):
        raw = lines[i]
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            i += 1
            continue
        if count_indent(raw) != 0 or ":" not in stripped:
            raise WorkflowError(f"unsupported YAML near line {i + 1}: {raw}")
        key, value = stripped.split(":", 1)
        key = key.strip()
        value = value.strip()
        if value == "|":
            root[key], i = read_literal_block(lines, i + 1, count_indent(raw))
            continue
        if value:
            root[key] = parse_scalar(value)
            i += 1
            continue

        i += 1
        if key == "steps":
            steps: list[dict[str, Any]] = []
            while i < len(lines):
                line = lines[i]
                stripped_line = line.strip()
                if not stripped_line or stripped_line.startswith("#"):
                    i += 1
                    continue
                indent = count_indent(line)
                if indent == 0:
                    break
                if not stripped_line.startswith("-"):
                    raise WorkflowError(f"expected step list item near line {i + 1}: {line}")
                item: dict[str, Any] = {}
                rest = stripped_line[1:].strip()
                if rest:
                    if ":" not in rest:
                        raise WorkflowError(f"expected key/value after '-' near line {i + 1}")
                    k, v = rest.split(":", 1)
                    item[k.strip()] = parse_scalar(v.strip())
                i += 1
                while i < len(lines):
                    child = lines[i]
                    child_stripped = child.strip()
                    child_indent = count_indent(child)
                    if not child_stripped or child_stripped.startswith("#"):
                        i += 1
                        continue
                    if child_indent <= indent:
                        break
                    if ":" not in child_stripped:
                        raise WorkflowError(f"expected step field near line {i + 1}: {child}")
                    k, v = child_stripped.split(":", 1)
                    k = k.strip()
                    v = v.strip()
                    if v == "|":
                        item[k], i = read_literal_block(lines, i + 1, child_indent)
                        continue
                    if v == "" and k == "command":
                        item[k], i = read_scalar_list(lines, i + 1, child_indent)
                        continue
                    item[k] = parse_scalar(v)
                    i += 1
                steps.append(item)
            root[key] = steps
            continue

        nested: dict[str, Any] = {}
        while i < len(lines):
            line = lines[i]
            stripped_line = line.strip()
            if not stripped_line or stripped_line.startswith("#"):
                i += 1
                continue
            indent = count_indent(line)
            if indent == 0:
                break
            if ":" not in stripped_line:
                raise WorkflowError(f"expected mapping field near line {i + 1}: {line}")
            k, v = stripped_line.split(":", 1)
            k = k.strip()
            v = v.strip()
            if v == "|":
                nested[k], i = read_literal_block(lines, i + 1, indent)
                continue
            if v == "" and k == "command":
                nested[k], i = read_scalar_list(lines, i + 1, indent)
                continue
            nested[k] = parse_scalar(v)
            i += 1
        root[key] = nested
    return root


def get_path(context: dict[str, Any], expr: str) -> Any:
    current: Any = context
    for part in expr.split("."):
        part = part.strip()
        if part == "":
            continue
        if isinstance(current, dict) and part in current:
            current = current[part]
        else:
            return ""
    return current


def render(value: Any, context: dict[str, Any]) -> Any:
    if isinstance(value, list):
        return [render(item, context) for item in value]
    if isinstance(value, dict):
        return {key: render(item, context) for key, item in value.items()}
    if not isinstance(value, str):
        return value

    def repl(match: re.Match[str]) -> str:
        resolved = get_path(context, match.group(1))
        if resolved is None:
            return ""
        if isinstance(resolved, (dict, list)):
            return json.dumps(resolved, ensure_ascii=False)
        return str(resolved)

    return TEMPLATE_RE.sub(repl, value)


def safe_id(value: Any, fallback: str) -> str:
    text = str(value or fallback).strip() or fallback
    text = SAFE_ID_RE.sub("-", text).strip("-._")
    return text or fallback


def validate_workflow(workflow: dict[str, Any]) -> None:
    workflow_schema = str(workflow.get("schema_version") or "").strip()
    if workflow_schema and workflow_schema not in {"1", "1.0", "v1", "2", "2.0", "v2"}:
        raise WorkflowError(f"unsupported schema_version: {workflow['schema_version']}")
    steps = workflow.get("steps")
    if not isinstance(steps, list) or not steps:
        raise WorkflowError("workflow must define a non-empty steps list")
    if "summary" in workflow and not isinstance(workflow["summary"], (str, dict, type(None))):
        raise WorkflowError("summary must be a string, mapping, or null")
    continue_from_step = str(workflow.get("continue_from_step") or "").strip()
    seen: set[str] = set()
    step_names: set[str] = set()
    step_indexes: dict[str, int] = {}
    for idx, step in enumerate(steps, start=1):
        if not isinstance(step, dict):
            raise WorkflowError(f"step {idx} must be a mapping")
        step_id = str(step.get("id") or "").strip()
        if not step_id:
            raise WorkflowError(f"step {idx} is missing required id")
        if not re.match(r"^[A-Za-z0-9_.-]+$", step_id):
            raise WorkflowError(f"step id contains unsupported characters: {step_id}")
        if step_id in seen:
            raise WorkflowError(f"duplicate step id: {step_id}")
        seen.add(step_id)
        step_indexes[step_id] = idx
        step_name = str(step.get("name") or "").strip()
        if step_name:
            step_names.add(step_name)
        if "command" not in step:
            raise WorkflowError(f"step {step_id} is missing required command")
        requires_receipts = step.get("requires_receipts") or []
        if not isinstance(requires_receipts, list) or not all(isinstance(item, str) for item in requires_receipts):
            raise WorkflowError(f"step {step_id} requires_receipts must be a list of receipt ids")
        expected_outcomes = step.get("expected_outcomes")
        if expected_outcomes is not None and (
            not isinstance(expected_outcomes, list)
            or not expected_outcomes
            or not all(isinstance(item, str) and item for item in expected_outcomes)
        ):
            raise WorkflowError(f"step {step_id} expected_outcomes must be a non-empty string list")
    summary = workflow.get("summary")
    summary_has_command = isinstance(summary, dict) and "command" in summary
    if continue_from_step and continue_from_step != "summary" and continue_from_step not in seen and continue_from_step not in step_names:
        raise WorkflowError(f"continue_from_step references unknown step: {continue_from_step}")
    if continue_from_step == "summary" and not summary_has_command:
        raise WorkflowError("continue_from_step references summary, but summary.command is not configured")

    receipts = normalize_receipt_contracts(workflow)
    for receipt_id, contract in receipts.items():
        producer = contract["producer"]
        if producer not in step_indexes:
            raise WorkflowError(f"receipt {receipt_id} references unknown producer step: {producer}")
    for step in steps:
        step_id = str(step["id"])
        for receipt_id in step.get("requires_receipts") or []:
            if receipt_id not in receipts:
                raise WorkflowError(f"step {step_id} requires unknown receipt: {receipt_id}")
            producer = receipts[receipt_id]["producer"]
            if step_indexes[producer] >= step_indexes[step_id]:
                raise WorkflowError(f"step {step_id} requires receipt {receipt_id} before its producer {producer}")

    terminal_gate = str(workflow.get("terminal_gate") or "").strip()
    if terminal_gate and terminal_gate not in step_indexes:
        raise WorkflowError(f"terminal_gate references unknown step: {terminal_gate}")
    validation_ownership = workflow.get("validation_ownership")
    if validation_ownership is not None and not isinstance(validation_ownership, dict):
        raise WorkflowError("validation_ownership must be a mapping")
    if str(workflow.get("workflow_class") or "").strip() == "local_integration":
        if workflow_schema not in {"2", "2.0", "v2"}:
            raise WorkflowError(
                "local_integration requires schema_version: 2; migration required for pre-2.0.14 workflow contracts"
            )
        risk_tier = str(workflow.get("risk_tier") or "").strip()
        if risk_tier not in {"low", "medium", "high", "release"}:
            raise WorkflowError("local_integration requires exactly one risk_tier: low, medium, high, or release")
        required_roles = {"pre_merge_review", "candidate_review", "actual_target_review"}
        missing_roles = sorted(required_roles - set(validation_ownership or {}))
        if missing_roles:
            raise WorkflowError(f"local_integration validation_ownership missing roles: {', '.join(missing_roles)}")
        policy = workflow.get("integration_policy")
        allowed_policy = {
            "queue": "automatic_after_review_pass",
            "channel_scope": "git_common_dir_and_target_ref",
            "target_movement": "rebuild_and_rereview",
            "checked_out_target": "detach_same_sha",
        }
        if policy != allowed_policy:
            raise WorkflowError(
                "local_integration integration_policy must exactly select automatic_after_review_pass, "
                "git_common_dir_and_target_ref, rebuild_and_rereview, and detach_same_sha"
            )
        if not terminal_gate:
            raise WorkflowError("local_integration workflow requires terminal_gate")
        integration_step = str(workflow.get("integration_step") or "").strip()
        if integration_step not in step_indexes:
            raise WorkflowError("local_integration workflow requires a valid integration_step")
        integration_command_text = json.dumps(
            next(step["command"] for step in steps if step["id"] == integration_step), ensure_ascii=False
        )
        required_integration_tokens = (
            "integration_owner_preflight.py integrate",
            "--candidate-receipt",
            "--risk-tier",
            "--checked-out-target detach_same_sha",
        )
        if any(token not in integration_command_text for token in required_integration_tokens):
            raise WorkflowError(
                f"local_integration integration_step {integration_step} must drain an eligible candidate through "
                "target-ref CAS and actual-target review"
            )
        review_steps = [str(validation_ownership["pre_merge_review"]), str(validation_ownership["candidate_review"])]
        if any(step_indexes[step] >= step_indexes[integration_step] for step in review_steps):
            raise WorkflowError("pre_merge_review and candidate_review must precede integration_step")
        if str(validation_ownership["actual_target_review"]) != integration_step:
            raise WorkflowError("actual_target_review must be executed and receipt-gated by integration_step")
        integration_receipts = [
            contract for contract in receipts.values()
            if contract["producer"] == integration_step
            and contract["expected_fields"].get("outcome") == "integrated"
            and "feature_tag_policy" in contract["required_fields"]
        ]
        if not integration_receipts:
            raise WorkflowError("integration_step must produce a typed integrated receipt requiring feature_tag_policy")
        if step_indexes[terminal_gate] < step_indexes[integration_step]:
            raise WorkflowError("terminal_gate must not precede integration_step")
    for role, step_id_value in (validation_ownership or {}).items():
        if str(step_id_value) not in step_indexes:
            raise WorkflowError(f"validation_ownership.{role} references unknown step: {step_id_value}")

    frozen_inputs = workflow.get("frozen_inputs") or []
    if not isinstance(frozen_inputs, list):
        raise WorkflowError("frozen_inputs must be a list")
    frozen_ids: set[str] = set()
    for item in frozen_inputs:
        if not isinstance(item, dict):
            raise WorkflowError("each frozen_inputs entry must be a mapping")
        input_id = str(item.get("id") or "").strip()
        path = str(item.get("path") or "").strip()
        if not input_id or not path:
            raise WorkflowError("each frozen_inputs entry requires id and path")
        if input_id in frozen_ids:
            raise WorkflowError(f"duplicate frozen input id: {input_id}")
        frozen_ids.add(input_id)


def workflow_to_yaml(data: Any, indent: int = 0) -> str:
    pad = " " * indent
    if isinstance(data, dict):
        lines: list[str] = []
        for key, value in data.items():
            if isinstance(value, (dict, list)):
                lines.append(f"{pad}{key}:")
                nested = workflow_to_yaml(value, indent + 2)
                if nested:
                    lines.append(nested)
            else:
                lines.append(f"{pad}{key}: {json.dumps(value) if isinstance(value, str) else value}")
        return "\n".join(lines)
    if isinstance(data, list):
        lines = []
        for item in data:
            if isinstance(item, dict):
                item_lines = workflow_to_yaml(item, indent + 2).splitlines()
                if item_lines:
                    lines.append(f"{pad}- {item_lines[0].lstrip()}")
                    lines.extend(item_lines[1:])
                else:
                    lines.append(f"{pad}- {{}}")
            else:
                lines.append(f"{pad}- {item}")
        return "\n".join(lines)
    return f"{pad}{data}"


def command_argv(command: Any) -> list[str]:
    if isinstance(command, list):
        return [str(part) for part in command]
    if not isinstance(command, str):
        return [str(command)]
    try:
        return shlex.split(command, posix=True)
    except ValueError:
        return command.strip().split()


def command_preview(command: Any) -> str:
    if isinstance(command, list):
        return " ".join(shlex.quote(str(part)) for part in command)
    return str(command)


def detect_juno_command(command: Any) -> bool:
    parts = command_argv(command)
    if not parts:
        return False
    executable = Path(parts[0]).name
    return executable in JUNO_COMMANDS


def juno_command_name(command: Any) -> str | None:
    parts = command_argv(command)
    if not parts:
        return None
    executable = Path(parts[0]).name
    return executable if executable in JUNO_COMMANDS else None


def juno_subagent_name(command: Any) -> str | None:
    parts = command_argv(command)
    if not parts:
        return None
    executable = Path(parts[0]).name
    if executable == "ypl":
        return "pi"
    if executable not in {"juno-code", "yy"}:
        return None
    idx = 1
    while idx < len(parts):
        part = parts[idx]
        if part in {"--quiet", "--silent", "-q", "--verbose", "-v", "--live"}:
            idx += 1
            if part in {"--verbose", "-v"} and idx < len(parts) and not parts[idx].startswith("-"):
                idx += 1
            continue
        if part.startswith("--verbose="):
            idx += 1
            continue
        if part in {"-s", "--subagent"}:
            return parts[idx + 1] if idx + 1 < len(parts) and parts[idx + 1] else None
        if part in {"-b", "--backend", "-m", "--model", "-c", "--config", "-l", "--log-file"}:
            idx += 2
            continue
        if part.startswith("--subagent="):
            return part.split("=", 1)[1] or None
        return part if part in {"pi", "claude", "codex", "gemini", "cursor"} else None
    return None


def extract_model_from_command(command: Any) -> str | None:
    parts = command_argv(command)
    for idx, part in enumerate(parts):
        if part in {"-m", "--model"} and idx + 1 < len(parts):
            return parts[idx + 1]
        if part.startswith("--model="):
            return part.split("=", 1)[1]
    return None


def resolve_continue_scope_from_juno(
    project_root: Path,
    parent_pid: int,
    command: Any,
) -> dict[str, str]:
    """Ask the selected Juno executable for its TypeScript-owned scope identity."""
    parts = command_argv(command)
    executable = parts[0] if parts and Path(parts[0]).name in {"yy", "juno-code"} else None
    if not executable:
        # ypl is a prompt shortcut (`juno-code pi --live`), not a control-command API.
        executable = next((path for name in ("yy", "juno-code") if (path := shutil.which(name))), None)
    if not executable:
        raise WorkflowError("cannot resolve continue scope: yy or juno-code was not found")

    completed = subprocess.run(
        [
            executable,
            "continue-scope",
            "--json",
            "--cwd",
            str(project_root),
            "--parent-pid",
            str(parent_pid),
        ],
        cwd=project_root,
        env=child_process_environment(dict(os.environ)),
        stdin=subprocess.DEVNULL,
        text=True,
        capture_output=True,
        timeout=30,
        check=False,
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "unknown error").strip()
        raise WorkflowError(f"juno-code continue-scope failed: {detail}")
    try:
        payload = json.loads(completed.stdout)
    except Exception as error:
        raise WorkflowError("juno-code continue-scope returned invalid JSON") from error

    scope_hash = str(payload.get("fullHash") or "") if isinstance(payload, dict) else ""
    session_key = str(payload.get("sessionEnvKey") or "") if isinstance(payload, dict) else ""
    settings_key = str(payload.get("settingsEnvKey") or "") if isinstance(payload, dict) else ""
    if not re.fullmatch(r"SCOPE_[A-F0-9]{16}", scope_hash):
        raise WorkflowError("juno-code continue-scope returned an invalid fullHash")
    if not re.fullmatch(r"JUNO_CODE_LAST_SESSION_ID_SCOPE_[A-F0-9]{16}", session_key):
        raise WorkflowError("juno-code continue-scope returned an invalid sessionEnvKey")
    if not re.fullmatch(r"JUNO_CODE_LAST_EXECUTION_SETTINGS_SCOPE_[A-F0-9]{16}", settings_key):
        raise WorkflowError("juno-code continue-scope returned an invalid settingsEnvKey")
    return {
        "scope_hash": scope_hash,
        "session_env_key": session_key,
        "settings_env_key": settings_key,
        "session_id": str(payload.get("sessionId") or ""),
        "executable": executable,
    }


def build_continue_settings(command: Any) -> dict[str, Any] | None:
    subagent = juno_subagent_name(command)
    if not subagent:
        return None
    settings: dict[str, Any] = {"version": 1, "subagent": subagent}
    model = extract_model_from_command(command)
    if model:
        settings["model"] = model
    return settings


def read_child_continue_session(project_root: Path, command: Any) -> str | None:
    # Top-level yy/juno-code commands persist their own continue snapshot, but when
    # launched by this runner without terminal markers their PPID fallback is the
    # workflow_runner process. Adopt that child snapshot, then persist it to the
    # caller's shell scope so `workflow_runner.sh ... ; yy cc` works.
    child_context = resolve_continue_scope_from_juno(project_root, os.getpid(), command)
    return child_context["session_id"] or None


def persist_continue_context(project_root: Path, session_id: str, command: Any) -> dict[str, str] | None:
    settings = build_continue_settings(command)
    if not settings:
        return None
    context = resolve_continue_scope_from_juno(project_root, os.getppid(), command)
    serialized_settings = json.dumps(settings, separators=(",", ":"))
    completed = subprocess.run(
        [
            context["executable"], "continue-scope", "--json", "--cwd", str(project_root),
            "--parent-pid", str(os.getppid()), "--handoff-session", session_id,
            "--handoff-settings", serialized_settings,
        ],
        cwd=project_root,
        env=child_process_environment(dict(os.environ)),
        stdin=subprocess.DEVNULL,
        text=True,
        capture_output=True,
        timeout=30,
        check=False,
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "unknown error").strip()
        raise WorkflowError(f"juno-code continuity handoff failed: {detail}")
    return {**context, "metadata_file": "session_continuity.v2.json", "settings": serialized_settings}


def select_continue_step(workflow: dict[str, Any], session_candidates: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Choose the yy cc handoff from executed Juno invocations in workflow order.

    Without an explicit override, the last successful candidate that captured a
    session_id wins. With continue_from_step, the named step/summary must exist
    in the candidate stream and must have produced a session_id.
    """
    selected = str(workflow.get("continue_from_step") or "").strip()
    if not selected:
        for item in reversed(session_candidates):
            if item.get("status") == "success" and str(item.get("session_id") or "").strip():
                return item
        return None
    for item in session_candidates:
        if item.get("id") == selected or item.get("name") == selected:
            if str(item.get("session_id") or "").strip():
                return item
            raise WorkflowError(f"continue_from_step '{selected}' selected {session_label(item)}, but it did not produce a session_id")
    raise WorkflowError(f"continue_from_step '{selected}' did not match an executed Juno invocation with a session_id")


def session_label(item: dict[str, Any]) -> str:
    if item.get("kind") == "summary":
        return "summary [summary]"
    return f"step {item['index']} [{item['id']}]"


def print_session_summary(session_steps: list[dict[str, Any]], persisted: dict[str, str] | None) -> None:
    if not session_steps:
        return
    print("\nSession ID(s):")
    for item in session_steps:
        print(f"  {session_label(item)}: {item['session_id']}")
    if persisted:
        selected_label = persisted.get("selected_label")
        if selected_label:
            print(f"  handoff: {selected_label} persisted for yy cc ({persisted['scope_hash']})")
        else:
            print(f"  handoff: last session persisted for yy cc ({persisted['scope_hash']})")
        print(f"  metadata_file: {persisted['metadata_file']}")


SESSION_FOOTER_TOKEN_RE = re.compile(
    r"\b(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|session-[A-Za-z0-9_.:-]+)\b"
)


def extract_footer_session_id(text: str) -> str | None:
    lines = text.splitlines()
    for index, line in enumerate(lines):
        if not re.search(r"\bsession\s+id\(s\)\s*:\s*$", line.strip(), re.I):
            continue
        for candidate_line in lines[index + 1 :]:
            stripped = candidate_line.strip()
            if not stripped:
                break
            match = SESSION_FOOTER_TOKEN_RE.search(stripped)
            if match:
                return match.group(0)
    return None


def extract_session_id(stdout: str, stderr: str) -> str | None:
    for text in (stdout, stderr):
        for line in text.splitlines():
            stripped = line.strip()
            if not stripped:
                continue
            try:
                payload = json.loads(stripped)
            except json.JSONDecodeError:
                payload = None
            if isinstance(payload, dict):
                for key in ("session_id", "sessionId", "session"):
                    val = payload.get(key)
                    if isinstance(val, str) and val:
                        return val
            match = re.search(r"session[_ -]?id[=:]\s*([A-Za-z0-9_.:-]+)", stripped, re.I)
            if match:
                return match.group(1)
        footer_session_id = extract_footer_session_id(text)
        if footer_session_id:
            return footer_session_id
    return None


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def parse_vars(values: list[str]) -> dict[str, str]:
    parsed: dict[str, str] = {}
    for item in values:
        if "=" not in item:
            raise WorkflowError(f"--var must use key=value form: {item}")
        key, value = item.split("=", 1)
        key = key.strip()
        if not key:
            raise WorkflowError("--var key cannot be empty")
        parsed[key] = value
    return parsed


def step_should_fail_process(step: dict[str, Any]) -> bool:
    for key in ("fail_workflow", "fail_on_error", "exit_on_failure", "fail_fast"):
        if bool(step.get(key, False)):
            return True
    return False


def step_capture_enabled(step: dict[str, Any], command: Any) -> bool:
    if "capture_session" in step and not bool(step.get("capture_session")):
        return False
    if "capture" in step and not bool(step.get("capture")):
        return False
    if "capture_session" in step:
        return bool(step.get("capture_session"))
    if "capture" in step:
        return bool(step.get("capture"))
    return detect_juno_command(command)


def read_capture_payload(capture_path: Path) -> tuple[dict[str, Any] | None, str | None]:
    if not capture_path.exists():
        return None, None
    try:
        payload = json.loads(capture_path.read_text(encoding="utf-8"))
    except Exception as exc:
        return None, f"invalid capture JSON at {capture_path}: {exc}"
    if not isinstance(payload, dict):
        return None, f"capture JSON at {capture_path} must be an object"
    return payload, None


def make_summary(workflow: dict[str, Any], context: dict[str, Any], failed_steps: list[str], dry_run: bool) -> str:
    explicit = workflow.get("summary")
    if isinstance(explicit, str) and explicit.strip():
        rendered = render(explicit, context)
        return str(rendered).rstrip() + "\n"
    if isinstance(explicit, dict) and explicit.get("template"):
        rendered = render(str(explicit["template"]), context)
        return str(rendered).rstrip() + "\n"
    lines = ["# Workflow Summary", ""]
    lines.append(f"Workflow: {context.get('workflow_id', workflow.get('name', 'unnamed'))}")
    lines.append(f"Run ID: {context.get('run_id')}")
    lines.append(f"Mode: {'dry-run' if dry_run else 'execute'}")
    lines.append(f"Failed steps: {len(failed_steps)}")
    lines.append("")
    lines.append("| Step | Status | Exit | Duration (s) |")
    lines.append("| --- | --- | ---: | ---: |")
    for step_id, result in context["steps"].items():
        lines.append(
            f"| {step_id} | {result.get('status')} | {result.get('exit_code')} | {result.get('duration_seconds')} |"
        )
    lines.append("")
    return "\n".join(lines)


def append_live_log(path: Path | None, text: str) -> None:
    if path is None:
        return
    with path.open("a", encoding="utf-8") as handle:
        handle.write(text)
        handle.flush()


def execute_rendered_command(
    command: Any,
    project_root: Path,
    env: dict[str, str],
    live_log_path: Path | None = None,
) -> subprocess.CompletedProcess[str]:
    argv: Any = [str(part) for part in command] if isinstance(command, list) else str(command)
    shell = not isinstance(command, list)
    if live_log_path is None:
        return subprocess.run(
            argv,
            shell=shell,
            cwd=str(project_root),
            text=True,
            capture_output=True,
            env=env,
        )

    proc = subprocess.Popen(
        argv,
        shell=shell,
        cwd=str(project_root),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        bufsize=1,
    )
    stdout_chunks: list[str] = []
    stderr_chunks: list[str] = []
    log_lock = threading.Lock()

    def relay(stream: Any, label: str, chunks: list[str]) -> None:
        if stream is None:
            return
        for chunk in iter(stream.readline, ""):
            chunks.append(chunk)
            with log_lock:
                append_live_log(live_log_path, f"[{label}] {chunk}")
        stream.close()

    threads = [
        threading.Thread(target=relay, args=(proc.stdout, "stdout", stdout_chunks), daemon=True),
        threading.Thread(target=relay, args=(proc.stderr, "stderr", stderr_chunks), daemon=True),
    ]
    for thread in threads:
        thread.start()
    return_code = proc.wait()
    for thread in threads:
        thread.join()
    return subprocess.CompletedProcess(argv, return_code, "".join(stdout_chunks), "".join(stderr_chunks))


def start_tmux_observer(out_dir: Path, workflow_id: str, run_id: str, requested_session: str | None) -> dict[str, Any]:
    tmux = shutil.which("tmux")
    if not tmux:
        raise WorkflowError("--tmux requires tmux to be installed and available on PATH")
    session = requested_session or safe_id(f"wf-{workflow_id}-{run_id[-14:-1]}", "workflow-observer")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", session):
        raise WorkflowError("--tmux-session must contain only letters, numbers, '.', '_', or '-'")
    existing = subprocess.run([tmux, "has-session", "-t", session], capture_output=True, text=True)
    if existing.returncode == 0:
        raise WorkflowError(f"tmux session already exists: {session}")

    live_log = out_dir / "workflow.live.log"
    observer_script = out_dir / "tmux_observer.sh"
    append_live_log(
        live_log,
        f"Workflow observer started\nworkflow={workflow_id}\nrun_id={run_id}\nout_dir={out_dir}\n\n",
    )
    observer_script.write_text(
        "#!/usr/bin/env bash\n"
        "set -u\n"
        f"printf '%s\\n' 'Juno workflow observer: {workflow_id}' 'Artifacts: {out_dir}' "
        "'This session remains available after workflow completion. Press Ctrl-C to stop following.'\n"
        f"exec tail -n +1 -F {shlex.quote(str(live_log))}\n",
        encoding="utf-8",
    )
    observer_script.chmod(0o755)
    launched = subprocess.run(
        [tmux, "new-session", "-d", "-s", session, str(observer_script)],
        capture_output=True,
        text=True,
    )
    if launched.returncode != 0:
        detail = (launched.stderr or launched.stdout or "unknown tmux error").strip()
        raise WorkflowError(f"could not create tmux observer session {session}: {detail}")
    print(f"Workflow observer tmux session: {session}")
    print(f"Attach: tmux attach -t {shlex.quote(session)}")
    print(f"Live log: {live_log}")
    return {
        "enabled": True,
        "session": session,
        "live_log": str(live_log),
        "observer_script": str(observer_script),
        "attach_command": f"tmux attach -t {shlex.quote(session)}",
    }


def build_command_env(
    project_root: Path,
    command: Any,
    capture_enabled: bool,
    capture_path: Path,
    tool_id: str,
    dry_run: bool,
) -> tuple[dict[str, str], str | None]:
    env = child_process_environment(dict(os.environ))
    is_juno_command = detect_juno_command(command)
    if is_juno_command:
        metadata_dir = capture_path.parent / "session_metadata"
        metadata_dir.mkdir(parents=True, exist_ok=True)
        env["JUNO_CODE_SESSION_METADATA_DIRECTORY"] = str(metadata_dir)
    if capture_enabled:
        env["JUNO_TOOL_ID"] = tool_id
        env["JUNO_SUBAGENT_CAPTURE_PATH"] = str(capture_path)
    else:
        env.pop("JUNO_TOOL_ID", None)
        env.pop("JUNO_SUBAGENT_CAPTURE_PATH", None)
    child_continue_session_before = (
        read_child_continue_session(project_root, command)
        if is_juno_command and capture_enabled and not dry_run
        else None
    )
    return env, child_continue_session_before


def apply_semantic_outcome_contract(step: dict[str, Any], result: dict[str, Any], dry_run: bool) -> None:
    expected = step.get("expected_outcomes")
    if expected is None:
        return
    if not isinstance(expected, list) or not expected or not all(isinstance(item, str) and item for item in expected):
        raise WorkflowError(f"step {step.get('id', '<unknown>')} expected_outcomes must be a non-empty string list")
    if dry_run or result.get("status") != "success":
        return
    matches = re.findall(
        r"(?m)^JUNO_WORKFLOW_OUTCOME:\s*([A-Za-z0-9_.-]+)\s*$",
        str(result.get("response") or ""),
    )
    if not matches:
        result["status"] = "failed"
        result["failure_reason"] = "missing JUNO_WORKFLOW_OUTCOME footer"
        return
    outcome = matches[-1]
    result["semantic_outcome"] = outcome
    if outcome not in expected:
        result["status"] = "failed"
        result["failure_reason"] = f"semantic outcome {outcome!r} is not one of {expected!r}"


def apply_agent_session_capture(
    result: dict[str, Any],
    project_root: Path,
    stdout: str,
    stderr: str,
    capture_path: Path,
    child_continue_session_before: str | None,
    dry_run: bool,
    *,
    use_capture_result_as_response: bool,
) -> None:
    if result.get("capture_enabled") and not dry_run:
        capture_payload, capture_warning = read_capture_payload(capture_path)
        if capture_warning:
            print(f"workflow_runner.sh: warning: {capture_warning}", file=sys.stderr)
            result["capture_warning"] = capture_warning
        if capture_payload is not None:
            result["capture"] = capture_payload
            session_id = capture_payload.get("session_id")
            capture_result = capture_payload.get("result")
            if isinstance(session_id, str):
                result["session_id"] = session_id
            if isinstance(capture_result, str):
                result["capture_result"] = capture_result
                if use_capture_result_as_response:
                    result["response"] = capture_result
        elif not capture_path.exists():
            session_id = extract_session_id(stdout, stderr)
            if session_id:
                result["session_id"] = session_id
    if not result.get("session_id"):
        fallback_session_id = extract_session_id(stdout, stderr)
        if not fallback_session_id and not dry_run:
            child_continue_session_after = read_child_continue_session(project_root, result.get("command"))
            if child_continue_session_after and child_continue_session_after != child_continue_session_before:
                fallback_session_id = child_continue_session_after
        if fallback_session_id:
            result["session_id"] = fallback_session_id


def resolve_workflow_vars(workflow_vars: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    """Resolve workflow vars against builtins and other vars before command rendering."""
    resolved = dict(workflow_vars)
    for _ in range(10):
        changed = False
        render_context = {**context, "vars": resolved}
        for key, value in list(resolved.items()):
            rendered = render(value, render_context)
            if rendered != value:
                resolved[key] = rendered
                changed = True
        if not changed:
            break
    return resolved


def maybe_run_summary_command(
    workflow: dict[str, Any],
    context: dict[str, Any],
    project_root: Path,
    out_dir: Path,
    dry_run: bool,
    live_log_path: Path | None = None,
) -> tuple[str, str, int, Any | None, dict[str, Any] | None]:
    explicit = workflow.get("summary")
    if not isinstance(explicit, dict) or "command" not in explicit:
        write_text(out_dir / "summary.stdout.txt", "")
        write_text(out_dir / "summary.stderr.txt", "")
        return "", "", 0, None, None
    command = render(explicit["command"], context)
    write_text(out_dir / "summary.command.sh", command_preview(command) + "\n")
    is_juno_command = detect_juno_command(command)
    capture_enabled = bool(explicit.get("capture_session", explicit.get("capture", is_juno_command)))
    capture_path = out_dir / "summary.capture.json"
    env, child_continue_session_before = build_command_env(
        project_root, command, capture_enabled, capture_path, "workflow_summary", dry_run
    )
    if dry_run:
        stdout = ""
        stderr = ""
        exit_code = 0
    else:
        append_live_log(live_log_path, "\n=== SUMMARY COMMAND ===\n")
        proc = execute_rendered_command(command, project_root, env, live_log_path)
        stdout = proc.stdout or ""
        stderr = proc.stderr or ""
        exit_code = int(proc.returncode)
    write_text(out_dir / "summary.stdout.txt", stdout)
    write_text(out_dir / "summary.stderr.txt", stderr)
    result: dict[str, Any] | None = None
    if is_juno_command or capture_enabled:
        result = {
            "id": "summary",
            "kind": "summary",
            "index": "summary",
            "name": "summary",
            "command": command,
            "command_preview": command_preview(command),
            "status": "dry_run" if dry_run else ("success" if exit_code == 0 else "failed"),
            "exit_code": exit_code,
            "stdout_path": str(out_dir / "summary.stdout.txt"),
            "stderr_path": str(out_dir / "summary.stderr.txt"),
            "capture_enabled": capture_enabled,
            "capture_json": str(capture_path) if capture_enabled else "",
            "capture_json_path": str(capture_path) if capture_enabled else "",
            "capture_result": "",
            "session_id": "",
        }
        if capture_enabled:
            apply_agent_session_capture(
                result,
                project_root,
                stdout,
                stderr,
                capture_path,
                child_continue_session_before,
                dry_run,
                use_capture_result_as_response=False,
            )
    return stdout, stderr, exit_code, command, result


def resolve_from_step(steps: list[dict[str, Any]], selector: str | None) -> int:
    """Return zero-based start index for --from-step selector."""
    if selector is None or str(selector).strip() == "":
        return 0
    raw = str(selector).strip()
    try:
        value = int(raw)
    except ValueError:
        for idx, step in enumerate(steps):
            if str(step.get("id")) == raw or str(step.get("name", "")) == raw:
                return idx
        raise WorkflowError(f"--from-step target not found: {raw}")
    if value == -1:
        return len(steps) - 1
    if value < 0 or value >= len(steps):
        raise WorkflowError(f"--from-step index out of range: {value} (steps: 0..{len(steps) - 1}, or -1)")
    return value


def build_run_contract(
    workflow_text: str,
    workflow: dict[str, Any],
    context: dict[str, Any],
    project_root: Path,
) -> dict[str, Any]:
    frozen_inputs: list[dict[str, Any]] = []
    for item in workflow.get("frozen_inputs") or []:
        rendered_path = Path(str(render(item["path"], context))).expanduser()
        if not rendered_path.is_absolute():
            rendered_path = project_root / rendered_path
        required = bool(item.get("required", True))
        if required and not rendered_path.is_file():
            raise WorkflowError(f"frozen_input[{item['id']}]: required file not found: {rendered_path}")
        frozen_inputs.append(
            {
                "id": item["id"],
                "path": str(rendered_path.resolve()),
                "required": required,
                "sha256": file_sha256(rendered_path) if rendered_path.is_file() else None,
            }
        )
    receipts = normalize_receipt_contracts(workflow)
    return {
        "schema_version": RUN_CONTRACT_SCHEMA,
        "workflow_id": context["workflow_id"],
        "workflow_source_sha256": sha256_bytes(workflow_text.encode("utf-8")),
        "resolved_vars_sha256": canonical_sha256(context["vars"]),
        "steps": {
            str(step["id"]): {
                "template_sha256": canonical_sha256(step["command"]),
                "initial_rendered_sha256": canonical_sha256(render(step["command"], context)),
            }
            for step in workflow["steps"]
        },
        "frozen_inputs": frozen_inputs,
        "receipt_contracts": receipts,
        "receipt_contracts_sha256": canonical_sha256(receipts),
        "terminal_gate": str(workflow.get("terminal_gate") or ""),
        "validation_ownership": workflow.get("validation_ownership") or {},
        "workflow_class": str(workflow.get("workflow_class") or ""),
        "integration_step": str(workflow.get("integration_step") or ""),
        "controller_disposition": str(workflow.get("controller_disposition") or ""),
        "completed_steps": {},
        "attempts": [],
    }


def verify_run_contract(frozen: dict[str, Any], current: dict[str, Any]) -> None:
    checks = {
        "schema_version": (RUN_CONTRACT_SCHEMA, frozen.get("schema_version")),
        "workflow_id": (frozen.get("workflow_id"), current.get("workflow_id")),
        "workflow_source_sha256": (frozen.get("workflow_source_sha256"), current.get("workflow_source_sha256")),
        "resolved_vars_sha256": (frozen.get("resolved_vars_sha256"), current.get("resolved_vars_sha256")),
        "steps": (frozen.get("steps"), current.get("steps")),
        "frozen_inputs": (frozen.get("frozen_inputs"), current.get("frozen_inputs")),
        "receipt_contracts_sha256": (
            frozen.get("receipt_contracts_sha256"),
            current.get("receipt_contracts_sha256"),
        ),
        "terminal_gate": (frozen.get("terminal_gate"), current.get("terminal_gate")),
        "validation_ownership": (frozen.get("validation_ownership"), current.get("validation_ownership")),
        "workflow_class": (frozen.get("workflow_class"), current.get("workflow_class")),
        "integration_step": (frozen.get("integration_step"), current.get("integration_step")),
        "controller_disposition": (frozen.get("controller_disposition"), current.get("controller_disposition")),
    }
    for name, (expected, actual) in checks.items():
        if expected != actual:
            raise WorkflowError(f"resume_contract[{name}]: expected={expected!r} actual={actual!r}")


def receipt_path(contract: dict[str, Any], context: dict[str, Any], project_root: Path) -> Path:
    path = Path(str(render(contract["path"], context))).expanduser()
    return path if path.is_absolute() else project_root / path


def populate_receipt_context(
    context: dict[str, Any], workflow: dict[str, Any], project_root: Path
) -> dict[str, dict[str, Any]]:
    """Expose each declared receipt as the only canonical rendered path source."""
    resolved: dict[str, dict[str, Any]] = {}
    for receipt_id, contract in normalize_receipt_contracts(workflow).items():
        path = receipt_path(contract, context, project_root)
        resolved[receipt_id] = {**contract, "path": str(path.resolve())}
    context["receipts"] = resolved
    return resolved


def context_for_out_dir(
    context: dict[str, Any], out_dir: Path, workflow: dict[str, Any], project_root: Path
) -> dict[str, Any]:
    inherited = dict(context)
    inherited["out_dir"] = str(out_dir)
    inherited["workflow"] = {**context["workflow"], "out_dir": str(out_dir)}
    inherited["steps"] = {}
    populate_receipt_context(inherited, workflow, project_root)
    return inherited


def validate_receipt_file(
    contract: dict[str, Any],
    context: dict[str, Any],
    project_root: Path,
    producer_step_digest: str,
    expected_artifact_sha256: str | None = None,
) -> dict[str, Any]:
    path = receipt_path(contract, context, project_root)
    payload = load_json_object(path, f"receipt[{contract['id']}]")
    validate_receipt_payload(contract, payload, producer_step_digest, location=str(path))
    digest = file_sha256(path)
    if expected_artifact_sha256 is not None and digest != expected_artifact_sha256:
        raise WorkflowError(
            f"receipt[{contract['id']}].artifact_sha256: expected={expected_artifact_sha256!r} actual={digest!r}"
        )
    return {"path": str(path.resolve()), "sha256": digest, "schema_version": payload["schema_version"]}


def latest_contract_manifest(
    parent_contract: dict[str, Any], parent_dir: Path, require_hash: bool = False
) -> Path:
    attempts = parent_contract.get("attempts") or []
    if attempts:
        attempt = attempts[-1]
        candidate = Path(str(attempt.get("manifest") or ""))
        if not candidate.is_file():
            raise WorkflowError(f"amendment newest parent manifest is missing: {candidate}")
        expected_hash = str(attempt.get("manifest_sha256") or "")
        if require_hash and not expected_hash:
            raise WorkflowError(f"amendment parent manifest is not hash-bound: {candidate}")
        if expected_hash and file_sha256(candidate) != expected_hash:
            raise WorkflowError(f"amendment parent manifest hash mismatch: {candidate}")
        return candidate
    candidate = parent_dir / "manifest.json"
    if candidate.is_file() and not require_hash:
        return candidate
    raise WorkflowError(f"amendment parent has no hash-bound readable manifest: {parent_dir}")


def materialize_inherited_receipt(
    contract: dict[str, Any],
    source_context: dict[str, Any],
    destination_context: dict[str, Any],
    project_root: Path,
    producer_step_digest: str,
    expected_artifact_sha256: str | None = None,
    inherited_source_path: str | None = None,
) -> dict[str, Any]:
    source = (
        Path(inherited_source_path).expanduser()
        if inherited_source_path
        else receipt_path(contract, source_context, project_root)
    )
    payload = load_json_object(source, f"amendment receipt[{contract['id']}]")
    validate_receipt_payload(contract, payload, producer_step_digest, location=str(source))
    digest = file_sha256(source)
    if expected_artifact_sha256 is not None and digest != expected_artifact_sha256:
        raise WorkflowError(
            f"amendment receipt[{contract['id']}].artifact_sha256: "
            f"expected={expected_artifact_sha256!r} actual={digest!r}"
        )
    destination = receipt_path(contract, destination_context, project_root)
    if source.resolve() != destination.resolve():
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists() and file_sha256(destination) != digest:
            raise WorkflowError(f"amendment receipt[{contract['id']}]: destination already differs: {destination}")
        if not destination.exists():
            shutil.copy2(source, destination)
    inherited = validate_receipt_file(
        contract, destination_context, project_root, producer_step_digest, digest
    )
    inherited["inherited_from"] = str(source.resolve())
    inherited["lineage"] = "amendment_revalidated"
    return inherited


def prepare_selective_amendment(
    workflow: dict[str, Any],
    current_contract: dict[str, Any],
    parent_contract: dict[str, Any],
    parent_manifest: dict[str, Any],
    context: dict[str, Any],
    project_root: Path,
    parent_dir: Path,
    parent_manifest_path: Path,
    start_index: int,
) -> dict[str, dict[str, Any]]:
    """Revalidate a parent prefix before any amendment suffix command is dispatched."""
    for field in ("schema_version", "workflow_id", "resolved_vars_sha256", "frozen_inputs", "workflow_class"):
        if parent_contract.get(field) != current_contract.get(field):
            raise WorkflowError(
                f"amendment_contract[{field}]: expected={parent_contract.get(field)!r} "
                f"actual={current_contract.get(field)!r}"
            )
    parent_steps = parent_contract.get("steps") or {}
    current_steps = current_contract.get("steps") or {}
    manifest_steps = {
        str(item.get("id")): item
        for item in parent_manifest.get("steps") or []
        if isinstance(item, dict)
    }
    parent_completed = parent_contract.get("completed_steps") or {}
    receipts_by_producer: dict[str, list[dict[str, Any]]] = {}
    for contract in normalize_receipt_contracts(workflow).values():
        receipts_by_producer.setdefault(contract["producer"], []).append(contract)
    parent_receipts_by_producer: dict[str, list[dict[str, Any]]] = {}
    for contract in (parent_contract.get("receipt_contracts") or {}).values():
        parent_receipts_by_producer.setdefault(str(contract.get("producer") or ""), []).append(contract)
    parent_context = context_for_out_dir(context, parent_dir, workflow, project_root)
    reused: dict[str, dict[str, Any]] = {}

    for step in workflow["steps"][:start_index]:
        step_id = str(step["id"])
        if (parent_steps.get(step_id) or {}).get("template_sha256") != (current_steps.get(step_id) or {}).get("template_sha256"):
            raise WorkflowError(f"amendment_prerequisite[{step_id}]: command template changed")
        previous = manifest_steps.get(step_id)
        completed = parent_completed.get(step_id) or {}
        if not previous:
            raise WorkflowError(f"amendment_prerequisite[{step_id}]: parent manifest evidence missing")
        command_digest = str(completed.get("command_sha256") or "")
        previous_digest = str(previous.get("command_sha256") or "")
        if not command_digest or previous_digest != command_digest:
            raise WorkflowError(f"amendment_prerequisite[{step_id}]: producer command digest mismatch")
        if "command" not in previous or canonical_sha256(previous["command"]) != command_digest:
            raise WorkflowError(f"amendment_prerequisite[{step_id}]: manifest command does not match producer digest")

        produced_contracts = receipts_by_producer.get(step_id, [])
        previous_contracts = parent_receipts_by_producer.get(step_id, [])
        produced_by_id = {str(contract["id"]): contract for contract in produced_contracts}
        previous_by_id = {str(contract["id"]): contract for contract in previous_contracts}
        if set(produced_by_id) != set(previous_by_id):
            raise WorkflowError(f"amendment_prerequisite[{step_id}]: producer receipt set changed")
        for receipt_id, contract in produced_by_id.items():
            previous_contract = previous_by_id[receipt_id]
            for field in ("producer", "schema_version", "required_fields", "expected_fields"):
                if contract.get(field) != previous_contract.get(field):
                    raise WorkflowError(
                        f"amendment_prerequisite[{step_id}].receipt[{receipt_id}]: contract {field} changed"
                    )
        status = str(previous.get("status") or "")
        normally_reusable = status in {"success", "reused_verified", "amendment_revalidated"} and bool(completed)
        if not normally_reusable:
            raise WorkflowError(f"amendment_prerequisite[{step_id}]: no reusable successful predecessor evidence")
        manifest_attempt = (
            previous.get("reused_from_attempt")
            if status in {"reused_verified", "amendment_revalidated"}
            else parent_manifest.get("run_id")
        )
        if str(manifest_attempt or "") != str(completed.get("attempt_id") or ""):
            raise WorkflowError(f"amendment_prerequisite[{step_id}]: completed evidence attempt mismatch")

        inherited_receipts: dict[str, Any] = {}
        for contract in produced_contracts:
            old_evidence = (completed.get("receipts") or {}).get(contract["id"]) or {}
            if not old_evidence.get("path") or not old_evidence.get("sha256"):
                raise WorkflowError(
                    f"amendment_prerequisite[{step_id}].receipt[{contract['id']}]: "
                    "parent hash anchor missing"
                )
            inherited_receipts[contract["id"]] = materialize_inherited_receipt(
                contract,
                parent_context,
                context,
                project_root,
                command_digest,
                str(old_evidence.get("sha256")) if old_evidence.get("sha256") else None,
                str(old_evidence.get("path")) if old_evidence.get("path") else None,
            )
        reused[step_id] = {
            "previous": previous,
            "command_sha256": command_digest,
            "receipts": inherited_receipts,
            "parent_attempt": completed.get("attempt_id"),
            "parent_manifest": str(parent_manifest_path.resolve()),
        }
    return reused


def archive_attempt(out_dir: Path, manifest: dict[str, Any]) -> None:
    attempt_id = str(manifest["run_id"])
    attempt_dir = out_dir / "attempts" / attempt_id
    if attempt_dir.exists():
        raise WorkflowError(f"attempt archive already exists: {attempt_dir}")
    attempt_dir.mkdir(parents=True)
    write_text(attempt_dir / "manifest.json", json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    for step in manifest.get("steps", []):
        for key in ("stdout_path", "stderr_path", "response_path"):
            raw_path = str(step.get(key) or "")
            if not raw_path:
                continue
            source = Path(raw_path)
            if source.is_file():
                shutil.copy2(source, attempt_dir / source.name)
    for name in ("summary.md", "summary.stdout.txt", "summary.stderr.txt", "summary.command.sh"):
        source = out_dir / name
        if source.is_file():
            shutil.copy2(source, attempt_dir / name)


def selected_final_output(print_output: str, context: dict[str, Any], summary: str) -> str:
    if print_output == "summary":
        return summary
    if print_output == "none":
        return ""
    selected = print_output.split(":", 1)[1] if print_output.startswith("step:") else print_output
    result = context["steps"].get(selected)
    if result is None:
        raise WorkflowError(f"unknown --print-output step: {selected}")
    return str(result.get("response", result.get("stdout", "")))


def run_workflow(args: argparse.Namespace) -> int:
    project_root = Path(args.project_root or os.getcwd()).resolve()
    if args.init_example:
        target = init_example(args.init_example, bool(args.force))
        print(f"Wrote example workflow to {target}")
        return 0

    if not args.workflow:
        raise WorkflowError("--workflow is required unless --init-example is used")
    if args.workflow == "-":
        workflow_text = sys.stdin.read()
        workflow_dir = project_root
    else:
        workflow_path = Path(args.workflow).resolve()
        workflow_text = workflow_path.read_text(encoding="utf-8")
        workflow_dir = workflow_path.parent
    workflow = parse_yaml_like(workflow_text)
    validate_workflow(workflow)

    now = _dt.datetime.now(_dt.timezone.utc)
    run_id = now.strftime("%Y%m%d_%H%M%S_%fZ")
    workflow_id = safe_id(workflow.get("workflow_id") or workflow.get("id") or workflow.get("name"), "workflow")
    out_dir = (
        Path(args.out_dir).resolve()
        if args.out_dir
        else project_root / ".juno_task" / "specs" / "workflows" / workflow_id / run_id
    )
    out_dir.mkdir(parents=True, exist_ok=True)

    workflow_vars = workflow.get("vars") if isinstance(workflow.get("vars"), dict) else {}
    workflow_vars = {**workflow_vars, **parse_vars(args.vars or [])}
    context: dict[str, Any] = {
        "now_utc": now.isoformat().replace("+00:00", "Z"),
        "today_utc": now.date().isoformat(),
        "yesterday_utc": (now.date() - _dt.timedelta(days=1)).isoformat(),
        "run_id": run_id,
        "workflow_id": workflow_id,
        "workflow_dir": str(workflow_dir),
        "repo_root": str(project_root),
        "project_root": str(project_root),
        "out_dir": str(out_dir),
        "workflow": {
            "id": workflow_id,
            "name": workflow.get("name", workflow_id),
            "out_dir": str(out_dir),
            "project_root": str(project_root),
            "dir": str(workflow_dir),
        },
        "vars": workflow_vars,
        "steps": {},
    }
    workflow_vars = resolve_workflow_vars(workflow_vars, context)
    context["vars"] = workflow_vars
    for key, value in workflow_vars.items():
        if isinstance(key, str) and key not in context:
            context[key] = value
    populate_receipt_context(context, workflow, project_root)

    start_index = resolve_from_step(workflow["steps"], args.from_step)
    requested_from_step = args.from_step is not None and str(args.from_step).strip() != ""
    run_contract_path = out_dir / "run_contract.json"
    is_resume = requested_from_step and run_contract_path.exists() and not args.amends_run
    is_selective_amendment = bool(args.amends_run and requested_from_step)
    current_contract = build_run_contract(workflow_text, workflow, context, project_root)
    parent_contract: dict[str, Any] | None = None
    parent_manifest: dict[str, Any] | None = None
    parent_manifest_path: Path | None = None
    parent_dir: Path | None = None
    if args.amends_run:
        if str(workflow.get("amendment_mode") or "") != "harness_only_validation":
            raise WorkflowError("--amends-run requires amendment_mode: harness_only_validation")
        parent = Path(args.amends_run).expanduser().resolve()
        parent_contract_path = parent / "run_contract.json" if parent.is_dir() else parent
        parent_dir = parent_contract_path.parent
        parent_contract = load_json_object(parent_contract_path, "amended run contract")
        if parent_contract.get("schema_version") != RUN_CONTRACT_SCHEMA:
            raise WorkflowError(f"amended run contract has unsupported schema: {parent_contract.get('schema_version')!r}")
        if parent_contract.get("workflow_id") != workflow_id:
            raise WorkflowError(
                f"amended run contract workflow mismatch: expected={workflow_id!r} actual={parent_contract.get('workflow_id')!r}"
            )
        current_contract["amendment_of"] = {
            "run_contract": str(parent_contract_path),
            "sha256": file_sha256(parent_contract_path),
            "workflow_id": parent_contract.get("workflow_id"),
            "mode": "harness_only_validation",
        }
        if is_selective_amendment:
            parent_manifest_path = latest_contract_manifest(parent_contract, parent_dir, require_hash=True)
            parent_manifest = load_json_object(parent_manifest_path, "amended run manifest")
            newest_attempt_id = str((parent_contract.get("attempts") or [])[-1].get("attempt_id") or "")
            if str(parent_manifest.get("run_id") or "") != newest_attempt_id:
                raise WorkflowError(
                    "amendment newest attempt identity does not match its hash-bound manifest: "
                    f"attempt={newest_attempt_id!r} manifest={parent_manifest.get('run_id')!r}"
                )
            current_contract["amendment_of"]["manifest"] = str(parent_manifest_path.resolve())
            current_contract["amendment_of"]["manifest_sha256"] = file_sha256(parent_manifest_path)
    previous_manifest: dict[str, Any] | None = None
    amendment_reuse: dict[str, dict[str, Any]] = {}
    if is_resume:
        frozen_contract = load_json_object(run_contract_path, "run contract")
        verify_run_contract(frozen_contract, current_contract)
        previous_manifest = load_json_object(out_dir / "manifest.json", "previous workflow manifest")
        run_contract = frozen_contract
    else:
        if run_contract_path.exists():
            raise WorkflowError(
                f"run directory already has an immutable contract: {run_contract_path}; use a fresh --out-dir or --from-step"
            )
        run_contract = current_contract
        if is_selective_amendment:
            assert (
                parent_contract is not None
                and parent_manifest is not None
                and parent_manifest_path is not None
                and parent_dir is not None
            )
            amendment_reuse = prepare_selective_amendment(
                workflow,
                current_contract,
                parent_contract,
                parent_manifest,
                context,
                project_root,
                parent_dir,
                parent_manifest_path,
                start_index,
            )
            previous_manifest = parent_manifest
            for step_id, evidence in amendment_reuse.items():
                run_contract.setdefault("completed_steps", {})[step_id] = {
                    "attempt_id": evidence["parent_attempt"],
                    "command_sha256": evidence["command_sha256"],
                    "status": "amendment_revalidated",
                    "receipts": evidence["receipts"],
                    "inherited_from_manifest": evidence["parent_manifest"],
                }
            run_contract["amendment_reused_steps"] = list(amendment_reuse)
        write_text(run_contract_path, json.dumps(run_contract, indent=2, ensure_ascii=False) + "\n")

    if args.tmux_session and not args.tmux:
        raise WorkflowError("--tmux-session requires --tmux")
    tmux_observer = (
        start_tmux_observer(out_dir, workflow_id, run_id, args.tmux_session)
        if args.tmux and not args.dry_run
        else {"enabled": False}
    )
    live_log_path = Path(tmux_observer["live_log"]) if tmux_observer.get("enabled") else None

    manifest: dict[str, Any] = {
        "schema_version": "1.0",
        "workflow_id": workflow_id,
        "workflow": context["workflow"],
        "run_id": run_id,
        "dry_run": bool(args.dry_run),
        "repo_root": str(project_root),
        "workflow_dir": str(workflow_dir),
        "out_dir": str(out_dir),
        "steps": [],
        "failed_steps": [],
        "status": "success",
        "tmux_observer": tmux_observer,
    }

    final_exit = 0
    session_candidates: list[dict[str, Any]] = []
    explicit_continue_from_step = str(workflow.get("continue_from_step") or "").strip()
    persisted_continue: dict[str, str] | None = None
    manifest["from_step"] = args.from_step
    manifest["from_step_index"] = start_index
    manifest["attempt_number"] = len(run_contract.get("attempts") or []) + 1
    manifest["run_contract_path"] = str(run_contract_path)
    if is_selective_amendment:
        reused_ids = [str(step["id"]) for step in workflow["steps"][:start_index]]
        executed_ids = [str(step["id"]) for step in workflow["steps"][start_index:]]
        manifest["amendment_plan"] = {
            "parent_manifest": current_contract["amendment_of"]["manifest"],
            "reused_steps": reused_ids,
            "executed_steps": executed_ids,
        }
        print("Amendment execution plan")
        print("  Revalidate/reuse: " + (", ".join(reused_ids) if reused_ids else "none"))
        print("  Execute: " + (", ".join(executed_ids) if executed_ids else "none"))
    previous_steps = {
        str(item.get("id")): item for item in (previous_manifest or {}).get("steps", []) if isinstance(item, dict)
    }
    receipts = normalize_receipt_contracts(workflow)
    receipts_by_producer: dict[str, list[dict[str, Any]]] = {}
    for contract in receipts.values():
        receipts_by_producer.setdefault(contract["producer"], []).append(contract)
    for index, step in enumerate(workflow["steps"], start=1):
        step_id = str(step["id"])
        if index - 1 < start_index:
            if not is_resume and not is_selective_amendment:
                command = render(step["command"], context)
                skipped_result: dict[str, Any] = {
                    "id": step_id,
                    "command": command,
                    "command_preview": command_preview(command),
                    "status": "skipped",
                    "exit_code": 0,
                    "transport_status": "skipped",
                    "transport_exit_code": 0,
                    "duration_seconds": 0,
                    "stdout": "",
                    "stderr": "",
                    "stdout_path": "",
                    "stderr_path": "",
                    "response": "",
                    "response_path": "",
                    "capture_enabled": False,
                    "capture_json": "",
                    "capture_json_path": "",
                    "capture_result": "",
                    "session_id": "",
                }
                context["steps"][step_id] = skipped_result
                manifest["steps"].append(
                    {k: v for k, v in skipped_result.items() if k not in {"stdout", "stderr"}}
                )
                continue
            previous = previous_steps.get(step_id)
            completed = (run_contract.get("completed_steps") or {}).get(step_id)
            reusable_statuses = {"success", "reused_verified", "amendment_revalidated"}
            if is_selective_amendment:
                evidence = amendment_reuse.get(step_id)
                if not evidence:
                    raise WorkflowError(f"amendment_prerequisite[{step_id}]: prepared evidence missing")
                previous = evidence["previous"]
            if not previous or not completed or (
                not is_selective_amendment and previous.get("status") not in reusable_statuses
            ):
                raise WorkflowError(f"resume_prerequisite[{step_id}]: no reusable successful predecessor evidence")
            for contract in receipts_by_producer.get(step_id, []):
                receipt_evidence = (completed.get("receipts") or {}).get(contract["id"])
                if not receipt_evidence:
                    raise WorkflowError(f"resume_prerequisite[{step_id}].receipt[{contract['id']}]: evidence missing")
                validate_receipt_file(
                    contract,
                    context,
                    project_root,
                    str(completed["command_sha256"]),
                    str(receipt_evidence["sha256"]),
                )
            reused_status = "amendment_revalidated" if is_selective_amendment else "reused_verified"
            skipped_result: dict[str, Any] = {
                "id": step_id,
                "command": previous.get("command", render(step["command"], context)),
                "command_preview": previous.get("command_preview", command_preview(render(step["command"], context))),
                "status": reused_status,
                "exit_code": previous.get("exit_code", 0),
                "transport_status": previous.get("transport_status", previous.get("status")),
                "transport_exit_code": previous.get("transport_exit_code", previous.get("exit_code", 0)),
                "duration_seconds": 0,
                "stdout": "",
                "stderr": "",
                "stdout_path": "",
                "stderr_path": "",
                "response": previous.get("response", ""),
                "response_path": previous.get("response_path", ""),
                "capture_enabled": False,
                "capture_json": "",
                "capture_json_path": "",
                "capture_result": "",
                "session_id": "",
                "reused_from_attempt": completed.get("attempt_id") or previous_manifest.get("run_id"),
                "reused_from_manifest": completed.get("inherited_from_manifest", ""),
                "command_sha256": completed.get("command_sha256"),
                "producer_command_sha256": completed.get("command_sha256"),
                "semantic_outcome": previous.get("semantic_outcome", ""),
            }
            context["steps"][step_id] = skipped_result
            manifest["steps"].append({k: v for k, v in skipped_result.items() if k not in {"stdout", "stderr"}})
            continue
        command = render(step["command"], context)
        preview = command_preview(command)
        command_digest = canonical_sha256(command)
        is_juno_command = detect_juno_command(command)
        capture_enabled = step_capture_enabled(step, command)
        step_slug = safe_id(step_id, f"step-{index}")
        stdout_path = out_dir / f"{index:03d}_{step_slug}.stdout.txt"
        stderr_path = out_dir / f"{index:03d}_{step_slug}.stderr.txt"
        capture_path = out_dir / f"{index:03d}_{step_slug}.capture.json"
        response_path = out_dir / f"{index:03d}_{step_slug}.response.txt"
        legacy_step_dir = out_dir / "steps" / step_id
        write_text(legacy_step_dir / "command.sh", preview + "\n")
        print("\n" + step_separator("START", index, step_id))
        print(preview)
        append_live_log(live_log_path, f"\n=== START step {index} [{step_id}] ===\n{preview}\n")
        started = time.monotonic()
        stdout = ""
        stderr = ""
        exit_code = 0
        env, child_continue_session_before = build_command_env(
            project_root, command, capture_enabled, capture_path, f"workflow_{step_slug}", bool(args.dry_run)
        )
        env["JUNO_WORKFLOW_STEP_ID"] = step_id
        env["JUNO_WORKFLOW_STEP_DIGEST"] = command_digest
        for receipt_id, receipt in context.get("receipts", {}).items():
            env_key = "JUNO_WORKFLOW_RECEIPT_" + re.sub(r"[^A-Za-z0-9]", "_", receipt_id).upper()
            env[env_key] = str(receipt["path"])
        precondition_error = ""
        if not args.dry_run:
            try:
                for receipt_id in step.get("requires_receipts") or []:
                    producer = receipts[receipt_id]["producer"]
                    evidence = (run_contract.get("completed_steps") or {}).get(producer, {})
                    receipt_evidence = (evidence.get("receipts") or {}).get(receipt_id)
                    if not receipt_evidence:
                        raise WorkflowError(f"step[{step_id}].requires_receipt[{receipt_id}]: producer evidence missing")
                    validate_receipt_file(
                        receipts[receipt_id],
                        context,
                        project_root,
                        str(evidence["command_sha256"]),
                        str(receipt_evidence["sha256"]),
                    )
            except WorkflowError as exc:
                precondition_error = str(exc)
        if args.dry_run:
            status = "dry_run"
        elif precondition_error:
            stderr = precondition_error + "\n"
            exit_code = 1
            status = "failed"
        else:
            proc = execute_rendered_command(command, project_root, env, live_log_path)
            stdout = proc.stdout or ""
            stderr = proc.stderr or ""
            exit_code = int(proc.returncode)
            status = "success" if exit_code == 0 else "failed"
        duration = round(time.monotonic() - started, 3)
        write_text(stdout_path, stdout)
        write_text(stderr_path, stderr)
        write_text(legacy_step_dir / "stdout.txt", stdout)
        write_text(legacy_step_dir / "stderr.txt", stderr)
        response = stdout
        result: dict[str, Any] = {
            "id": step_id,
            "command": command,
            "command_preview": preview,
            "status": status,
            "exit_code": exit_code,
            "transport_status": status,
            "transport_exit_code": exit_code,
            "duration_seconds": duration,
            "stdout": stdout,
            "stderr": stderr,
            "response": response,
            "stdout_path": str(stdout_path),
            "stderr_path": str(stderr_path),
            "response_path": str(response_path),
            "capture_enabled": capture_enabled,
            "capture_json": str(capture_path) if capture_enabled else "",
            "capture_json_path": str(capture_path) if capture_enabled else "",
            "capture_result": "",
            "session_id": "",
            "command_sha256": command_digest,
        }
        if capture_enabled:
            apply_agent_session_capture(
                result,
                project_root,
                stdout,
                stderr,
                capture_path,
                child_continue_session_before,
                bool(args.dry_run),
                use_capture_result_as_response=True,
            )
        apply_semantic_outcome_contract(step, result, bool(args.dry_run))
        status = str(result.get("status", status))
        if is_juno_command and not args.dry_run and status == "success" and not str(result.get("response", "")).strip():
            status = "failed"
            result["status"] = status
            result["failure_reason"] = "empty response from detected agent command"
        if status == "success" and not args.dry_run:
            try:
                produced_receipts: dict[str, Any] = {}
                for contract in receipts_by_producer.get(step_id, []):
                    produced_receipts[contract["id"]] = validate_receipt_file(
                        contract, context, project_root, command_digest
                    )
                run_contract.setdefault("completed_steps", {})[step_id] = {
                    "attempt_id": run_id,
                    "command_sha256": command_digest,
                    "status": "success",
                    "receipts": produced_receipts,
                }
                write_text(run_contract_path, json.dumps(run_contract, indent=2, ensure_ascii=False) + "\n")
            except WorkflowError as exc:
                status = "failed"
                result["status"] = "failed"
                result["failure_reason"] = str(exc)
                stderr = (stderr + ("\n" if stderr else "") + str(exc) + "\n")
                result["stderr"] = stderr
        if status == "failed" and exit_code == 0:
            exit_code = 1
            result["exit_code"] = 1
            failure_reason = str(result.get("failure_reason") or "semantic contract failed")
            if failure_reason not in stderr:
                stderr = (stderr + ("\n" if stderr else "") + failure_reason + "\n")
                result["stderr"] = stderr
        write_text(stderr_path, stderr)
        write_text(legacy_step_dir / "stderr.txt", stderr)
        if stderr and status == "failed":
            print(stderr, file=sys.stderr, end="" if stderr.endswith("\n") else "\n")
        if result.get("session_id") or explicit_continue_from_step in {step_id, str(step.get("name") or "")}:
            session_candidates.append({
                "index": index,
                "id": step_id,
                "name": str(step.get("name") or ""),
                "session_id": str(result.get("session_id") or ""),
                "status": result.get("status", status),
                "command": command,
            })
        write_text(response_path, str(result.get("response", "")))
        write_text(legacy_step_dir / "response.txt", str(result.get("response", "")))
        if args.print_step_stdout:
            response_text = str(result.get("response", ""))
            print(step_separator("RESPONSE", index, step_id))
            print(response_text, end="" if response_text.endswith("\n") or not response_text else "\n")
            if not response_text:
                print("(response is empty)")
        context["steps"][step_id] = result
        manifest["steps"].append({k: v for k, v in result.items() if k not in {"stdout", "stderr"}})
        print(step_separator("END", index, step_id, f"status={status} duration={duration:.3f}s exit={exit_code}"))
        append_live_log(
            live_log_path,
            f"=== END step {index} [{step_id}] status={status} duration={duration:.3f}s exit={exit_code} ===\n",
        )
        if status == "failed":
            manifest["failed_steps"].append(step_id)
            manifest["status"] = "failed"
            if step_should_fail_process(step):
                final_exit = exit_code or 1
                break

    terminal_gate = str(workflow.get("terminal_gate") or "").strip()
    terminal_result = context["steps"].get(terminal_gate) if terminal_gate else None
    if args.dry_run:
        semantic_status = "dry_run"
    elif terminal_result is None:
        semantic_status = "failed" if manifest["failed_steps"] else "completed"
    elif terminal_result.get("status") in {"success", "reused_verified", "amendment_revalidated"}:
        semantic_status = str(terminal_result.get("semantic_outcome") or "completed")
    else:
        semantic_status = "failed"
    successful_terminal_outcomes = workflow.get("terminal_success_outcomes") or ["completed"]
    if terminal_gate and not args.dry_run and semantic_status not in successful_terminal_outcomes:
        manifest["status"] = "failed"
        if terminal_gate not in manifest["failed_steps"]:
            manifest["failed_steps"].append(terminal_gate)
        final_exit = final_exit or 1
    manifest["terminal_gate"] = terminal_gate or None
    manifest["semantic_status"] = semantic_status
    context["workflow_semantic"] = {"terminal_gate": terminal_gate or "none", "status": semantic_status}

    summary_stdout, summary_stderr, summary_exit, summary_command, summary_session = maybe_run_summary_command(
        workflow, context, project_root, out_dir, bool(args.dry_run), live_log_path
    )
    if summary_session:
        session_candidates.append(summary_session)

    selected_continue_step = select_continue_step(workflow, session_candidates)
    if selected_continue_step:
        persisted_continue = persist_continue_context(
            project_root, str(selected_continue_step["session_id"]), selected_continue_step["command"]
        )
        if persisted_continue:
            persisted_continue["step_index"] = str(selected_continue_step["index"])
            persisted_continue["step_id"] = str(selected_continue_step["id"])
            persisted_continue["selected_label"] = session_label(selected_continue_step)
        manifest["continue"] = {
            "step_index": selected_continue_step["index"],
            "step_id": selected_continue_step["id"],
            "session_id": selected_continue_step["session_id"],
            "scope_hash": persisted_continue.get("scope_hash") if persisted_continue else "",
        }
    elif str(workflow.get("continue_from_step") or "").strip():
        raise WorkflowError(f"continue_from_step '{workflow.get('continue_from_step')}' did not produce a session_id")
    summary_capture_result = str(summary_session.get("capture_result", "")) if summary_session else ""
    summary = (
        summary_capture_result.rstrip() + "\n"
        if summary_capture_result
        else summary_stdout.rstrip() + "\n"
        if summary_stdout
        else make_summary(workflow, context, manifest["failed_steps"], bool(args.dry_run))
    )
    semantic_header = (
        f"Controlling gate: {terminal_gate or 'none'}\n"
        f"Semantic outcome: {semantic_status}\n\n"
    )
    summary = semantic_header + summary
    write_text(out_dir / "summary.md", summary)
    manifest["summary_path"] = str(out_dir / "summary.md")
    manifest["summary"] = {
        "stdout_path": str(out_dir / "summary.stdout.txt"),
        "stderr_path": str(out_dir / "summary.stderr.txt"),
        "exit_code": summary_exit,
        "command": summary_command,
    }
    if summary_session:
        manifest["summary"]["session_id"] = summary_session.get("session_id", "")
        manifest["summary"]["capture_enabled"] = summary_session.get("capture_enabled", False)
        manifest["summary"]["capture_json"] = summary_session.get("capture_json", "")
        manifest["summary"]["capture_json_path"] = summary_session.get("capture_json_path", "")
        manifest["summary"]["capture_result"] = summary_session.get("capture_result", "")
    if summary_stdout:
        manifest["summary"]["stdout"] = summary_stdout
    if summary_stderr:
        manifest["summary"]["stderr"] = summary_stderr
    write_text(out_dir / "manifest.json", json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    write_text(out_dir / "manifest.yaml", workflow_to_yaml(manifest) + "\n")
    archive_attempt(out_dir, manifest)
    archived_manifest = out_dir / "attempts" / run_id / "manifest.json"
    run_contract.setdefault("attempts", []).append(
        {
            "attempt_id": run_id,
            "from_step": args.from_step,
            "status": manifest["status"],
            "semantic_status": semantic_status,
            "manifest": str(archived_manifest.resolve()),
            "manifest_sha256": file_sha256(archived_manifest),
        }
    )
    write_text(run_contract_path, json.dumps(run_contract, indent=2, ensure_ascii=False) + "\n")

    output = selected_final_output(args.print_output, context, summary)
    if output:
        print("\n" + output, end="" if output.endswith("\n") else "\n")
    print_session_summary([item for item in session_candidates if item.get("session_id")], persisted_continue)
    if tmux_observer.get("enabled"):
        append_live_log(
            live_log_path,
            f"\n=== WORKFLOW COMPLETE status={manifest['status']} exit={final_exit} ===\n"
            f"Manifest: {out_dir / 'manifest.json'}\n"
            "The tmux observer remains available for review.\n",
        )
        print(f"Observer remains available: {tmux_observer['attach_command']}")
    return final_exit


EXAMPLE_WORKFLOWS = {
    "agent-chain": """schema_version: 1
workflow_id: example_agent_chain
vars:
  run_date: "{{ yesterday_utc }}"
steps:
  - id: first_agent
    command:
      - yy
      - pi
      - |
        %ralph-loop Do a small readonly investigation for {{ run_date }}.
        Finish with: AGENT_RESPONSE_ONE_LINE: <one sentence>
  - id: continue_agent
    command:
      - yy
      - pi
      - --resume
      - "{{ steps.first_agent.session_id }}"
      - |
        Continue the previous session and summarize next actions.
summary:
  command:
    - yy
    - pi
    - |
      Summarize workflow status. First session: {{ steps.first_agent.session_id }}
      First response: {{ steps.first_agent.response }}
""",
    "command-pipeline": """schema_version: 1
workflow_id: example_command_pipeline
vars:
  subject: juno workflow runner
steps:
  - id: collect
    command: |
      printf 'Subject: {{ subject }}\\nDate: {{ today_utc }}\\n'
  - id: summarize
    command: |
      printf 'Summary input:\\n{{ steps.collect.stdout }}\\n'
summary: |
  # Command pipeline summary
  Collect status: {{ steps.collect.status }}
  Summary output: {{ steps.summarize.stdout }}
""",
    "daily-ops": """schema_version: 1
workflow_id: example_daily_ops
vars:
  run_date: "{{ yesterday_utc }}"
steps:
  - id: preflight
    command: |
      printf 'Daily ops preflight for {{ run_date }} in {{ repo_root }}\\n'
  - id: operator_check
    command:
      - yy
      - pi
      - |
        Review the daily workflow context for {{ run_date }}.
        Preflight output: {{ steps.preflight.response }}
        Return one concise operator note.
    fail_workflow: false
  - id: archive_note
    capture_session: false
    command: |
      printf 'operator_session={{ steps.operator_check.session_id }}\\n'
summary: |
  # Daily ops summary
  Run date: {{ run_date }}
  Preflight: {{ steps.preflight.status }}
  Operator session: {{ steps.operator_check.session_id }}
""",
    "production-triage-handoff": """schema_version: 1
workflow_id: production_triage_handoff
vars:
  triage_name: prod-triage-{{ run_id }}
steps:
  - id: discover_issues
    capture_session: false
    command: |
      set -eu
      mkdir -p "{{ out_dir }}"
      # Replace this stub with your production detector, but keep the JSONL contract:
      #   ./scripts/discover-production-issues --jsonl > "{{ out_dir }}/issues.jsonl"
      python3 - <<'PY'
      import json
      from pathlib import Path
      out_dir = Path("{{ out_dir }}")
      issues = [
          {"id": "checkout-5xx-spike", "service": "checkout-api", "severity": "P1", "signal": "5xx rate above 4% for 15 minutes", "dashboard": "https://observability.example/checkout-api", "runbook": "docs/runbooks/checkout-api.md"},
          {"id": "worker-lag", "service": "billing-worker", "severity": "P2", "signal": "queue lag above 10000 jobs", "dashboard": "https://observability.example/billing-worker", "runbook": "docs/runbooks/billing-worker.md"},
      ]
      with (out_dir / "issues.jsonl").open("w", encoding="utf-8") as fh:
          for issue in issues:
              fh.write(json.dumps(issue, ensure_ascii=False) + "\\n")
      item_placeholder = f"{chr(123) * 2}item{chr(125) * 2}"
      (out_dir / "triage_prompt.md").write_text(
          "You are taking over one production issue in a dedicated tmux pane.\\n"
          "Keep this pane available for later `yy continue`; do not collapse history.\\n"
          f"Issue JSON: {item_placeholder}\\n\\n"
          "Investigate the service, runbook, likely blast radius, immediate mitigations, and follow-up owners. "
          "Finish with a concise HANDOFF_SUMMARY and preserve any session id/artifact paths you create.\\n",
          encoding="utf-8",
      )
      print(out_dir / "issues.jsonl")
      PY
  - id: start_tmux_handoff
    capture_session: false
    command: |
      set -eu
      ./.juno_task/scripts/parallel_runner.sh \\
        --items-file "{{ out_dir }}/issues.jsonl" \\
        --format jsonl \\
        --prompt-file "{{ out_dir }}/triage_prompt.md" \\
        --tmux panes \\
        --tmux-handoff \\
        --max-panes-per-session 4 \\
        --parallel 4 \\
        --name "{{ triage_name }}" \\
        --output-dir "{{ out_dir }}/parallel"
  - id: handoff_summary
    capture_session: false
    command: |
      set -eu
      summary="{{ out_dir }}/handoff_summary.md"
      {
        printf '# Production triage handoff\\n\\n'
        printf 'Issues: `%s`\\n\\n' "{{ out_dir }}/issues.jsonl"
        printf 'Parallel artifacts: `%s`\\n\\n' "{{ out_dir }}/parallel"
        printf 'Attach with `tmux ls | grep pc-{{ triage_name }}` then `tmux attach -t <session>`.\\n\\n'
        printf 'Latest aggregation files preserve each final agent response, commit metadata, cost, and session id so later review or `yy continue` does not need to reconstruct history from scrollback.\\n\\n'
        find "{{ out_dir }}/parallel" -name 'aggregation_*.json' -print 2>/dev/null | sort || true
      } | tee "$summary"
summary: |
  # Production triage handoff
  Discovery status: {{ steps.discover_issues.status }}
  Handoff status: {{ steps.start_tmux_handoff.status }}
  Summary artifact: {{ out_dir }}/handoff_summary.md
  Parallel artifacts: {{ out_dir }}/parallel
  Attach: tmux ls | grep pc-{{ triage_name }}
""",
    "parallel-kanban-review": """schema_version: 1
workflow_id: parallel_kanban_review
vars:
  review_topic: "Implement the next safe increment"
steps:
  - id: plan_kanban_tasks
    command:
      - yy
      - pi
      - "Plan mode: create the concrete kanban tasks needed for this topic, then print TASK_IDS=<comma-separated-kanban-task-ids>. Topic: {{ review_topic }}. Use ./.juno_task/scripts/kanban.sh as the source of truth. Keep task bodies complete enough for parallel agents."
  - id: resolve_task_ids
    capture_session: false
    command: |
      set -eu
      mkdir -p "{{ out_dir }}"
      cp "{{ steps.plan_kanban_tasks.response_path }}" "{{ out_dir }}/plan_response.txt"
      task_ids=$(python3 - <<'PY'
      import re
      from pathlib import Path
      text = Path("{{ out_dir }}/plan_response.txt").read_text(encoding="utf-8")
      match = re.search(r"^TASK_IDS=([^\\n]+)", text, re.MULTILINE)
      print(match.group(1).strip() if match else "")
      PY
      )
      if [ -z "$task_ids" ]; then
        echo "plan_kanban_tasks must print TASK_IDS=<comma-separated-kanban-task-ids>" >&2
        exit 2
      fi
      printf '%s\\n' "$task_ids" | tee "{{ out_dir }}/kanban_task_ids.txt"
  - id: run_parallel_kanban
    capture_session: false
    command: |
      set -eu
      task_ids=$(cat "{{ out_dir }}/kanban_task_ids.txt")
      python3 - <<'PY'
      from pathlib import Path
      out_dir = Path("{{ out_dir }}")
      task_placeholder = f"{chr(123) * 2}task_id{chr(125) * 2}"
      (out_dir / "kanban_worker_prompt.md").write_text(
          f"Implement exactly kanban task ##{task_placeholder}.\\n"
          "Keep the kanban response current, run focused validation, and ensure final output includes commit hash, changed files, validation commands, and any preserved session id.\\n",
          encoding="utf-8",
      )
      PY
      ./.juno_task/scripts/parallel_runner.sh \\
        --kanban "$task_ids" \\
        --parallel 3 \\
        --prompt-file "{{ out_dir }}/kanban_worker_prompt.md" \\
        --output-dir "{{ out_dir }}/parallel"
  - id: master_review
    capture_session: true
    command: |
      set -eu
      latest=$(find "{{ out_dir }}/parallel" -name 'aggregation_*.json' -print 2>/dev/null | sort | tail -n 1)
      if [ -z "$latest" ]; then
        echo "No aggregation_*.json found under {{ out_dir }}/parallel" >&2
        exit 2
      fi
      yy pi "$(cat <<EOF
      Review the completed parallel kanban batch for topic: {{ review_topic }}.

      Read the latest aggregation artifact at: $latest
      It preserves each worker final response, session id, commit hash, status, and cost so this master review does not need to reconstruct history from raw logs.

      Aggregation JSON:
      $(cat "$latest")

      Produce a concise merge/review plan with: completed tasks, failures needing follow-up, commits to inspect, validation gaps, and recommended next kanban updates.
      EOF
      )"
summary: |
  # Parallel kanban review
  Plan session: {{ steps.plan_kanban_tasks.session_id }}
  Task ids: {{ steps.resolve_task_ids.response }}
  Parallel artifacts: {{ out_dir }}/parallel
  Master review session: {{ steps.master_review.session_id }}
  Master review response: {{ steps.master_review.response }}
""",
}


def iter_template_strings(value: Any, path: str = "") -> list[tuple[str, str]]:
    found: list[tuple[str, str]] = []
    if isinstance(value, str):
        found.append((path or "$", value))
    elif isinstance(value, list):
        for idx, item in enumerate(value):
            found.extend(iter_template_strings(item, f"{path}[{idx}]" if path else f"[{idx}]"))
    elif isinstance(value, dict):
        for key, item in value.items():
            child = f"{path}.{key}" if path else str(key)
            found.extend(iter_template_strings(item, child))
    return found


def workflow_lint_findings(workflow: dict[str, Any]) -> list[dict[str, str]]:
    validate_workflow(workflow)
    agent_steps = {
        str(step["id"])
        for step in workflow.get("steps", [])
        if detect_juno_command(step.get("command"))
    }
    findings: list[dict[str, str]] = []
    steps_by_id = {str(step["id"]): step for step in workflow.get("steps", [])}
    for receipt_id, contract in normalize_receipt_contracts(workflow).items():
        declared_path = str(contract["path"])
        filename = Path(declared_path.replace("{{ out_dir }}", "out")).name
        stem = re.sub(r"[^a-z0-9]+", "_", Path(filename).stem.lower()).strip("_")
        normalized_id = re.sub(r"[^a-z0-9]+", "_", receipt_id.lower()).strip("_")
        if not stem or not normalized_id.endswith(stem):
            continue
        producer = steps_by_id.get(str(contract["producer"]))
        producer_command = (producer or {}).get("command")
        canonical_expression = "receipts." + receipt_id + ".path"
        if any(
            match.group(1).strip() == canonical_expression
            for _, text in iter_template_strings(producer_command)
            for match in TEMPLATE_RE.finditer(text)
        ):
            continue
        for location, text in iter_template_strings(producer_command, f"steps.{contract['producer']}.command"):
            for literal_path in re.findall(r"\{\{\s*out_dir\s*\}\}/[^\s'\"`]+\.json", text):
                normalized_path = re.sub(r"\{\{\s*out_dir\s*\}\}", "{{ out_dir }}", literal_path)
                if Path(normalized_path.replace("{{ out_dir }}", "out")).name == filename and normalized_path != declared_path:
                    findings.append({
                        "level": "error",
                        "code": "CONTRADICTORY_RECEIPT_PATH",
                        "location": location,
                        "message": (
                            f"Producer hardcodes receipt path {normalized_path!r}, but receipt {receipt_id} "
                            f"declares {declared_path!r}; reference {{{{ receipts.{receipt_id}.path }}}} instead."
                        ),
                    })
    for location, text in iter_template_strings(workflow):
        for match in re.finditer(r"steps\.([A-Za-z_][A-Za-z0-9_-]*)\.stderr\b", text):
            findings.append({
                "level": "warn",
                "code": "NOISY_STEP_STDERR_TEMPLATE",
                "location": location,
                "message": f"Template references steps.{match.group(1)}.stderr; keep stderr as an artifact and include it only for failure debugging.",
            })
        for match in re.finditer(r"steps\.([A-Za-z_][A-Za-z0-9_-]*)\.stdout\b", text):
            step_id = match.group(1)
            if step_id in agent_steps:
                findings.append({
                    "level": "warn",
                    "code": "AGENT_STDOUT_TEMPLATE",
                    "location": location,
                    "message": f"Template references steps.{step_id}.stdout for an agent step; use steps.{step_id}.response for the final answer.",
                })
    return findings


def print_findings(title: str, findings: list[dict[str, str]]) -> None:
    print(title)
    if not findings:
        print("OK: no issues found")
        return
    for item in findings:
        print(f"{item['level'].upper()} {item['code']} at {item['location']}: {item['message']}")


def run_lint_command(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="workflow_runner.sh lint",
        description="Lint workflow YAML for response/log anti-patterns before running it.",
        epilog="""Checks:
  - summary/step templates should use steps.<id>.response for agent final answers
  - steps.<id>.stderr should not be injected into prompts/summaries by default
  - producer paths that contradict an identifiable declared receipt are rejected
  - YAML/schema validation is performed using the same parser as workflow execution

Examples:
  workflow_runner.sh lint --workflow .juno_task/workflows/daily_product_ops.yaml
  cat workflow.yaml | workflow_runner.sh lint --workflow -
""",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--workflow", "-w", required=True, help="Workflow YAML path, or '-' to read from stdin")
    parser.add_argument("--json", action="store_true", help="Emit findings as JSON")
    args = parser.parse_args(argv)
    workflow_text = sys.stdin.read() if args.workflow == "-" else Path(args.workflow).read_text(encoding="utf-8")
    workflow = parse_yaml_like(workflow_text)
    findings = workflow_lint_findings(workflow)
    if args.json:
        print(json.dumps({"status": "ok" if not findings else "issues", "findings": findings}, indent=2))
    else:
        print_findings("Workflow lint", findings)
    return 0 if not findings else 1


def file_size(path_text: str | None) -> int | None:
    if not path_text:
        return None
    try:
        return Path(path_text).stat().st_size
    except OSError:
        return None


def command_has_quiet(command: Any) -> bool:
    parts = command_argv(command)
    return any(part in {"--quiet", "--silent", "-q"} for part in parts[1:])


def doctor_findings(run_dir: Path) -> list[dict[str, str]]:
    manifest_path = run_dir / "manifest.json"
    findings: list[dict[str, str]] = []
    if not manifest_path.exists():
        return [{"level": "error", "code": "MISSING_MANIFEST", "location": str(manifest_path), "message": "manifest.json not found in run directory."}]
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception as exc:
        return [{"level": "error", "code": "INVALID_MANIFEST", "location": str(manifest_path), "message": f"Cannot parse manifest.json: {exc}"}]
    steps = manifest.get("steps")
    if not isinstance(steps, list):
        return [{"level": "error", "code": "INVALID_MANIFEST_STEPS", "location": str(manifest_path), "message": "manifest.steps must be a list."}]
    for idx, step in enumerate(steps, start=1):
        if not isinstance(step, dict):
            continue
        step_id = str(step.get("id") or f"step-{idx}")
        location = f"steps[{idx}].{step_id}"
        command = step.get("command")
        is_agent = detect_juno_command(command)
        status = str(step.get("status") or "")
        response_size = file_size(step.get("response_path"))
        stdout_size = file_size(step.get("stdout_path"))
        stderr_size = file_size(step.get("stderr_path"))
        for field in ("stdout_path", "stderr_path", "response_path"):
            path_text = step.get(field)
            if path_text and not Path(path_text).exists():
                findings.append({"level": "error", "code": "MISSING_ARTIFACT", "location": f"{location}.{field}", "message": f"Artifact path does not exist: {path_text}"})
        if is_agent and command_has_quiet(command):
            findings.append({"level": "warn", "code": "AGENT_QUIET_ARG", "location": location, "message": "Detected agent command includes --quiet/--silent/-q; this can suppress final response in workflow contexts."})
        if is_agent and status == "success" and (response_size == 0 or response_size is None):
            findings.append({"level": "error", "code": "EMPTY_SUCCESS_AGENT_RESPONSE", "location": location, "message": "Agent step is marked success but response artifact is empty/missing; this should be a failure."})
        if status == "success" and stderr_size and stderr_size > 0:
            findings.append({"level": "info", "code": "SUCCESS_STDERR_ARTIFACT", "location": location, "message": f"Successful step has stderr artifact ({stderr_size} bytes); keep it out of summaries unless debugging failures."})
        if is_agent and stdout_size == 0 and response_size == 0:
            findings.append({"level": "warn", "code": "EMPTY_AGENT_STDOUT_RESPONSE", "location": location, "message": "Agent stdout and response are empty; inspect command flags, provider output mode, and stderr artifact."})
    return findings


def run_doctor_command(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="workflow_runner.sh doctor",
        description="Inspect a workflow run directory and diagnose response/output artifact problems.",
        epilog="""Checks:
  - manifest and artifact paths exist
  - detected agent steps do not have successful empty responses
  - agent commands are not accidentally quieted
  - successful stderr is identified as log/audit noise, not summary input

Aliases:
  workflow_runner.sh dr ...

Examples:
  workflow_runner.sh doctor .juno_task/specs/workflows/daily_product_ops/20260706_064333_251873Z
  workflow_runner.sh dr --json /tmp/workflow-run
""",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("run_dir", help="Workflow run artifact directory containing manifest.json")
    parser.add_argument("--json", action="store_true", help="Emit findings as JSON")
    args = parser.parse_args(argv)
    findings = doctor_findings(Path(args.run_dir).resolve())
    if args.json:
        print(json.dumps({"status": "ok" if not any(f["level"] == "error" for f in findings) else "issues", "findings": findings}, indent=2))
    else:
        print_findings("Workflow doctor", findings)
    return 0 if not any(f["level"] == "error" for f in findings) else 1


def init_example(example_args: list[str], force: bool) -> Path:
    if len(example_args) != 2:
        names = ", ".join(sorted(EXAMPLE_WORKFLOWS))
        raise WorkflowError(f"--init-example requires <name> <path>; available examples: {names}")
    name, target_text = example_args
    if name not in EXAMPLE_WORKFLOWS:
        names = ", ".join(sorted(EXAMPLE_WORKFLOWS))
        raise WorkflowError(f"unknown example '{name}'. Available examples: {names}")
    target = Path(target_text).resolve()
    if target.exists() and not force:
        raise WorkflowError(f"refusing to overwrite existing workflow: {target} (pass --force to replace)")
    write_text(target, EXAMPLE_WORKFLOWS[name])
    return target


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run an ordered YAML workflow from the project root",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""Workflow behavior:
  Commands execute from --run-root/--project-root (default: current directory).
  Step failures continue and final process exit is 0 by default.
  Set fail_workflow: true on a step to make that failed command fail the workflow process.
  juno-code, yy, and ypl commands automatically receive JUNO_TOOL_ID and
  JUNO_SUBAGENT_CAPTURE_PATH so steps.<id>.session_id can be used by later steps.
  The runner does not inject --quiet; agent stdout is the canonical response while
  stderr is kept as an artifact and printed only when the step fails.
  Detected agent commands that exit 0 with an empty response are marked failed.
  At the end, juno-code/yy/ypl step and summary.command session IDs are listed;
  the final successful agent command is persisted so `yy cc` continues it in the same shell scope.
  Set top-level continue_from_step: <step-id-or-name-or-summary> to persist a specific agent command;
  explicit continue_from_step is strict and fails if that command has no session id.
  Disable capture env per step/summary command with capture_session: false (or capture: false).
  Each run directory owns an immutable run_contract.json. --from-step verifies the
  original workflow, variables, commands, frozen_inputs, typed receipts, and reused
  predecessor artifacts. A harness-only correction uses a fresh out-dir,
  amendment_mode: harness_only_validation, --amends-run PRIOR_RUN, and optionally
  --from-step STEP to revalidate/import the successful prefix before executing only
  the requested suffix. Failed or changed predecessor steps are never reused.
  Receipt paths are available as {{ receipts.<id>.path }} and as
  JUNO_WORKFLOW_RECEIPT_<ID>. Receipt producers receive JUNO_WORKFLOW_STEP_ID and JUNO_WORKFLOW_STEP_DIGEST;
  every receipt required_fields list explicitly includes producer_step_digest.
  Declare terminal_gate for semantic summaries. schema_version: 2 local_integration workflows declare
  pre_merge_review, candidate_review, and receipt-gated actual_target_review owners,
  plus the exact automatic queue/channel/rebuild integration_policy.

Helper commands:
  workflow_runner.sh lint --workflow WORKFLOW.yaml     # flag response/log template anti-patterns
  workflow_runner.sh doctor RUN_DIR                    # inspect manifest/artifacts from a run
  workflow_runner.sh dr RUN_DIR                        # short alias for doctor

Example boilerplates (written only when explicitly requested):
  workflow_runner.sh --init-example agent-chain .juno_task/workflows/agent_chain.yaml
  workflow_runner.sh --init-example command-pipeline .juno_task/workflows/command_pipeline.yaml
  workflow_runner.sh --init-example daily-ops .juno_task/workflows/daily_ops.yaml
  workflow_runner.sh --init-example production-triage-handoff .juno_task/workflows/production_triage_handoff.yaml
  workflow_runner.sh --init-example parallel-kanban-review .juno_task/workflows/parallel_kanban_review.yaml

  production-triage-handoff writes safe sample JSONL, then invokes parallel_runner.sh
  with --tmux panes --tmux-handoff --max-panes-per-session 4 and a fixed
  {{ out_dir }}/parallel artifact root. parallel-kanban-review shows plan-created
  kanban tasks flowing through fixed-output parallel execution into a master review
  step. Both preserve final responses and session ids in artifacts so review and
  yy continue handoff do not depend on tmux scrollback.
""",
    )
    parser.add_argument("--workflow", "-w", help="Workflow YAML path, or '-' to read from stdin")
    parser.add_argument(
        "--run-root",
        "--project-root",
        dest="project_root",
        default=os.getcwd(),
        help="Directory where commands execute (default: current directory)",
    )
    parser.add_argument("--out-dir", help="Artifact directory (default: .juno_task/specs/workflows/<workflow_id>/<run_id>)")
    parser.add_argument("--var", dest="vars", action="append", default=[], metavar="NAME=VALUE", help="Template variable override in NAME=VALUE form")
    parser.add_argument("--dry-run", action="store_true", help="Render commands and write artifacts without executing steps")
    parser.add_argument("--from-step", help="Start at zero-based step index, step id/name, or -1 for the last step")
    parser.add_argument("--amends-run", help="Start a fresh harness-only run linked to a prior run; combine with --from-step to revalidate/import its successful prefix")
    parser.add_argument("--print-step-stdout", dest="print_step_stdout", action="store_true", default=True, help="Print each step response/stdout as it completes (default); successful stderr stays in artifacts")
    parser.add_argument("--no-print-step-stdout", dest="print_step_stdout", action="store_false", help="Do not echo per-step response/stdout to the console; artifacts are still written")
    parser.add_argument("--tmux", action="store_true", help="Create a dedicated detached tmux observer that follows live step stdout/stderr and remains available for review")
    parser.add_argument("--tmux-session", help="Observer session name (requires --tmux; default is derived from workflow/run id)")
    parser.add_argument(
        "--print-output",
        "--final-output",
        dest="print_output",
        default="summary",
        help="Final console output: summary, none, <step_id>, or step:<step_id>",
    )
    parser.add_argument(
        "--init-example",
        nargs=2,
        metavar=("NAME", "PATH"),
        help="Write a built-in example workflow YAML (agent-chain, command-pipeline, daily-ops, production-triage-handoff, parallel-kanban-review) to PATH and exit",
    )
    parser.add_argument("--force", action="store_true", help="Allow --init-example to overwrite an existing file")
    return parser


def resolve_session_metadata_directory(controller_root: str) -> str:
    override = os.environ.get("JUNO_CODE_SESSION_METADATA_DIRECTORY", "").strip()
    if override:
        candidate = Path(override)
        return str(candidate if candidate.is_absolute() else (Path(controller_root) / candidate).resolve())
    completed = subprocess.run(
        ["git", "-C", controller_root, "rev-parse", "--path-format=absolute", "--git-common-dir"],
        text=True, capture_output=True,
    )
    if completed.returncode == 0 and completed.stdout.strip():
        return str(Path(completed.stdout.strip()).resolve() / "juno" / "session_metadata")
    identity = hashlib.sha256(str(Path(controller_root).resolve()).encode()).hexdigest()[:16]
    state_home = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state"))
    return str(state_home / "juno-code" / "session_metadata" / identity)


def resolve_controller_environment() -> dict[str, str]:
    resolver = Path(__file__).resolve().with_name("controller_resolver.py")
    if not resolver.is_file():
        resolver = next(
            (parent / ".juno_task/scripts/controller_resolver.py" for parent in (Path.cwd(), *Path.cwd().parents)
             if (parent / ".juno_task/scripts/controller_resolver.py").is_file()),
            resolver,
        )
    completed = subprocess.run(
        [sys.executable, str(resolver), "--cwd", os.getcwd(), "--operation", "orchestration"],
        text=True, capture_output=True, check=True,
    )
    resolution = json.loads(completed.stdout)
    controller_root = str(resolution["path"])
    return {
        "JUNO_TASK_ROOT": controller_root,
        "JUNO_CONTROLLER_SOURCE": resolution["source"],
        "JUNO_WORKSPACE_ROLE": resolution["role"],
        "JUNO_CODE_SESSION_METADATA_DIRECTORY": resolve_session_metadata_directory(controller_root),
    }


def checkpoint_after_finalization(exit_code: int, owner: str) -> None:
    """Best effort only; never replace the owning runner's status."""
    if os.environ.get("JUNO_CONTROLLER_CHECKPOINT_ACTIVE") == "1":
        return
    root = Path(os.environ["JUNO_TASK_ROOT"]).resolve()
    script = root / ".juno_task/scripts/controller_checkpoint.py"
    if not script.is_file():
        return
    message = f"chore(controller): checkpoint finalized {owner} state"
    if exit_code:
        message = f"chore(controller): checkpoint failed {owner} state (exit {exit_code})"
    env = child_process_environment(dict(os.environ))
    env["JUNO_CONTROLLER_CHECKPOINT_ACTIVE"] = "1"
    try:
        subprocess.run(
            [sys.executable, str(script), "--root", str(root), "commit", "--message", message],
            cwd=root, env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True,
            timeout=30, check=True,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        print(
            f"workflow_runner.sh: WARNING: controller checkpoint failed after finalization; "
            f"run {script} --root {root} commit manually: {exc}", file=sys.stderr,
        )


def main(argv: list[str] | None = None) -> int:
    sanitize_current_process_environment()
    controller_env = resolve_controller_environment()
    try:
        ensure_controller_python_environment(controller_env)
    except WorkflowError as exc:
        print(f"workflow_runner.sh: error: {exc}", file=sys.stderr)
        return 2
    warn_if_runtime_script_is_stale("workflow_runner.sh")
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] == "lint":
        try:
            return run_lint_command(argv[1:])
        except WorkflowError as exc:
            print(f"workflow_runner.sh lint: error: {exc}", file=sys.stderr)
            return 2
    if argv and argv[0] in {"doctor", "dr"}:
        try:
            return run_doctor_command(argv[1:])
        except WorkflowError as exc:
            print(f"workflow_runner.sh doctor: error: {exc}", file=sys.stderr)
            return 2
    parser = build_parser()
    args = parser.parse_args(argv)
    exit_code = 0
    try:
        exit_code = run_workflow(args)
    except WorkflowError as exc:
        print(f"workflow_runner.sh: error: {exc}", file=sys.stderr)
        exit_code = 2
    except BaseException:
        exit_code = 1
        raise
    finally:
        # run_workflow has returned or failed only after its terminal manifest,
        # receipts, summary, and continuation metadata writes.
        checkpoint_after_finalization(exit_code, "workflow")
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
