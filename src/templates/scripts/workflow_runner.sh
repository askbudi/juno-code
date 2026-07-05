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


def parse_yaml_like(text: str) -> dict[str, Any]:
    """Parse the small, documented workflow YAML subset without external deps.

    JSON is accepted because it is valid YAML. If PyYAML is installed we use it;
    otherwise this parser handles mappings, `steps:` lists, scalar fields, and
    literal blocks (`|`) used by workflow command/summary examples.
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

    def count_indent(line: str) -> int:
        return len(line) - len(line.lstrip(" "))

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
                        i += 1
                        block_lines: list[str] = []
                        block_indent: int | None = None
                        while i < len(lines):
                            block = lines[i]
                            if not block.strip():
                                block_lines.append("")
                                i += 1
                                continue
                            current_indent = count_indent(block)
                            if current_indent <= child_indent:
                                break
                            if block_indent is None:
                                block_indent = current_indent
                            block_lines.append(block[min(block_indent, len(block)) :])
                            i += 1
                        item[k] = "\n".join(block_lines).rstrip("\n")
                        continue
                    item[k] = parse_scalar(v)
                    i += 1
                steps.append(item)
            root[key] = steps
            continue

        # nested mapping such as vars:
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
            nested[k.strip()] = parse_scalar(v.strip())
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


def validate_workflow(workflow: dict[str, Any]) -> None:
    steps = workflow.get("steps")
    if not isinstance(steps, list) or not steps:
        raise WorkflowError("workflow must define a non-empty steps list")
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
                lines.append(workflow_to_yaml(value, indent + 2))
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


def step_should_fail_process(step: dict[str, Any]) -> bool:
    for key in ("fail_on_error", "exit_on_failure", "fail_fast"):
        if bool(step.get(key, False)):
            return True
    return False


def make_summary(workflow: dict[str, Any], context: dict[str, Any], failed_steps: list[str], dry_run: bool) -> str:
    explicit = workflow.get("summary")
    if isinstance(explicit, str) and explicit.strip():
        rendered = render(explicit, context)
        return str(rendered).rstrip() + "\n"
    lines = ["# Workflow Summary", ""]
    lines.append(f"Workflow: {workflow.get('name', 'unnamed')}")
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
    else:
        workflow_text = Path(args.workflow).read_text(encoding="utf-8")
    workflow = parse_yaml_like(workflow_text)
    validate_workflow(workflow)

    run_id = _dt.datetime.now().strftime("%Y%m%d_%H%M%S")
    out_dir = Path(args.out_dir).resolve() if args.out_dir else project_root / ".juno_task" / "workflow_runs" / run_id
    steps_dir = out_dir / "steps"
    steps_dir.mkdir(parents=True, exist_ok=True)

    context: dict[str, Any] = {
        "workflow": {"name": workflow.get("name", "unnamed"), "out_dir": str(out_dir), "project_root": str(project_root)},
        "vars": workflow.get("vars") if isinstance(workflow.get("vars"), dict) else {},
        "steps": {},
    }
    manifest: dict[str, Any] = {
        "workflow": context["workflow"],
        "dry_run": bool(args.dry_run),
        "project_root": str(project_root),
        "out_dir": str(out_dir),
        "steps": [],
        "failed_steps": [],
        "status": "success",
    }

    final_exit = 0
    for step in workflow["steps"]:
        step_id = str(step["id"])
        command = str(render(step["command"], context))
        capture_enabled = bool(step.get("capture", detect_juno_command(command)))
        step_dir = steps_dir / step_id
        step_dir.mkdir(parents=True, exist_ok=True)
        write_text(step_dir / "command.sh", command + "\n")
        print(f"\n==> {step_id}")
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
        stdout_path = step_dir / "stdout.txt"
        stderr_path = step_dir / "stderr.txt"
        write_text(stdout_path, stdout)
        write_text(stderr_path, stderr)
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
        }
        if capture_enabled:
            capture_path = step_dir / "capture.json"
            session_id = extract_session_id(stdout, stderr)
            capture_payload = {"session_id": session_id, "exit_code": exit_code, "status": status}
            write_text(capture_path, json.dumps(capture_payload, indent=2) + "\n")
            result["capture_json_path"] = str(capture_path)
            result["session_id"] = session_id
        context["steps"][step_id] = result
        manifest["steps"].append({k: v for k, v in result.items() if k not in {"stdout", "stderr"}})
        if status == "failed":
            manifest["failed_steps"].append(step_id)
            manifest["status"] = "failed"
            if step_should_fail_process(step):
                final_exit = exit_code or 1
                break

    summary = make_summary(workflow, context, manifest["failed_steps"], bool(args.dry_run))
    write_text(out_dir / "summary.md", summary)
    manifest["summary_path"] = str(out_dir / "summary.md")
    write_text(out_dir / "manifest.json", json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    write_text(out_dir / "manifest.yaml", workflow_to_yaml(manifest) + "\n")

    if args.final_output == "summary":
        print("\n" + summary, end="")
    elif args.final_output.startswith("step:"):
        selected = args.final_output.split(":", 1)[1]
        result = context["steps"].get(selected)
        if result:
            print(result.get("stdout", ""), end="")
    elif args.final_output != "none":
        raise WorkflowError(f"unsupported --final-output value: {args.final_output}")
    return final_exit


EXAMPLE_WORKFLOW = """name: example-workflow
vars:
  subject: juno workflow runner
steps:
  - id: hello
    command: |
      printf 'Hello from {{ vars.subject }}\\n'
  - id: summarize
    command: |
      printf 'Prior stdout was: {{ steps.hello.stdout }}\\n'
summary: |
  # Example summary
  First step status: {{ steps.hello.status }}
"""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run an ordered YAML workflow from the project root")
    parser.add_argument("--workflow", "-w", help="Workflow YAML path, or '-' to read from stdin")
    parser.add_argument("--project-root", default=os.getcwd(), help="Directory where commands execute")
    parser.add_argument("--out-dir", help="Artifact directory (default: .juno_task/workflow_runs/<timestamp>)")
    parser.add_argument("--dry-run", action="store_true", help="Render commands and write artifacts without executing steps")
    parser.add_argument("--print-step-stdout", dest="print_step_stdout", action="store_true", default=True)
    parser.add_argument("--no-print-step-stdout", dest="print_step_stdout", action="store_false")
    parser.add_argument("--final-output", default="summary", help="summary, none, or step:<id>")
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
