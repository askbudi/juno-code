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
import time
from pathlib import Path
from typing import Any


JUNO_COMMANDS = {"juno-code", "yy", "ypl"}
TEMPLATE_RE = re.compile(r"{{\s*([^}]+?)\s*}}")
SAFE_ID_RE = re.compile(r"[^A-Za-z0-9_.-]+")
CONTINUE_SESSION_ENV_KEY_BASE = "JUNO_CODE_LAST_SESSION_ID"
CONTINUE_SETTINGS_ENV_KEY_BASE = "JUNO_CODE_LAST_EXECUTION_SETTINGS"
CONTINUE_SCOPE_OVERRIDE_ENV_KEY = "JUNO_CODE_CONTINUE_SCOPE"
CONTINUE_SCOPE_ENV_MARKERS = [
    "TMUX_PANE",
    "WEZTERM_PANE",
    "KITTY_WINDOW_ID",
    "KITTY_PID",
    "TERM_SESSION_ID",
    "WT_SESSION",
    "ZELLIJ_PANE_ID",
    "STY",
    "WINDOWID",
    "SSH_TTY",
]
ANSI_RESET = "\033[0m"
STEP_COLORS = [196, 39, 208, 35, 201, 220, 27, 118, 163, 45, 214, 99]

STALE_CHECK_ENV = "JUNO_CODE_SKIP_SCRIPT_STALE_CHECK"
TEMPLATE_DIR_ENV = "JUNO_CODE_SCRIPT_TEMPLATE_DIR"


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
    continue_from_step = str(workflow.get("continue_from_step") or "").strip()
    seen: set[str] = set()
    step_names: set[str] = set()
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
        step_name = str(step.get("name") or "").strip()
        if step_name:
            step_names.add(step_name)
        if "command" not in step:
            raise WorkflowError(f"step {step_id} is missing required command")
    summary = workflow.get("summary")
    summary_has_command = isinstance(summary, dict) and "command" in summary
    if continue_from_step and continue_from_step != "summary" and continue_from_step not in seen and continue_from_step not in step_names:
        raise WorkflowError(f"continue_from_step references unknown step: {continue_from_step}")
    if continue_from_step == "summary" and not summary_has_command:
        raise WorkflowError("continue_from_step references summary, but summary.command is not configured")


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
        if part in {"-s", "--subagent", "-b", "--backend", "-m", "--model", "-c", "--config", "-l", "--log-file"}:
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


def resolve_continue_scope_context(env: dict[str, str] | None = None, fallback_parent_pid: int | None = None) -> dict[str, str]:
    env = env or os.environ
    override = str(env.get(CONTINUE_SCOPE_OVERRIDE_ENV_KEY, "")).strip()
    if override:
        descriptor = f"{CONTINUE_SCOPE_OVERRIDE_ENV_KEY}:{override}"
        source = CONTINUE_SCOPE_OVERRIDE_ENV_KEY
    else:
        descriptor = ""
        source = ""
        for key in CONTINUE_SCOPE_ENV_MARKERS:
            value = str(env.get(key, "")).strip()
            if value:
                descriptor = f"{key}:{value}"
                source = key
                break
        if not descriptor:
            descriptor = f"PPID:{fallback_parent_pid if fallback_parent_pid is not None else os.getppid()}"
            source = "process.ppid"
    digest = hashlib.sha256(descriptor.encode("utf-8")).hexdigest()[:16].upper()
    scope_hash = f"SCOPE_{digest}"
    return {
        "scope_descriptor": descriptor,
        "scope_source": source,
        "scope_hash": scope_hash,
        "short_hash": digest[:6],
        "session_env_key": f"{CONTINUE_SESSION_ENV_KEY_BASE}_{scope_hash}",
        "settings_env_key": f"{CONTINUE_SETTINGS_ENV_KEY_BASE}_{scope_hash}",
    }


def resolve_env_file_path(project_root: Path) -> Path:
    config_path = project_root / ".juno_task" / "config.json"
    env_file = ".env.juno"
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
        configured = config.get("envFilePath")
        if isinstance(configured, str) and configured.strip():
            env_file = configured.strip()
    except Exception:
        pass
    candidate = Path(env_file)
    return candidate if candidate.is_absolute() else project_root / candidate


def shell_quote_env_value(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def upsert_env_variable(content: str, key: str, value: str) -> str:
    line = f'{key}="{shell_quote_env_value(value)}"'
    pattern = re.compile(rf"^(?:export\s+)?{re.escape(key)}=.*$", re.M)
    if pattern.search(content):
        return pattern.sub(line, content)
    if not content:
        return line + "\n"
    return content.rstrip() + "\n" + line + "\n"


def unquote_env_value(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] == '"':
        value = value[1:-1]
        return value.replace('\\"', '"').replace('\\\\', '\\')
    return value


def parse_env_variables(content: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in content.splitlines():
        match = re.match(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$", line)
        if match:
            values[match.group(1)] = unquote_env_value(match.group(2))
    return values


def build_continue_settings(command: Any) -> dict[str, Any] | None:
    subagent = juno_subagent_name(command)
    if not subagent:
        return None
    settings: dict[str, Any] = {"version": 1, "subagent": subagent}
    model = extract_model_from_command(command)
    if model:
        settings["model"] = model
    return settings


def update_main_session_branch(project_root: Path, context: dict[str, str], session_id: str) -> None:
    branches_path = project_root / ".juno_task" / "session_branches.json"
    now = _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    try:
        document = json.loads(branches_path.read_text(encoding="utf-8")) if branches_path.exists() else {}
        if not isinstance(document, dict):
            document = {}
    except Exception:
        document = {}
    document["version"] = 1
    scopes = document.setdefault("scopes", {})
    if not isinstance(scopes, dict):
        scopes = {}
        document["scopes"] = scopes
    scope_entry = scopes.setdefault(context["scope_hash"], {})
    if not isinstance(scope_entry, dict):
        scope_entry = {}
        scopes[context["scope_hash"]] = scope_entry
    scope_entry["active"] = "main"
    branches = scope_entry.setdefault("branches", {})
    if not isinstance(branches, dict):
        branches = {}
        scope_entry["branches"] = branches
    branches["main"] = {"session_id": session_id, "parent": None, "updated_at": now}
    branches_path.parent.mkdir(parents=True, exist_ok=True)
    branches_path.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")


def read_continue_snapshot(project_root: Path, context: dict[str, str]) -> dict[str, str] | None:
    env_file = resolve_env_file_path(project_root)
    if not env_file.exists():
        return None
    values = parse_env_variables(env_file.read_text(encoding="utf-8"))
    session_id = values.get(context["session_env_key"], "").strip()
    settings = values.get(context["settings_env_key"], "").strip()
    if not session_id or not settings:
        return None
    try:
        parsed_settings = json.loads(settings)
    except Exception:
        return None
    if not isinstance(parsed_settings, dict):
        return None
    return {"session_id": session_id, "settings": settings, "env_file": str(env_file), **context}


def read_child_continue_session(project_root: Path) -> str | None:
    # Top-level yy/juno-code commands persist their own continue snapshot, but when
    # launched by this runner without terminal markers their PPID fallback is the
    # workflow_runner process. Adopt that child snapshot, then persist it to the
    # caller's shell scope so `workflow_runner.sh ... ; yy cc` works.
    child_context = resolve_continue_scope_context(fallback_parent_pid=os.getpid())
    snapshot = read_continue_snapshot(project_root, child_context)
    return snapshot["session_id"] if snapshot else None


def persist_continue_context(project_root: Path, session_id: str, command: Any) -> dict[str, str] | None:
    settings = build_continue_settings(command)
    if not settings:
        return None
    context = resolve_continue_scope_context()
    env_file = resolve_env_file_path(project_root)
    env_file.parent.mkdir(parents=True, exist_ok=True)
    current = env_file.read_text(encoding="utf-8") if env_file.exists() else ""
    serialized_settings = json.dumps(settings, separators=(",", ":"))
    current = upsert_env_variable(current, context["session_env_key"], session_id)
    current = upsert_env_variable(current, context["settings_env_key"], serialized_settings)
    env_file.write_text(current, encoding="utf-8")
    update_main_session_branch(project_root, context, session_id)
    os.environ[context["session_env_key"]] = session_id
    os.environ[context["settings_env_key"]] = serialized_settings
    return {**context, "env_file": str(env_file), "settings": serialized_settings}


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
            print(f"  handoff: {selected_label} persisted for yy cc ({persisted['session_env_key']})")
        else:
            print(f"  handoff: last session persisted for yy cc ({persisted['session_env_key']})")
        print(f"  env_file: {persisted['env_file']}")


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


def build_command_env(
    project_root: Path,
    command: Any,
    capture_enabled: bool,
    capture_path: Path,
    tool_id: str,
    dry_run: bool,
) -> tuple[dict[str, str], str | None]:
    env = os.environ.copy()
    if capture_enabled:
        env["JUNO_TOOL_ID"] = tool_id
        env["JUNO_SUBAGENT_CAPTURE_PATH"] = str(capture_path)
    else:
        env.pop("JUNO_TOOL_ID", None)
        env.pop("JUNO_SUBAGENT_CAPTURE_PATH", None)
    child_continue_session_before = (
        read_child_continue_session(project_root) if detect_juno_command(command) and not dry_run else None
    )
    return env, child_continue_session_before


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
            child_continue_session_after = read_child_continue_session(project_root)
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
    workflow: dict[str, Any], context: dict[str, Any], project_root: Path, out_dir: Path, dry_run: bool
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
        proc = execute_rendered_command(command, project_root, env)
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
    session_candidates: list[dict[str, Any]] = []
    explicit_continue_from_step = str(workflow.get("continue_from_step") or "").strip()
    persisted_continue: dict[str, str] | None = None
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
        command = render(step["command"], context)
        preview = command_preview(command)
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
        started = time.monotonic()
        stdout = ""
        stderr = ""
        exit_code = 0
        env, child_continue_session_before = build_command_env(
            project_root, command, capture_enabled, capture_path, f"workflow_{step_slug}", bool(args.dry_run)
        )
        if args.dry_run:
            status = "dry_run"
        else:
            proc = execute_rendered_command(command, project_root, env)
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
        if is_juno_command or capture_enabled:
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
        if is_juno_command and not args.dry_run and status == "success" and not str(result.get("response", "")).strip():
            status = "failed"
            result["status"] = status
            result["failure_reason"] = "empty response from detected agent command"
        if stderr and status == "failed":
            print(stderr, file=sys.stderr, end="" if stderr.endswith("\n") else "\n")
        if is_juno_command or result.get("session_id") or explicit_continue_from_step in {step_id, str(step.get("name") or "")}:
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
        if status == "failed":
            manifest["failed_steps"].append(step_id)
            manifest["status"] = "failed"
            if step_should_fail_process(step):
                final_exit = exit_code or 1
                break

    summary_stdout, summary_stderr, summary_exit, summary_command, summary_session = maybe_run_summary_command(
        workflow, context, project_root, out_dir, bool(args.dry_run)
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
            "env_key": persisted_continue.get("session_env_key") if persisted_continue else "",
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

    output = selected_final_output(args.print_output, context, summary)
    if output:
        print("\n" + output, end="" if output.endswith("\n") else "\n")
    print_session_summary([item for item in session_candidates if item.get("session_id")], persisted_continue)
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
      - |
        Plan mode: create the concrete kanban tasks needed for this topic, then print one machine-readable line:
        TASK_IDS=<comma-separated-kanban-task-ids>

        Topic: {{ review_topic }}
        Use ./.juno_task/scripts/kanban.sh as the source of truth. Keep task bodies complete enough for parallel agents.
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
    parser.add_argument("--print-step-stdout", dest="print_step_stdout", action="store_true", default=True, help="Print each step response/stdout as it completes (default); successful stderr stays in artifacts")
    parser.add_argument("--no-print-step-stdout", dest="print_step_stdout", action="store_false", help="Do not echo per-step response/stdout to the console; artifacts are still written")
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


def main(argv: list[str] | None = None) -> int:
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
    try:
        return run_workflow(args)
    except WorkflowError as exc:
        print(f"workflow_runner.sh: error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
