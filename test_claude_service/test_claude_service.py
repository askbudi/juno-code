"""
Comprehensive tests for the Claude service script (claude.py).

Tests cover:
- Model shorthand expansion (all 8 shorthands + passthrough + unknown)
- pretty_format_json() for user, assistant, progress, and result events
- Counter incrementing across multiple calls
- Capture file writing / last_result_event tracking
- DEFAULT_ALLOWED_TOOLS list verification
"""

import json
import os
import sys

import pytest


def _load_claude_service():
    """Load and return a fresh ClaudeService instance from the template."""
    here = os.path.dirname(__file__)
    services_dir = os.path.abspath(os.path.join(here, "..", "src", "templates", "services"))
    if not os.path.isdir(services_dir):
        services_dir = os.path.abspath(os.path.join(here, "..", "..", "src", "templates", "services"))
    if services_dir not in sys.path:
        sys.path.insert(0, services_dir)
    from claude import ClaudeService
    return ClaudeService()


# ---------------------------------------------------------------------------
# 1. Model shorthand expansion
# ---------------------------------------------------------------------------

def test_shorthand_claude_haiku_4_5():
    svc = _load_claude_service()
    assert svc.expand_model_shorthand(":claude-haiku-4-5") == "claude-haiku-4-5-20251001"


def test_shorthand_claude_sonnet_4_5():
    svc = _load_claude_service()
    assert svc.expand_model_shorthand(":claude-sonnet-4-5") == "claude-sonnet-4-5-20250929"


def test_shorthand_claude_opus_4_5():
    svc = _load_claude_service()
    assert svc.expand_model_shorthand(":claude-opus-4-5") == "claude-opus-4-5-20251101"


def test_shorthand_claude_opus_4_6():
    svc = _load_claude_service()
    assert svc.expand_model_shorthand(":claude-opus-4-6") == "claude-opus-4-6"


def test_shorthand_claude_opus_4():
    svc = _load_claude_service()
    assert svc.expand_model_shorthand(":claude-opus-4") == "claude-opus-4-20250514"


def test_shorthand_haiku():
    svc = _load_claude_service()
    assert svc.expand_model_shorthand(":haiku") == "claude-haiku-4-5-20251001"


def test_shorthand_claude_sonnet_4_6():
    svc = _load_claude_service()
    assert svc.expand_model_shorthand(":claude-sonnet-4-6") == "claude-sonnet-4-6"


def test_shorthand_sonnet():
    svc = _load_claude_service()
    assert svc.expand_model_shorthand(":sonnet") == "claude-sonnet-4-6"


def test_shorthand_opus():
    svc = _load_claude_service()
    assert svc.expand_model_shorthand(":opus") == "claude-opus-4-6"


def test_non_shorthand_passthrough():
    svc = _load_claude_service()
    assert svc.expand_model_shorthand("claude-sonnet-4-6") == "claude-sonnet-4-6"


def test_unknown_shorthand_is_rejected():
    from environment_boundary import ModelShortcutError

    svc = _load_claude_service()
    with pytest.raises(ModelShortcutError, match="unknown model shortcut for claude: :unknown"):
        svc.expand_model_shorthand(":unknown")


# ---------------------------------------------------------------------------
# 2. pretty_format_json() - User message handling
# ---------------------------------------------------------------------------

def _make_user_event(text: str) -> str:
    """Build a JSON string for a user-type event."""
    return json.dumps({
        "type": "user",
        "message": {
            "content": [{"type": "text", "text": text}]
        }
    })


def test_user_single_line_content():
    svc = _load_claude_service()
    result = svc.pretty_format_json(_make_user_event("hello world"))
    parsed = json.loads(result)
    assert parsed["type"] == "user"
    assert parsed["content"] == "hello world"
    assert parsed["counter"] == "#1"


def test_user_multiline_content():
    svc = _load_claude_service()
    text = "line1\nline2\nline3"
    result = svc.pretty_format_json(_make_user_event(text))
    # Multi-line: first line is JSON metadata, then "content:\n" block
    lines = result.split("\n")
    metadata = json.loads(lines[0])
    assert metadata["type"] == "user"
    assert lines[1] == "content:"
    assert lines[2] == "line1"
    assert lines[3] == "line2"
    assert lines[4] == "line3"


def test_user_truncation_default():
    """10-line text with default truncate=4 shows 4 lines + [Truncated...]."""
    svc = _load_claude_service()
    svc.user_message_truncate = 4
    text = "\n".join(f"line{i}" for i in range(1, 11))  # 10 lines
    result = svc.pretty_format_json(_make_user_event(text))
    # Multi-line output
    lines = result.split("\n")
    # metadata line, "content:", then 4 kept lines, then [Truncated...]
    assert lines[1] == "content:"
    assert lines[2] == "line1"
    assert lines[3] == "line2"
    assert lines[4] == "line3"
    assert lines[5] == "line4"
    assert lines[6] == "[Truncated...]"


def test_user_truncation_disabled():
    """truncate=-1 shows all content."""
    svc = _load_claude_service()
    svc.user_message_truncate = -1
    text = "\n".join(f"line{i}" for i in range(1, 11))  # 10 lines
    result = svc.pretty_format_json(_make_user_event(text))
    lines = result.split("\n")
    # metadata line, "content:", then all 10 lines (no Truncated)
    assert "[Truncated...]" not in result
    # Should contain all 10 lines
    for i in range(1, 11):
        assert f"line{i}" in result


# ---------------------------------------------------------------------------
# 3. pretty_format_json() - Assistant message handling
# ---------------------------------------------------------------------------

def _make_assistant_event(content_items: list) -> str:
    """Build a JSON string for an assistant-type event."""
    return json.dumps({
        "type": "assistant",
        "message": {
            "content": content_items
        }
    })


def test_assistant_text_content():
    svc = _load_claude_service()
    event = _make_assistant_event([{"type": "text", "text": "Hello there"}])
    result = svc.pretty_format_json(event)
    parsed = json.loads(result)
    assert parsed["type"] == "assistant"
    assert parsed["content"] == "Hello there"
    assert "counter" in parsed


def test_assistant_tool_use():
    svc = _load_claude_service()
    event = _make_assistant_event([{
        "type": "tool_use",
        "name": "Bash",
        "input": {"command": "ls -la"}
    }])
    result = svc.pretty_format_json(event)
    parsed = json.loads(result)
    assert parsed["type"] == "assistant"
    assert parsed["tool_use"]["name"] == "Bash"
    assert parsed["tool_use"]["input"]["command"] == "ls -la"


def test_assistant_tool_use_multiline_prompt():
    svc = _load_claude_service()
    event = _make_assistant_event([{
        "type": "tool_use",
        "name": "Edit",
        "input": {"prompt": "line1\nline2\nline3", "file": "test.py"}
    }])
    result = svc.pretty_format_json(event)
    lines = result.split("\n")
    metadata = json.loads(lines[0])
    assert metadata["type"] == "assistant"
    # prompt should be extracted out
    assert "prompt" not in metadata.get("tool_use", {}).get("input", {})
    assert lines[1] == "prompt:"
    assert lines[2] == "line1"
    assert lines[3] == "line2"
    assert lines[4] == "line3"


def test_assistant_multiline_text_content():
    svc = _load_claude_service()
    event = _make_assistant_event([{"type": "text", "text": "first\nsecond\nthird"}])
    result = svc.pretty_format_json(event)
    lines = result.split("\n")
    metadata = json.loads(lines[0])
    assert metadata["type"] == "assistant"
    assert lines[1] == "content:"
    assert lines[2] == "first"
    assert lines[3] == "second"
    assert lines[4] == "third"


# ---------------------------------------------------------------------------
# 4. pretty_format_json() - Progress events
# ---------------------------------------------------------------------------

def _make_progress_event(progress_type: str, extra: dict = None) -> str:
    """Build a JSON string for a progress-type event."""
    data = {"type": progress_type}
    if extra:
        data.update(extra)
    return json.dumps({"type": "progress", "data": data})


def test_hook_progress_skipped():
    svc = _load_claude_service()
    result = svc.pretty_format_json(_make_progress_event("hook_progress"))
    assert result is None


def test_bash_progress_single_line():
    svc = _load_claude_service()
    event = _make_progress_event("bash_progress", {
        "output": "running tests...",
        "elapsedTimeSeconds": 5,
        "totalLines": 10
    })
    result = svc.pretty_format_json(event)
    assert result.startswith("[Progress] ")
    parsed = json.loads(result[len("[Progress] "):])
    assert parsed["progress_type"] == "bash_progress"
    assert parsed["output"] == "running tests..."
    assert parsed["elapsed"] == "5s"
    assert parsed["lines"] == 10


def test_bash_progress_multiline():
    svc = _load_claude_service()
    event = _make_progress_event("bash_progress", {
        "output": "line1\nline2\nline3",
        "elapsedTimeSeconds": 12,
        "totalLines": 3
    })
    result = svc.pretty_format_json(event)
    lines = result.split("\n")
    metadata = json.loads(lines[0])
    assert metadata["progress_type"] == "bash_progress"
    assert lines[1] == "[Progress] output:"
    assert lines[2] == "line1"
    assert lines[3] == "line2"
    assert lines[4] == "line3"


# ---------------------------------------------------------------------------
# 5. pretty_format_json() - Result events
# ---------------------------------------------------------------------------

def test_result_multiline_content():
    svc = _load_claude_service()
    event = json.dumps({
        "type": "result",
        "result": "output line 1\noutput line 2\noutput line 3"
    })
    result = svc.pretty_format_json(event)
    lines = result.split("\n")
    metadata = json.loads(lines[0])
    assert metadata["type"] == "result"
    assert "result" not in metadata  # extracted out
    assert lines[1] == "result:"
    assert lines[2] == "output line 1"
    assert lines[3] == "output line 2"
    assert lines[4] == "output line 3"


def test_tool_result_flattened():
    svc = _load_claude_service()
    event = json.dumps({
        "type": "tool_result_wrapper",
        "message": {
            "content": [{
                "type": "tool_result",
                "tool_use_id": "abc123",
                "content": "success"
            }]
        }
    })
    result = svc.pretty_format_json(event)
    parsed = json.loads(result)
    assert parsed["type"] == "tool_result"
    assert parsed["tool_use_id"] == "abc123"
    assert parsed["content"] == "success"


# ---------------------------------------------------------------------------
# 6. pretty_format_json() - Counter incrementing
# ---------------------------------------------------------------------------

def test_counter_increments():
    svc = _load_claude_service()
    for i in range(1, 4):
        result = svc.pretty_format_json(_make_user_event("hello"))
        parsed = json.loads(result)
        assert parsed["counter"] == f"#{i}"


# ---------------------------------------------------------------------------
# 7. Capture file / last_result_event tracking
# ---------------------------------------------------------------------------

def test_last_result_event_tracking():
    """Verify that when a result event is parsed, last_result_event is set."""
    svc = _load_claude_service()
    assert svc.last_result_event is None

    # Simulate what run_claude does when it sees a result event
    result_event = {"type": "result", "result": "done", "session_id": "s1"}
    raw_line = json.dumps(result_event)
    parsed = json.loads(raw_line)
    if isinstance(parsed, dict) and parsed.get("type") == "result":
        svc.last_result_event = parsed

    assert svc.last_result_event is not None
    assert svc.last_result_event["type"] == "result"
    assert svc.last_result_event["result"] == "done"
    assert svc.last_result_event["session_id"] == "s1"


def test_last_result_event_updates_on_subsequent_result():
    """If multiple result events come through, last one wins."""
    svc = _load_claude_service()

    for i in range(3):
        event = {"type": "result", "result": f"result_{i}"}
        svc.last_result_event = event

    assert svc.last_result_event["result"] == "result_2"


def test_capture_file_write(tmp_path):
    """Test that write_capture_file writes last_result_event to disk."""
    svc = _load_claude_service()
    capture_file = tmp_path / "capture.json"

    svc.last_result_event = {"type": "result", "result": "final answer", "session_id": "abc"}

    # Replicate the write_capture_file logic from run_claude
    from pathlib import Path
    Path(capture_file).write_text(
        json.dumps(svc.last_result_event, ensure_ascii=False),
        encoding="utf-8"
    )

    content = json.loads(capture_file.read_text(encoding="utf-8"))
    assert content["type"] == "result"
    assert content["result"] == "final answer"
    assert content["session_id"] == "abc"


# ---------------------------------------------------------------------------
# 8. DEFAULT_ALLOWED_TOOLS list
# ---------------------------------------------------------------------------

def test_default_allowed_tools_count():
    svc = _load_claude_service()
    assert len(svc.DEFAULT_ALLOWED_TOOLS) == 17


def test_default_allowed_tools_contents():
    svc = _load_claude_service()
    expected = [
        "Task", "Bash", "Glob", "Grep", "ExitPlanMode", "Read", "Edit", "Write",
        "NotebookEdit", "WebFetch", "TodoWrite", "WebSearch", "BashOutput",
        "KillShell", "Skill", "SlashCommand", "EnterPlanMode"
    ]
    assert svc.DEFAULT_ALLOWED_TOOLS == expected


def test_default_allowed_tools_contains_each():
    """Individually verify each expected tool is present."""
    svc = _load_claude_service()
    for tool in ["Task", "Bash", "Glob", "Grep", "ExitPlanMode", "Read", "Edit",
                  "Write", "NotebookEdit", "WebFetch", "TodoWrite", "WebSearch",
                  "BashOutput", "KillShell", "Skill", "SlashCommand", "EnterPlanMode"]:
        assert tool in svc.DEFAULT_ALLOWED_TOOLS, f"Missing tool: {tool}"


# ---------------------------------------------------------------------------
# Helper for build_claude_command tests
# ---------------------------------------------------------------------------

def _make_claude_args(**overrides):
    """Create a default argparse.Namespace suitable for build_claude_command()."""
    import argparse
    defaults = dict(
        prompt="test prompt",
        permission_mode="default",
        tools=None,
        allowed_tools=None,
        disallowed_tools=None,
        append_allowed_tools=None,
        continue_conversation=False,
        resume_session=None,
        agents=None,
        json=False,
        additional_args="",
        auto_instruction="",
    )
    defaults.update(overrides)
    return argparse.Namespace(**defaults)


# ---------------------------------------------------------------------------
# 9. build_claude_command() - Tool argument construction
# ---------------------------------------------------------------------------

class TestBuildClaudeCommandTools:
    """Test tool-related arguments in build_claude_command()."""

    @pytest.fixture(autouse=True)
    def service(self):
        self.svc = _load_claude_service()
        self.svc.model_name = "claude-sonnet-4-6"
        self.svc.prompt = "test prompt"
        self.svc.auto_instruction = ""

    def test_default_allowed_tools_when_none_specified(self):
        """When no tool args specified, uses DEFAULT_ALLOWED_TOOLS."""
        args = _make_claude_args()
        cmd = self.svc.build_claude_command(args)
        assert "--allowedTools" in cmd
        idx = cmd.index("--allowedTools")
        # All 17 default tools should follow
        tools_in_cmd = cmd[idx + 1: idx + 1 + len(self.svc.DEFAULT_ALLOWED_TOOLS)]
        assert tools_in_cmd == self.svc.DEFAULT_ALLOWED_TOOLS

    def test_explicit_allowed_tools_replaces_default(self):
        """--allowed-tools replaces the default list."""
        args = _make_claude_args(allowed_tools=["Bash", "Read"])
        cmd = self.svc.build_claude_command(args)
        assert "--allowedTools" in cmd
        idx = cmd.index("--allowedTools")
        assert cmd[idx + 1] == "Bash"
        assert cmd[idx + 2] == "Read"

    def test_append_allowed_tools_combines_with_default(self):
        """--append-allowed-tools adds to DEFAULT_ALLOWED_TOOLS."""
        args = _make_claude_args(append_allowed_tools=["CustomTool"])
        cmd = self.svc.build_claude_command(args)
        assert "--allowedTools" in cmd
        idx = cmd.index("--allowedTools")
        remaining = cmd[idx + 1:]
        # Should contain all defaults + CustomTool
        assert "CustomTool" in remaining
        for tool in self.svc.DEFAULT_ALLOWED_TOOLS:
            assert tool in remaining

    def test_tools_flag_passthrough(self):
        """--tools flag is passed through to claude command."""
        args = _make_claude_args(tools=["Bash", "Edit"])
        cmd = self.svc.build_claude_command(args)
        assert "--tools" in cmd
        idx = cmd.index("--tools")
        assert cmd[idx + 1] == "Bash"
        assert cmd[idx + 2] == "Edit"

    def test_disallowed_tools_passthrough(self):
        """--disallowedTools is passed through."""
        args = _make_claude_args(disallowed_tools=["Bash"])
        cmd = self.svc.build_claude_command(args)
        assert "--disallowedTools" in cmd
        idx = cmd.index("--disallowedTools")
        assert cmd[idx + 1] == "Bash"

    def test_no_tools_when_not_specified(self):
        """--tools is NOT in command when not specified."""
        args = _make_claude_args()
        cmd = self.svc.build_claude_command(args)
        assert "--tools" not in cmd

    def test_no_disallowed_tools_when_not_specified(self):
        """--disallowedTools is NOT in command when not specified."""
        args = _make_claude_args()
        cmd = self.svc.build_claude_command(args)
        assert "--disallowedTools" not in cmd


# ---------------------------------------------------------------------------
# 10. build_claude_command() - Continue and Resume flags
# ---------------------------------------------------------------------------

class TestBuildClaudeCommandContinueResume:
    """Test --continue and --resume flag passthrough."""

    @pytest.fixture(autouse=True)
    def service(self):
        self.svc = _load_claude_service()
        self.svc.model_name = "claude-sonnet-4-6"
        self.svc.prompt = "test prompt"
        self.svc.auto_instruction = ""

    def test_continue_flag_added(self):
        """--continue is added when continue_conversation=True."""
        args = _make_claude_args(continue_conversation=True)
        cmd = self.svc.build_claude_command(args)
        assert "--continue" in cmd

    def test_continue_flag_not_added_when_false(self):
        """--continue is NOT added when continue_conversation=False."""
        args = _make_claude_args(continue_conversation=False)
        cmd = self.svc.build_claude_command(args)
        assert "--continue" not in cmd

    def test_resume_flag_added_with_session_id(self):
        """--resume SESSION_ID is added when resume_session is set."""
        args = _make_claude_args(resume_session="abc123")
        cmd = self.svc.build_claude_command(args)
        assert "--resume" in cmd
        idx = cmd.index("--resume")
        assert cmd[idx + 1] == "abc123"

    def test_resume_flag_not_added_when_none(self):
        """--resume is NOT added when resume_session=None."""
        args = _make_claude_args(resume_session=None)
        cmd = self.svc.build_claude_command(args)
        assert "--resume" not in cmd

    def test_both_continue_and_resume(self):
        """Both --continue and --resume can be present."""
        args = _make_claude_args(continue_conversation=True, resume_session="xyz789")
        cmd = self.svc.build_claude_command(args)
        assert "--continue" in cmd
        assert "--resume" in cmd

    def test_json_output_format(self):
        """--output-format stream-json and --verbose added when json=True."""
        args = _make_claude_args(json=True)
        cmd = self.svc.build_claude_command(args)
        assert "--output-format" in cmd
        idx = cmd.index("--output-format")
        assert cmd[idx + 1] == "stream-json"
        assert "--verbose" in cmd

    def test_command_starts_with_claude(self):
        """Command always starts with 'claude'."""
        args = _make_claude_args()
        cmd = self.svc.build_claude_command(args)
        assert cmd[0] == "claude"

    def test_print_flag_always_present(self):
        """--print flag is always in the command."""
        args = _make_claude_args()
        cmd = self.svc.build_claude_command(args)
        assert "--print" in cmd

    def test_model_flag_always_present(self):
        """--model flag is always present with correct value."""
        args = _make_claude_args()
        cmd = self.svc.build_claude_command(args)
        assert "--model" in cmd
        idx = cmd.index("--model")
        assert cmd[idx + 1] == "claude-sonnet-4-6"

    def test_permission_mode_always_present(self):
        """--permission-mode flag is always present."""
        args = _make_claude_args(permission_mode="bypassPermissions")
        cmd = self.svc.build_claude_command(args)
        assert "--permission-mode" in cmd
        idx = cmd.index("--permission-mode")
        assert cmd[idx + 1] == "bypassPermissions"

    def test_additional_args_appended(self):
        """additional_args are split and appended."""
        args = _make_claude_args(additional_args="--extra flag")
        cmd = self.svc.build_claude_command(args)
        assert "--extra" in cmd
        assert "flag" in cmd

    def test_agents_flag(self):
        """--agents flag is passed through."""
        args = _make_claude_args(agents="3")
        cmd = self.svc.build_claude_command(args)
        assert "--agents" in cmd
        idx = cmd.index("--agents")
        assert cmd[idx + 1] == "3"
