import argparse
import importlib.util
import io
import json
import os
import sys
from contextlib import redirect_stdout
from pathlib import Path


SERVICES_DIR = Path(__file__).resolve().parents[1] / "src" / "templates" / "services"


def _load_module(module_name: str):
    spec = importlib.util.spec_from_file_location(module_name, SERVICES_DIR / f"{module_name}.py")
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


def _claude_args(**overrides):
    values = dict(
        permission_mode="default",
        tools=None,
        allowed_tools=None,
        append_allowed_tools=None,
        disallowed_tools=None,
        continue_conversation=False,
        resume_session=None,
        agents=None,
        json=True,
        additional_args=None,
    )
    values.update(overrides)
    return argparse.Namespace(**values)


def _codex_args(**overrides):
    values = dict(configs=None)
    values.update(overrides)
    return argparse.Namespace(**values)


def _gemini_args(**overrides):
    values = dict(include_directories=None, approval_mode=None, yolo=False, debug=False)
    values.update(overrides)
    return argparse.Namespace(**values)


def test_claude_oversized_prompt_uses_stdin_not_argv(monkeypatch):
    monkeypatch.setenv("JUNO_PROMPT_ARG_MAX_BYTES", "8")
    module = _load_module("claude")
    svc = module.ClaudeService()
    svc.model_name = "claude-sonnet-4-6"
    svc.auto_instruction = ""
    svc.prompt = "x" * 32

    cmd = svc.build_claude_command(_claude_args())

    assert "x" * 32 not in cmd
    assert svc._stdin_prompt == "\n\n" + ("x" * 32)
    assert cmd[:2] == ["claude", "--print"]


def test_claude_small_prompt_preserves_argv_transport(monkeypatch):
    monkeypatch.setenv("JUNO_PROMPT_ARG_MAX_BYTES", "1024")
    module = _load_module("claude")
    svc = module.ClaudeService()
    svc.model_name = "claude-sonnet-4-6"
    svc.auto_instruction = ""
    svc.prompt = "small"

    cmd = svc.build_claude_command(_claude_args())

    assert "\n\nsmall" in cmd
    assert svc._stdin_prompt is None


def test_codex_oversized_prompt_uses_stdin_marker_not_argv(monkeypatch):
    monkeypatch.setenv("JUNO_PROMPT_ARG_MAX_BYTES", "8")
    module = _load_module("codex")
    svc = module.CodexService()
    svc.model_name = "gpt-5.3-codex"
    svc.project_path = os.getcwd()
    svc.auto_instruction = ""
    svc.prompt = "y" * 32

    cmd = svc.build_codex_command(_codex_args())

    assert "y" * 32 not in cmd
    assert svc._stdin_prompt == "\n\n" + ("y" * 32)
    assert "exec" in cmd
    assert cmd[cmd.index("exec") + 1] == "-"
    assert "--json" in cmd


def test_codex_small_prompt_preserves_argv_transport(monkeypatch):
    monkeypatch.setenv("JUNO_PROMPT_ARG_MAX_BYTES", "1024")
    module = _load_module("codex")
    svc = module.CodexService()
    svc.model_name = "gpt-5.3-codex"
    svc.project_path = os.getcwd()
    svc.auto_instruction = ""
    svc.prompt = "small"

    cmd = svc.build_codex_command(_codex_args())

    assert cmd[cmd.index("exec") + 1] == "\n\nsmall"
    assert svc._stdin_prompt is None


def test_gemini_oversized_prompt_uses_stdin_not_prompt_flag(monkeypatch):
    monkeypatch.setenv("JUNO_PROMPT_ARG_MAX_BYTES", "8")
    module = _load_module("gemini")
    svc = module.GeminiService()
    svc.model_name = "gemini-2.5-pro"
    svc.output_format = "stream-json"
    svc.prompt = "z" * 32

    cmd = svc.build_gemini_command(_gemini_args())

    assert "--prompt" not in cmd
    assert "z" * 32 not in cmd
    assert svc._stdin_prompt == "z" * 32
    assert "--output-format" in cmd


def test_gemini_small_prompt_preserves_prompt_flag(monkeypatch):
    monkeypatch.setenv("JUNO_PROMPT_ARG_MAX_BYTES", "1024")
    module = _load_module("gemini")
    svc = module.GeminiService()
    svc.model_name = "gemini-2.5-pro"
    svc.output_format = "stream-json"
    svc.prompt = "small"

    cmd = svc.build_gemini_command(_gemini_args())

    assert "--prompt" in cmd
    assert cmd[cmd.index("--prompt") + 1] == "small"
    assert svc._stdin_prompt is None


def test_claude_run_writes_and_closes_stdin_without_hanging():
    module = _load_module("claude")
    svc = module.ClaudeService()
    svc.project_path = os.getcwd()
    svc._stdin_prompt = "hello from stdin"
    script = (
        "import json,sys; "
        "data=sys.stdin.read(); "
        "print(json.dumps({'type':'result','result':data}))"
    )

    buf = io.StringIO()
    with redirect_stdout(buf):
        code = svc.run_claude([sys.executable, "-c", script], pretty=False)

    assert code == 0
    assert "hello from stdin" in buf.getvalue()


def test_codex_run_writes_and_closes_stdin_without_hanging():
    module = _load_module("codex")
    svc = module.CodexService()
    svc._stdin_prompt = "hello from stdin"
    script = (
        "import json,sys; "
        "data=sys.stdin.read(); "
        "print(json.dumps({'msg':{'type':'agent_message','message':data}}))"
    )

    buf = io.StringIO()
    with redirect_stdout(buf):
        code = svc.run_codex([sys.executable, "-c", script], verbose=False)

    assert code == 0
    assert "hello from stdin" in buf.getvalue()


def test_gemini_run_writes_and_closes_stdin_without_hanging():
    module = _load_module("gemini")
    svc = module.GeminiService()
    svc.project_path = os.getcwd()
    svc._stdin_prompt = "hello from stdin"
    script = (
        "import json,sys; "
        "data=sys.stdin.read(); "
        "print(json.dumps({'type':'message','content':data}))"
    )

    buf = io.StringIO()
    with redirect_stdout(buf):
        code = svc.run_gemini([sys.executable, "-c", script], verbose=False)

    assert code == 0
    assert "hello from stdin" in buf.getvalue()
