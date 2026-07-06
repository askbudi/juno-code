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
ANSI_RESET = "\033[0m"
STEP_COLORS = [196, 39, 208, 35, 201, 220, 27, 118, 163, 45, 214, 99]


class WorkflowError(Exception):
    pass


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


def has_juno_output_flag(parts: list[str]) -> bool:
    return any(part in {"--quiet", "--silent", "-q", "--verbose", "-v"} or part.startswith("--verbose=") for part in parts[1:])


def apply_workflow_juno_defaults(command: Any) -> Any:
    """Make non-live juno-code workflow steps emit final answers, not progress logs."""
    if not isinstance(command, list):
        return command
    parts = [str(part) for part in command]
    executable = Path(parts[0]).name if parts else ""
    if executable not in {"juno-code", "yy"}:
        return command
    if has_juno_output_flag(parts) or "--live" in parts:
        return command
    return [parts[0], "--quiet", *parts[1:]]


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


def execute_rendered_command(command: Any, project_root: Path, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    if isinstance(command, list):
        return subprocess.run(
            [str(part) for part in command],
            shell=False,
            cwd=str(project_root),
            text=True,
            capture_output=True,
            env=env,
        )
    return subprocess.run(str(command), shell=True, cwd=str(project_root), text=True, capture_output=True, env=env)


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
    workflow: dict[str, Any], context: dict[str, Any], project_root: Path, out_dir: Path, dry_run: bool
) -> tuple[str, str, int, Any | None]:
    explicit = workflow.get("summary")
    if not isinstance(explicit, dict) or "command" not in explicit:
        write_text(out_dir / "summary.stdout.txt", "")
        write_text(out_dir / "summary.stderr.txt", "")
        return "", "", 0, None
    command = render(explicit["command"], context)
    write_text(out_dir / "summary.command.sh", command_preview(command) + "\n")
    if dry_run:
        stdout = ""
        stderr = ""
        exit_code = 0
    else:
        proc = execute_rendered_command(command, project_root, os.environ.copy())
        stdout = proc.stdout or ""
        stderr = proc.stderr or ""
        exit_code = int(proc.returncode)
    write_text(out_dir / "summary.stdout.txt", stdout)
    write_text(out_dir / "summary.stderr.txt", stderr)
    return stdout, stderr, exit_code, command


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
    start_index = resolve_from_step(workflow["steps"], args.from_step)
    manifest["from_step"] = args.from_step
    manifest["from_step_index"] = start_index
    for index, step in enumerate(workflow["steps"], start=1):
        step_id = str(step["id"])
        if index - 1 < start_index:
            skipped_result: dict[str, Any] = {
                "id": step_id,
                "command": render(step["command"], context),
                "command_preview": command_preview(render(step["command"], context)),
                "status": "skipped",
                "exit_code": None,
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
            manifest["steps"].append({k: v for k, v in skipped_result.items() if k not in {"stdout", "stderr"}})
            continue
        command = apply_workflow_juno_defaults(render(step["command"], context))
        preview = command_preview(command)
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
        started = time.monotonic()
        stdout = ""
        stderr = ""
        exit_code = 0
        capture_warning: str | None = None
        if args.dry_run:
            status = "dry_run"
        else:
            env = os.environ.copy()
            if capture_enabled:
                env["JUNO_TOOL_ID"] = f"workflow_{step_slug}"
                env["JUNO_SUBAGENT_CAPTURE_PATH"] = str(capture_path)
            else:
                env.pop("JUNO_TOOL_ID", None)
                env.pop("JUNO_SUBAGENT_CAPTURE_PATH", None)
            proc = execute_rendered_command(command, project_root, env)
            stdout = proc.stdout or ""
            stderr = proc.stderr or ""
            exit_code = int(proc.returncode)
            status = "success" if exit_code == 0 else "failed"
            if stderr:
                print(stderr, file=sys.stderr, end="" if stderr.endswith("\n") else "\n")
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
        }
        if capture_enabled and not args.dry_run:
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
                    result["response"] = capture_result
            elif not capture_path.exists():
                session_id = extract_session_id(stdout, stderr)
                if session_id:
                    result["session_id"] = session_id
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
        if status == "failed":
            manifest["failed_steps"].append(step_id)
            manifest["status"] = "failed"
            if step_should_fail_process(step):
                final_exit = exit_code or 1
                break

    summary_stdout, summary_stderr, summary_exit, summary_command = maybe_run_summary_command(
        workflow, context, project_root, out_dir, bool(args.dry_run)
    )
    summary = (
        summary_stdout.rstrip() + "\n"
        if summary_stdout
        else make_summary(workflow, context, manifest["failed_steps"], bool(args.dry_run))
    )
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
}


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
  Disable that per step with capture_session: false (or capture: false).

Example boilerplates (written only when explicitly requested):
  workflow_runner.sh --init-example agent-chain .juno_task/workflows/agent_chain.yaml
  workflow_runner.sh --init-example command-pipeline .juno_task/workflows/command_pipeline.yaml
  workflow_runner.sh --init-example daily-ops .juno_task/workflows/daily_ops.yaml
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
    parser.add_argument("--print-step-stdout", dest="print_step_stdout", action="store_true", default=True, help="Print each step stdout as it completes (default)")
    parser.add_argument("--no-print-step-stdout", dest="print_step_stdout", action="store_false", help="Do not echo per-step stdout to the console; artifacts are still written")
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
        help="Write a built-in example workflow YAML (agent-chain, command-pipeline, daily-ops) to PATH and exit",
    )
    parser.add_argument("--force", action="store_true", help="Allow --init-example to overwrite an existing file")
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
