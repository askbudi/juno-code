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
import json
import os
import re
import shlex
import subprocess
import sys
import time
from pathlib import Path
from typing import Any


JUNO_COMMANDS = {"juno-code", "yy", "ypl"}
TEMPLATE_RE = re.compile(r"{{\s*([^}]+?)\s*}}")
SAFE_ID_RE = re.compile(r"[^A-Za-z0-9_.-]+")


class WorkflowError(Exception):
    pass


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
    if "schema_version" in workflow and str(workflow["schema_version"]).strip() not in {"1", "1.0", "v1"}:
        raise WorkflowError(f"unsupported schema_version: {workflow['schema_version']}")
    steps = workflow.get("steps")
    if not isinstance(steps, list) or not steps:
        raise WorkflowError("workflow must define a non-empty steps list")
    if "summary" in workflow and not isinstance(workflow["summary"], (str, dict, type(None))):
        raise WorkflowError("summary must be a string, mapping, or null")
    seen: set[str] = set()
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
        if "command" not in step:
            raise WorkflowError(f"step {step_id} is missing required command")


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


def detect_juno_command(command: str) -> bool:
    try:
        parts = shlex.split(command, posix=True)
    except ValueError:
        parts = command.strip().split()
    if not parts:
        return False
    executable = Path(parts[0]).name
    return executable in JUNO_COMMANDS


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


def step_capture_enabled(step: dict[str, Any], command: str) -> bool:
    if "capture" in step:
        return bool(step.get("capture"))
    if "capture_session" in step:
        return bool(step.get("capture_session"))
    return detect_juno_command(command)


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


def maybe_run_summary_command(
    workflow: dict[str, Any], context: dict[str, Any], project_root: Path, out_dir: Path, dry_run: bool
) -> tuple[str, str, int, str | None]:
    explicit = workflow.get("summary")
    if not isinstance(explicit, dict) or "command" not in explicit:
        write_text(out_dir / "summary.stdout.txt", "")
        write_text(out_dir / "summary.stderr.txt", "")
        return "", "", 0, None
    command = str(render(explicit["command"], context))
    write_text(out_dir / "summary.command.sh", command + "\n")
    if dry_run:
        stdout = ""
        stderr = ""
        exit_code = 0
    else:
        proc = subprocess.run(command, shell=True, cwd=str(project_root), text=True, capture_output=True)
        stdout = proc.stdout or ""
        stderr = proc.stderr or ""
        exit_code = int(proc.returncode)
    write_text(out_dir / "summary.stdout.txt", stdout)
    write_text(out_dir / "summary.stderr.txt", stderr)
    return stdout, stderr, exit_code, command


def selected_final_output(print_output: str, context: dict[str, Any], summary: str) -> str:
    if print_output == "summary":
        return summary
    if print_output == "none":
        return ""
    selected = print_output.split(":", 1)[1] if print_output.startswith("step:") else print_output
    result = context["steps"].get(selected)
    if result is None:
        raise WorkflowError(f"unknown --print-output step: {selected}")
    return str(result.get("stdout", ""))


def run_workflow(args: argparse.Namespace) -> int:
    project_root = Path(args.project_root or os.getcwd()).resolve()
    if args.init_example:
        target = Path(args.init_example).resolve()
        write_text(target, EXAMPLE_WORKFLOW)
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
    for key, value in workflow_vars.items():
        if isinstance(key, str) and key not in context:
            context[key] = value

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
    }

    final_exit = 0
    for index, step in enumerate(workflow["steps"], start=1):
        step_id = str(step["id"])
        command = str(render(step["command"], context))
        capture_enabled = step_capture_enabled(step, command)
        step_slug = safe_id(step_id, f"step-{index}")
        stdout_path = out_dir / f"{index:03d}_{step_slug}.stdout.txt"
        stderr_path = out_dir / f"{index:03d}_{step_slug}.stderr.txt"
        capture_path = out_dir / f"{index:03d}_{step_slug}.capture.json"
        legacy_step_dir = out_dir / "steps" / step_id
        write_text(legacy_step_dir / "command.sh", command + "\n")
        print(f"\n==> Step {index}: {step_id}")
        print(command)
        started = time.monotonic()
        stdout = ""
        stderr = ""
        exit_code = 0
        if args.dry_run:
            status = "dry_run"
        else:
            proc = subprocess.run(command, shell=True, cwd=str(project_root), text=True, capture_output=True)
            stdout = proc.stdout or ""
            stderr = proc.stderr or ""
            exit_code = int(proc.returncode)
            status = "success" if exit_code == 0 else "failed"
            if args.print_step_stdout and stdout:
                print(stdout, end="" if stdout.endswith("\n") else "\n")
            if stderr:
                print(stderr, file=sys.stderr, end="" if stderr.endswith("\n") else "\n")
        duration = round(time.monotonic() - started, 3)
        write_text(stdout_path, stdout)
        write_text(stderr_path, stderr)
        write_text(legacy_step_dir / "stdout.txt", stdout)
        write_text(legacy_step_dir / "stderr.txt", stderr)
        result: dict[str, Any] = {
            "id": step_id,
            "command": command,
            "status": status,
            "exit_code": exit_code,
            "duration_seconds": duration,
            "stdout": stdout,
            "stderr": stderr,
            "stdout_path": str(stdout_path),
            "stderr_path": str(stderr_path),
            "capture_enabled": capture_enabled,
            "capture_json": str(capture_path) if capture_enabled else "",
            "capture_json_path": str(capture_path) if capture_enabled else "",
            "session_id": None,
        }
        if capture_enabled:
            session_id = extract_session_id(stdout, stderr)
            capture_payload = {"session_id": session_id, "exit_code": exit_code, "status": status}
            write_text(capture_path, json.dumps(capture_payload, indent=2) + "\n")
            result["session_id"] = session_id
        context["steps"][step_id] = result
        manifest["steps"].append({k: v for k, v in result.items() if k not in {"stdout", "stderr"}})
        print(f"<== Step {step_id} {status} in {duration:.3f}s (exit {exit_code})")
        if status == "failed":
            manifest["failed_steps"].append(step_id)
            manifest["status"] = "failed"
            if step_should_fail_process(step):
                final_exit = exit_code or 1
                break

    summary_stdout, summary_stderr, summary_exit, summary_command = maybe_run_summary_command(
        workflow, context, project_root, out_dir, bool(args.dry_run)
    )
    summary = make_summary(workflow, context, manifest["failed_steps"], bool(args.dry_run))
    write_text(out_dir / "summary.md", summary)
    manifest["summary_path"] = str(out_dir / "summary.md")
    manifest["summary"] = {
        "stdout_path": str(out_dir / "summary.stdout.txt"),
        "stderr_path": str(out_dir / "summary.stderr.txt"),
        "exit_code": summary_exit,
        "command": summary_command,
    }
    if summary_stdout:
        manifest["summary"]["stdout"] = summary_stdout
    if summary_stderr:
        manifest["summary"]["stderr"] = summary_stderr
    write_text(out_dir / "manifest.json", json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    write_text(out_dir / "manifest.yaml", workflow_to_yaml(manifest) + "\n")

    output = selected_final_output(args.print_output, context, summary)
    if output:
        print("\n" + output, end="" if output.endswith("\n") else "\n")
    return final_exit


EXAMPLE_WORKFLOW = """schema_version: 1
workflow_id: example-workflow
vars:
  subject: juno workflow runner
steps:
  - id: hello
    command: |
      printf 'Hello from {{ vars.subject }} on {{ today_utc }}\\n'
  - id: summarize
    command: |
      printf 'Prior stdout was: {{ steps.hello.stdout }}\\n'
  - id: optional_failure
    command: exit 2
    fail_workflow: false
summary: |
  # Example summary
  Workflow {{ workflow_id }} run {{ run_id }}
  First step status: {{ steps.hello.status }}
  Optional failure status: {{ steps.optional_failure.status }}
"""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run an ordered YAML workflow from the project root",
        epilog="Per-step fail_workflow: true makes a failed command fail the workflow process; failures continue and final exit is 0 by default.",
    )
    parser.add_argument("--workflow", "-w", help="Workflow YAML path, or '-' to read from stdin")
    parser.add_argument("--project-root", default=os.getcwd(), help="Directory where commands execute")
    parser.add_argument("--out-dir", help="Artifact directory (default: .juno_task/specs/workflows/<workflow_id>/<run_id>)")
    parser.add_argument("--var", dest="vars", action="append", default=[], help="Template variable override in key=value form")
    parser.add_argument("--dry-run", action="store_true", help="Render commands and write artifacts without executing steps")
    parser.add_argument("--print-step-stdout", dest="print_step_stdout", action="store_true", default=True)
    parser.add_argument("--no-print-step-stdout", dest="print_step_stdout", action="store_false")
    parser.add_argument(
        "--print-output",
        "--final-output",
        dest="print_output",
        default="summary",
        help="Final console output: summary, none, <step_id>, or step:<step_id>",
    )
    parser.add_argument("--init-example", metavar="PATH", help="Write an example workflow YAML and exit")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return run_workflow(args)
    except WorkflowError as exc:
        print(f"workflow_runner.sh: error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
