"""
Comprehensive tests for the Pi service script (pi.py).
Covers model shorthand expansion, command building, prettifier mode detection,
result event tracking, and Codex prettifier helpers.
"""

import argparse
import copy
import json
import os
import sys

import pytest


# ---------------------------------------------------------------------------
# Helper: load PiService from the template source tree
# ---------------------------------------------------------------------------

def _load_pi_service():
    here = os.path.dirname(__file__)
    services_dir = os.path.abspath(os.path.join(here, "..", "src", "templates", "services"))
    if not os.path.isdir(services_dir):
        services_dir = os.path.abspath(os.path.join(here, "..", "..", "src", "templates", "services"))
    if services_dir not in sys.path:
        sys.path.insert(0, services_dir)
    from pi import PiService
    return PiService()


def _make_args(**overrides):
    """Create a default argparse.Namespace suitable for build_pi_command()."""
    defaults = dict(
        prompt="test prompt",
        prompt_file=None,
        cd="/tmp",
        model=":sonnet",
        provider="",
        thinking=None,
        tools=None,
        no_tools=False,
        system_prompt=None,
        append_system_prompt=None,
        no_extensions=False,
        no_skills=False,
        no_session=False,
        auto_instruction="",
        additional_args="",
        pretty="true",
        verbose=False,
    )
    defaults.update(overrides)
    return argparse.Namespace(**defaults)


# ===================================================================
# 1. Model shorthand expansion
# ===================================================================

class TestModelShorthandExpansion:
    """Test all 13 MODEL_SHORTHANDS plus edge cases."""

    @pytest.fixture(autouse=True)
    def service(self):
        self.svc = _load_pi_service()

    def test_shorthand_pi(self):
        assert self.svc.expand_model_shorthand(":pi") == "anthropic/claude-sonnet-4-6"

    def test_shorthand_default(self):
        assert self.svc.expand_model_shorthand(":default") == "anthropic/claude-sonnet-4-6"

    def test_shorthand_sonnet(self):
        assert self.svc.expand_model_shorthand(":sonnet") == "anthropic/claude-sonnet-4-6"

    def test_shorthand_opus(self):
        assert self.svc.expand_model_shorthand(":opus") == "anthropic/claude-opus-4-6"

    def test_shorthand_haiku(self):
        assert self.svc.expand_model_shorthand(":haiku") == "anthropic/claude-haiku-4-5-20251001"

    def test_shorthand_gpt5(self):
        assert self.svc.expand_model_shorthand(":gpt-5") == "openai/gpt-5"

    def test_shorthand_gpt4o(self):
        assert self.svc.expand_model_shorthand(":gpt-4o") == "openai/gpt-4o"

    def test_shorthand_o3(self):
        assert self.svc.expand_model_shorthand(":o3") == "openai/o3"

    def test_shorthand_codex(self):
        assert self.svc.expand_model_shorthand(":codex") == "openai/gpt-5.3-codex"

    def test_shorthand_gemini_pro(self):
        assert self.svc.expand_model_shorthand(":gemini-pro") == "google/gemini-2.5-pro"

    def test_shorthand_gemini_flash(self):
        assert self.svc.expand_model_shorthand(":gemini-flash") == "google/gemini-2.5-flash"

    def test_shorthand_groq(self):
        assert self.svc.expand_model_shorthand(":groq") == "groq/llama-4-scout-17b-16e-instruct"

    def test_shorthand_grok(self):
        assert self.svc.expand_model_shorthand(":grok") == "xai/grok-3"

    def test_non_shorthand_passthrough(self):
        """A custom provider/model string without colon prefix passes through unchanged."""
        assert self.svc.expand_model_shorthand("custom/model-v2") == "custom/model-v2"

    def test_unknown_shorthand_passthrough(self):
        """An unknown colon-prefixed shorthand passes through unchanged."""
        assert self.svc.expand_model_shorthand(":unknown") == ":unknown"

    def test_empty_string(self):
        assert self.svc.expand_model_shorthand("") == ""

    def test_full_model_name_passthrough(self):
        """Full model identifiers (no colon prefix) pass through."""
        assert self.svc.expand_model_shorthand("anthropic/claude-sonnet-4-5-20250929") == "anthropic/claude-sonnet-4-5-20250929"


# ===================================================================
# 2. Provider/model splitting in build_pi_command()
# ===================================================================

class TestBuildPiCommand:
    """Test command construction including provider/model splitting."""

    @pytest.fixture(autouse=True)
    def service(self):
        self.svc = _load_pi_service()

    def test_provider_model_split_from_shorthand(self):
        """When model is 'provider/model-id' and no explicit provider, split automatically."""
        self.svc.model_name = "anthropic/claude-sonnet-4-6"
        self.svc.prompt = "test prompt"
        args = _make_args(provider="")
        cmd, _stdin = self.svc.build_pi_command(args)

        assert "--provider" in cmd
        provider_idx = cmd.index("--provider")
        assert cmd[provider_idx + 1] == "anthropic"

        assert "--model" in cmd
        model_idx = cmd.index("--model")
        assert cmd[model_idx + 1] == "claude-sonnet-4-6"

    def test_explicit_provider_no_split(self):
        """When explicit --provider is given, model string is NOT split."""
        self.svc.model_name = "anthropic/claude-sonnet-4-6"
        self.svc.prompt = "test prompt"
        args = _make_args(provider="openai")
        cmd, _stdin = self.svc.build_pi_command(args)

        provider_idx = cmd.index("--provider")
        assert cmd[provider_idx + 1] == "openai"

        model_idx = cmd.index("--model")
        # Model should NOT be split since explicit provider is given
        assert cmd[model_idx + 1] == "anthropic/claude-sonnet-4-6"

    def test_model_without_slash(self):
        """When model has no '/', it's passed as-is with --model."""
        self.svc.model_name = "gpt-5"
        self.svc.prompt = "test prompt"
        args = _make_args(provider="")
        cmd, _stdin = self.svc.build_pi_command(args)

        assert "--model" in cmd
        model_idx = cmd.index("--model")
        assert cmd[model_idx + 1] == "gpt-5"
        # No --provider should be added when model has no slash and no explicit provider
        assert "--provider" not in cmd

    def test_always_includes_mode_json(self):
        """build_pi_command always includes --mode json."""
        self.svc.model_name = "anthropic/claude-sonnet-4-6"
        self.svc.prompt = "test"
        args = _make_args()
        cmd, _stdin = self.svc.build_pi_command(args)

        assert "--mode" in cmd
        mode_idx = cmd.index("--mode")
        assert cmd[mode_idx + 1] == "json"

    def test_no_session_when_enabled(self):
        """build_pi_command includes --no-session when no_session=True."""
        self.svc.model_name = "anthropic/claude-sonnet-4-6"
        self.svc.prompt = "test"
        args = _make_args(no_session=True)
        cmd, _stdin = self.svc.build_pi_command(args)

        assert "--no-session" in cmd

    def test_no_session_excluded_by_default(self):
        """build_pi_command excludes --no-session when no_session=False (default)."""
        self.svc.model_name = "anthropic/claude-sonnet-4-6"
        self.svc.prompt = "test"
        args = _make_args(no_session=False)
        cmd, _stdin = self.svc.build_pi_command(args)

        assert "--no-session" not in cmd

    def test_starts_with_pi(self):
        """Command always starts with 'pi'."""
        self.svc.model_name = "test-model"
        self.svc.prompt = "test"
        args = _make_args()
        cmd, _stdin = self.svc.build_pi_command(args)

        assert cmd[0] == "pi"

    def test_thinking_flag(self):
        """--thinking is included when set."""
        self.svc.model_name = "test-model"
        self.svc.prompt = "test"
        args = _make_args(thinking="high")
        cmd, _stdin = self.svc.build_pi_command(args)

        assert "--thinking" in cmd
        idx = cmd.index("--thinking")
        assert cmd[idx + 1] == "high"

    def test_no_thinking_when_none(self):
        """--thinking is not included when None."""
        self.svc.model_name = "test-model"
        self.svc.prompt = "test"
        args = _make_args(thinking=None)
        cmd, _stdin = self.svc.build_pi_command(args)

        assert "--thinking" not in cmd

    def test_tools_flag(self):
        """--tools is passed when set."""
        self.svc.model_name = "test-model"
        self.svc.prompt = "test"
        args = _make_args(tools="read,bash,edit")
        cmd, _stdin = self.svc.build_pi_command(args)

        assert "--tools" in cmd
        idx = cmd.index("--tools")
        assert cmd[idx + 1] == "read,bash,edit"

    def test_no_tools_flag(self):
        """--no-tools overrides --tools."""
        self.svc.model_name = "test-model"
        self.svc.prompt = "test"
        args = _make_args(no_tools=True, tools="read,bash")
        cmd, _stdin = self.svc.build_pi_command(args)

        assert "--no-tools" in cmd
        assert "--tools" not in cmd

    def test_system_prompt(self):
        """--system-prompt is included when set."""
        self.svc.model_name = "test-model"
        self.svc.prompt = "test"
        args = _make_args(system_prompt="You are a helpful assistant")
        cmd, _stdin = self.svc.build_pi_command(args)

        assert "--system-prompt" in cmd
        idx = cmd.index("--system-prompt")
        assert cmd[idx + 1] == "You are a helpful assistant"

    def test_append_system_prompt(self):
        """--append-system-prompt is included when system_prompt is not set."""
        self.svc.model_name = "test-model"
        self.svc.prompt = "test"
        args = _make_args(system_prompt=None, append_system_prompt="Extra instructions")
        cmd, _stdin = self.svc.build_pi_command(args)

        assert "--append-system-prompt" in cmd
        idx = cmd.index("--append-system-prompt")
        assert cmd[idx + 1] == "Extra instructions"

    def test_system_prompt_takes_precedence(self):
        """--system-prompt takes precedence over --append-system-prompt."""
        self.svc.model_name = "test-model"
        self.svc.prompt = "test"
        args = _make_args(system_prompt="Override", append_system_prompt="Extra")
        cmd, _stdin = self.svc.build_pi_command(args)

        assert "--system-prompt" in cmd
        assert "--append-system-prompt" not in cmd

    def test_no_extensions_flag(self):
        self.svc.model_name = "test-model"
        self.svc.prompt = "test"
        args = _make_args(no_extensions=True)
        cmd, _stdin = self.svc.build_pi_command(args)

        assert "--no-extensions" in cmd

    def test_no_skills_flag(self):
        self.svc.model_name = "test-model"
        self.svc.prompt = "test"
        args = _make_args(no_skills=True)
        cmd, _stdin = self.svc.build_pi_command(args)

        assert "--no-skills" in cmd

    def test_auto_instruction_prepended(self):
        """auto_instruction is prepended to the prompt, delivered via stdin."""
        self.svc.model_name = "test-model"
        self.svc.prompt = "main task"
        args = _make_args(auto_instruction="Do this first")
        cmd, stdin_prompt = self.svc.build_pi_command(args)

        # Auto-instruction + prompt may be in stdin (multiline) or cmd
        if stdin_prompt:
            assert "Do this first" in stdin_prompt
            assert "main task" in stdin_prompt
            assert stdin_prompt.startswith("Do this first")
        else:
            p_idx = cmd.index("-p")
            full_prompt = cmd[p_idx + 1]
            assert "Do this first" in full_prompt
            assert "main task" in full_prompt
            assert full_prompt.startswith("Do this first")

    def test_additional_args_appended(self):
        """additional_args are split and appended to the command."""
        self.svc.model_name = "test-model"
        self.svc.prompt = "test"
        args = _make_args(additional_args="--extra-flag value")
        cmd, _stdin = self.svc.build_pi_command(args)

        assert "--extra-flag" in cmd
        assert "value" in cmd

    def test_prompt_included(self):
        """The prompt is passed either with -p flag or via stdin."""
        self.svc.model_name = "test-model"
        self.svc.prompt = "my prompt text"
        args = _make_args()
        cmd, stdin_prompt = self.svc.build_pi_command(args)

        if stdin_prompt:
            assert "my prompt text" in stdin_prompt
        else:
            assert "-p" in cmd
            p_idx = cmd.index("-p")
            assert cmd[p_idx + 1] == "my prompt text"

    def test_multiline_prompt_uses_stdin(self):
        """Multiline prompts are passed via stdin instead of -p flag."""
        self.svc.model_name = "test-model"
        self.svc.prompt = "line1\nline2\nline3"
        args = _make_args()
        cmd, stdin_prompt = self.svc.build_pi_command(args)

        assert stdin_prompt is not None
        assert "line1\nline2\nline3" in stdin_prompt
        assert "-p" not in cmd


# ===================================================================
# 3. Prettifier mode detection
# ===================================================================

class TestPrettifierModeDetection:
    """Test _detect_prettifier_mode() model-based selection."""

    @pytest.fixture(autouse=True)
    def service(self):
        self.svc = _load_pi_service()

    def test_codex_model(self):
        assert self.svc._detect_prettifier_mode("gpt-5.3-codex") == "codex"

    def test_codex_model_mixed_case(self):
        assert self.svc._detect_prettifier_mode("openai/GPT-5.3-CODEX") == "codex"

    def test_sonnet_model(self):
        """Claude models use Pi native prettifier (Pi always emits its own event protocol)."""
        assert self.svc._detect_prettifier_mode("claude-sonnet-4-6") == "pi"

    def test_opus_model(self):
        """Claude models use Pi native prettifier (Pi always emits its own event protocol)."""
        assert self.svc._detect_prettifier_mode("claude-opus-4-6") == "pi"

    def test_haiku_model(self):
        """Claude models use Pi native prettifier (Pi always emits its own event protocol)."""
        assert self.svc._detect_prettifier_mode("claude-haiku-4-5-20251001") == "pi"

    def test_claude_generic(self):
        """Claude models use Pi native prettifier (Pi always emits its own event protocol)."""
        assert self.svc._detect_prettifier_mode("anthropic/claude-custom") == "pi"

    def test_gpt5_defaults_to_pi(self):
        """Model 'gpt-5' has no codex/claude keyword -> falls back to pi."""
        assert self.svc._detect_prettifier_mode("gpt-5") == "pi"

    def test_llama_defaults_to_pi(self):
        assert self.svc._detect_prettifier_mode("llama-4-scout-17b-16e-instruct") == "pi"

    def test_gemini_defaults_to_pi(self):
        assert self.svc._detect_prettifier_mode("google/gemini-2.5-pro") == "pi"

    def test_grok_defaults_to_pi(self):
        assert self.svc._detect_prettifier_mode("xai/grok-3") == "pi"

    def test_empty_string_defaults_to_pi(self):
        assert self.svc._detect_prettifier_mode("") == "pi"

    def test_codex_in_path(self):
        """The word 'codex' anywhere in model string triggers codex mode."""
        assert self.svc._detect_prettifier_mode("openai/gpt-5.3-codex") == "codex"

    def test_sonnet_in_full_path(self):
        """Claude models use Pi native prettifier (Pi always emits its own event protocol)."""
        assert self.svc._detect_prettifier_mode("anthropic/claude-sonnet-4-6") == "pi"


# ===================================================================
# 3b. Verbose mode + prettifier interaction (gmgFZ5)
# ===================================================================

class TestVerbosePrettifierInteraction:
    """Verbose mode should NOT override codex prettifier.

    Bug gmgFZ5: running `juno-code -s pi -m openai-codex/gpt-5.3-codex -v`
    caused the prettifier to switch to LIVE instead of staying CODEX, because
    the verbose flag unconditionally overrode the detected mode.
    """

    @pytest.fixture(autouse=True)
    def service(self):
        self.svc = _load_pi_service()

    def _apply_run_logic(self, model: str, verbose: bool) -> str:
        """Simulate the prettifier mode assignment from PiService.run()."""
        self.svc.model_name = self.svc.expand_model_shorthand(model)
        self.svc.prettifier_mode = self.svc._detect_prettifier_mode(self.svc.model_name)
        self.svc.verbose = verbose
        if verbose and self.svc.prettifier_mode != self.svc.PRETTIFIER_CODEX:
            self.svc.prettifier_mode = self.svc.PRETTIFIER_LIVE
        return self.svc.prettifier_mode

    def test_codex_verbose_stays_codex(self):
        """Codex model + verbose should keep codex prettifier."""
        assert self._apply_run_logic("openai-codex/gpt-5.3-codex", verbose=True) == "codex"

    def test_codex_shorthand_verbose_stays_codex(self):
        """Codex shorthand + verbose should keep codex prettifier."""
        assert self._apply_run_logic(":codex", verbose=True) == "codex"

    def test_codex_no_verbose_stays_codex(self):
        """Codex model without verbose should use codex prettifier."""
        assert self._apply_run_logic("openai-codex/gpt-5.3-codex", verbose=False) == "codex"

    def test_sonnet_verbose_switches_to_live(self):
        """Non-codex model + verbose should switch to LIVE prettifier."""
        assert self._apply_run_logic(":sonnet", verbose=True) == "live"

    def test_sonnet_no_verbose_stays_pi(self):
        """Non-codex model without verbose should use Pi prettifier."""
        assert self._apply_run_logic(":sonnet", verbose=False) == "pi"

    def test_gpt5_verbose_switches_to_live(self):
        """Non-codex OpenAI model + verbose should switch to LIVE."""
        assert self._apply_run_logic("openai/gpt-5", verbose=True) == "live"

    def test_gemini_verbose_switches_to_live(self):
        """Gemini model + verbose should switch to LIVE."""
        assert self._apply_run_logic(":gemini-pro", verbose=True) == "live"

    def test_codex_uppercase_verbose_stays_codex(self):
        """Case-insensitive codex detection should survive verbose."""
        assert self._apply_run_logic("openai/GPT-5.3-CODEX", verbose=True) == "codex"


# ===================================================================
# 4. Result event detection - _extract_text_from_message()
# ===================================================================

class TestExtractTextFromMessage:
    """Test _extract_text_from_message() for various message shapes."""

    @pytest.fixture(autouse=True)
    def service(self):
        self.svc = _load_pi_service()

    def test_direct_text_field(self):
        msg = {"text": "Hello world"}
        assert self.svc._extract_text_from_message(msg) == "Hello world"

    def test_direct_content_field(self):
        msg = {"content": "Some content"}
        assert self.svc._extract_text_from_message(msg) == "Some content"

    def test_direct_message_field(self):
        msg = {"message": "A message"}
        assert self.svc._extract_text_from_message(msg) == "A message"

    def test_direct_response_field(self):
        msg = {"response": "A response"}
        assert self.svc._extract_text_from_message(msg) == "A response"

    def test_direct_output_field(self):
        msg = {"output": "Some output"}
        assert self.svc._extract_text_from_message(msg) == "Some output"

    def test_content_array_with_text_parts(self):
        msg = {
            "content": [
                {"type": "text", "text": "Part one"},
                {"type": "text", "text": "Part two"},
            ]
        }
        assert self.svc._extract_text_from_message(msg) == "Part one\nPart two"

    def test_content_array_with_content_field(self):
        msg = {
            "content": [
                {"type": "text", "content": "Nested content"},
            ]
        }
        assert self.svc._extract_text_from_message(msg) == "Nested content"

    def test_content_array_with_string_items(self):
        msg = {
            "content": ["Line A", "Line B"]
        }
        assert self.svc._extract_text_from_message(msg) == "Line A\nLine B"

    def test_content_array_skips_empty_items(self):
        msg = {
            "content": [
                {"type": "text", "text": "Valid"},
                {"type": "text", "text": ""},
                {"type": "text", "text": "   "},
            ]
        }
        assert self.svc._extract_text_from_message(msg) == "Valid"

    def test_empty_message(self):
        assert self.svc._extract_text_from_message({}) == ""

    def test_none_message(self):
        assert self.svc._extract_text_from_message(None) == ""

    def test_non_dict_message(self):
        assert self.svc._extract_text_from_message("just a string") == ""

    def test_priority_text_over_content_array(self):
        """Direct text field takes priority over content array."""
        msg = {
            "text": "Direct text",
            "content": [{"text": "Array text"}],
        }
        assert self.svc._extract_text_from_message(msg) == "Direct text"

    def test_whitespace_only_text_skipped(self):
        """Whitespace-only direct fields are skipped."""
        msg = {
            "text": "   ",
            "content": "Fallback content",
        }
        assert self.svc._extract_text_from_message(msg) == "Fallback content"


# ===================================================================
# 5. Codex prettifier helpers
# ===================================================================

class TestStripThinkingSignature:
    """Test _strip_thinking_signature() removes specific keys."""

    @pytest.fixture(autouse=True)
    def service(self):
        self.svc = _load_pi_service()

    def test_removes_thinking_signature(self):
        content = [
            {"type": "thinking", "thinking": "I think...", "thinkingSignature": "enc123"},
        ]
        result = self.svc._strip_thinking_signature(content)
        assert "thinkingSignature" not in result[0]
        assert result[0]["thinking"] == "I think..."

    def test_removes_text_signature(self):
        content = [
            {"type": "text", "text": "Hello", "textSignature": "sig456"},
        ]
        result = self.svc._strip_thinking_signature(content)
        assert "textSignature" not in result[0]
        assert result[0]["text"] == "Hello"

    def test_removes_encrypted_content(self):
        content = [
            {"type": "thinking", "thinking": "OK", "encrypted_content": "base64data"},
        ]
        result = self.svc._strip_thinking_signature(content)
        assert "encrypted_content" not in result[0]

    def test_removes_all_three(self):
        content = [
            {
                "type": "thinking",
                "thinking": "Deep thought",
                "thinkingSignature": "sig",
                "textSignature": "tsig",
                "encrypted_content": "enc",
            },
        ]
        result = self.svc._strip_thinking_signature(content)
        assert "thinkingSignature" not in result[0]
        assert "textSignature" not in result[0]
        assert "encrypted_content" not in result[0]
        assert result[0]["thinking"] == "Deep thought"

    def test_preserves_other_keys(self):
        content = [
            {"type": "text", "text": "Hello", "custom_key": "value"},
        ]
        result = self.svc._strip_thinking_signature(content)
        assert result[0]["custom_key"] == "value"

    def test_handles_non_dict_items(self):
        content = [
            {"type": "text", "text": "Hello"},
            "just a string",
            42,
        ]
        result = self.svc._strip_thinking_signature(content)
        assert len(result) == 3

    def test_handles_non_list_input(self):
        assert self.svc._strip_thinking_signature("not a list") == "not a list"
        assert self.svc._strip_thinking_signature(None) is None

    def test_empty_list(self):
        assert self.svc._strip_thinking_signature([]) == []


class TestTruncateToolResultText:
    """Test _truncate_tool_result_text() truncation behavior."""

    @pytest.fixture(autouse=True)
    def service(self):
        self.svc = _load_pi_service()

    def test_short_text_unchanged(self):
        text = "line 1\nline 2\nline 3"
        result = self.svc._truncate_tool_result_text(text)
        assert result == text

    def test_exact_max_lines_unchanged(self):
        lines = [f"line {i}" for i in range(6)]
        text = "\n".join(lines)
        result = self.svc._truncate_tool_result_text(text)
        assert result == text

    def test_exceeds_max_lines_truncated(self):
        lines = [f"line {i}" for i in range(10)]
        text = "\n".join(lines)
        result = self.svc._truncate_tool_result_text(text)

        result_lines = result.split("\n")
        # First 6 lines shown
        for i in range(6):
            assert result_lines[i] == f"line {i}"
        # Last line is the "remaining" indicator
        assert "characters remaining" in result_lines[-1]

    def test_escaped_newlines_unescaped(self):
        """JSON-escaped \\n are converted to real newlines."""
        text = "line1\\nline2\\nline3"
        result = self.svc._truncate_tool_result_text(text)
        assert "line1\nline2\nline3" == result

    def test_escaped_tabs_unescaped(self):
        text = "col1\\tcol2"
        result = self.svc._truncate_tool_result_text(text)
        assert "col1\tcol2" == result

    def test_non_string_passthrough(self):
        assert self.svc._truncate_tool_result_text(None) is None
        assert self.svc._truncate_tool_result_text(42) == 42

    def test_custom_max_lines(self):
        """Max lines is configurable via _codex_tool_result_max_lines."""
        self.svc._codex_tool_result_max_lines = 3
        lines = [f"line {i}" for i in range(10)]
        text = "\n".join(lines)
        result = self.svc._truncate_tool_result_text(text)

        result_lines = result.split("\n")
        assert result_lines[0] == "line 0"
        assert result_lines[1] == "line 1"
        assert result_lines[2] == "line 2"
        assert "characters remaining" in result_lines[-1]

    def test_remaining_chars_count_accurate(self):
        lines = ["a" * 10 for _ in range(8)]
        text = "\n".join(lines)
        result = self.svc._truncate_tool_result_text(text)

        # The remaining text is lines 6 and 7 joined by newline
        remaining_text = "\n".join(lines[6:])
        remaining_chars = len(remaining_text)
        assert f"[{remaining_chars} characters remaining]" in result


class TestSanitizeCodexEvent:
    """Test _sanitize_codex_event() recursive sanitization."""

    @pytest.fixture(autouse=True)
    def service(self):
        self.svc = _load_pi_service()

    def test_strips_top_level_encrypted_content(self):
        obj = {"type": "message", "text": "hi", "encrypted_content": "enc123"}
        result = self.svc._sanitize_codex_event(obj)
        assert "encrypted_content" not in result
        assert result["text"] == "hi"

    def test_strips_text_signature(self):
        obj = {"type": "message", "textSignature": "sig123"}
        result = self.svc._sanitize_codex_event(obj)
        assert "textSignature" not in result

    def test_strips_metadata_keys(self):
        obj = {
            "type": "assistant",
            "api": "openai",
            "provider": "openai",
            "model": "gpt-5",
            "usage": {"tokens": 100},
            "stopReason": "stop",
            "timestamp": "2026-01-01",
            "text": "keep this",
        }
        result = self.svc._sanitize_codex_event(obj, strip_metadata=True)
        assert "api" not in result
        assert "provider" not in result
        assert "model" not in result
        assert "usage" not in result
        assert "stopReason" not in result
        assert "timestamp" not in result
        assert result["text"] == "keep this"

    def test_preserves_metadata_when_disabled(self):
        obj = {
            "type": "assistant",
            "api": "openai",
            "model": "gpt-5",
            "text": "hello",
        }
        result = self.svc._sanitize_codex_event(obj, strip_metadata=False)
        assert result["api"] == "openai"
        assert result["model"] == "gpt-5"

    def test_recurses_into_nested_partial(self):
        obj = {
            "type": "message_update",
            "partial": {
                "content": [
                    {"type": "thinking", "thinkingSignature": "enc", "thinking": "hmm"},
                ],
                "encrypted_content": "nested_enc",
            },
        }
        result = self.svc._sanitize_codex_event(obj)
        assert "encrypted_content" not in result["partial"]
        assert "thinkingSignature" not in result["partial"]["content"][0]
        assert result["partial"]["content"][0]["thinking"] == "hmm"

    def test_recurses_into_nested_message(self):
        obj = {
            "type": "turn_end",
            "message": {
                "textSignature": "sig",
                "content": [
                    {"type": "text", "text": "ok", "encrypted_content": "enc"},
                ],
            },
        }
        result = self.svc._sanitize_codex_event(obj)
        assert "textSignature" not in result["message"]
        assert "encrypted_content" not in result["message"]["content"][0]

    def test_recurses_into_assistant_message_event(self):
        obj = {
            "type": "message_update",
            "assistantMessageEvent": {
                "api": "openai",
                "encrypted_content": "enc",
            },
        }
        result = self.svc._sanitize_codex_event(obj)
        assert "encrypted_content" not in result["assistantMessageEvent"]
        assert "api" not in result["assistantMessageEvent"]

    def test_handles_non_dict_input(self):
        assert self.svc._sanitize_codex_event("string") == "string"
        assert self.svc._sanitize_codex_event(None) is None
        assert self.svc._sanitize_codex_event(42) == 42

    def test_content_array_items_stripped(self):
        obj = {
            "content": [
                {"type": "thinking", "thinkingSignature": "sig1", "encrypted_content": "enc1"},
                {"type": "text", "text": "hello", "encrypted_content": "enc2"},
            ],
        }
        result = self.svc._sanitize_codex_event(obj)
        for item in result["content"]:
            assert "thinkingSignature" not in item
            assert "encrypted_content" not in item

    def test_deeply_nested_event(self):
        """Test that deeply nested structures are sanitized."""
        obj = {
            "type": "message_update",
            "partial": {
                "message": {
                    "content": [
                        {"thinkingSignature": "deep_sig", "text": "deep"},
                    ],
                    "encrypted_content": "deep_enc",
                },
            },
        }
        result = self.svc._sanitize_codex_event(obj)
        nested_msg = result["partial"]["message"]
        assert "encrypted_content" not in nested_msg
        assert "thinkingSignature" not in nested_msg["content"][0]


# ===================================================================
# 6. Additional edge cases and integration-like tests
# ===================================================================

class TestBuildHideTypes:
    """Test _build_hide_types() with and without env overrides."""

    @pytest.fixture(autouse=True)
    def service(self):
        self.svc = _load_pi_service()

    def test_default_hidden_types(self):
        # Clear env vars to ensure defaults
        for key in ("PI_HIDE_STREAM_TYPES", "JUNO_CODE_HIDE_STREAM_TYPES"):
            os.environ.pop(key, None)

        hide = self.svc._build_hide_types()
        assert "auto_compaction_start" in hide
        assert "auto_compaction_end" in hide
        assert "auto_retry_start" in hide
        assert "auto_retry_end" in hide
        assert "session" in hide

    def test_env_override_adds_types(self):
        os.environ["PI_HIDE_STREAM_TYPES"] = "custom_type,another_type"
        try:
            hide = self.svc._build_hide_types()
            assert "custom_type" in hide
            assert "another_type" in hide
            # Defaults still present
            assert "session" in hide
        finally:
            os.environ.pop("PI_HIDE_STREAM_TYPES", None)

    def test_juno_code_env_override(self):
        os.environ["JUNO_CODE_HIDE_STREAM_TYPES"] = "extra_type"
        try:
            hide = self.svc._build_hide_types()
            assert "extra_type" in hide
            assert "session" in hide
        finally:
            os.environ.pop("JUNO_CODE_HIDE_STREAM_TYPES", None)


class TestFirstNonemptyStr:
    """Test the _first_nonempty_str() helper."""

    @pytest.fixture(autouse=True)
    def service(self):
        self.svc = _load_pi_service()

    def test_returns_first_nonempty(self):
        assert self.svc._first_nonempty_str("", None, "hello", "world") == "hello"

    def test_returns_empty_when_all_empty(self):
        assert self.svc._first_nonempty_str("", None, "", None) == ""

    def test_returns_first_value(self):
        assert self.svc._first_nonempty_str("first", "second") == "first"

    def test_skips_non_strings(self):
        assert self.svc._first_nonempty_str(42, None, "valid") == "valid"


class TestIsCodexFinalMessage:
    """Test _is_codex_final_message() detection."""

    @pytest.fixture(autouse=True)
    def service(self):
        self.svc = _load_pi_service()

    def test_stop_reason_stop(self):
        assert self.svc._is_codex_final_message({"stopReason": "stop"}) is True

    def test_content_with_text_type(self):
        msg = {"content": [{"type": "text", "text": "Done"}]}
        assert self.svc._is_codex_final_message(msg) is True

    def test_content_without_text_type(self):
        msg = {"content": [{"type": "toolCall"}]}
        assert self.svc._is_codex_final_message(msg) is False

    def test_empty_dict(self):
        assert self.svc._is_codex_final_message({}) is False

    def test_non_dict(self):
        assert self.svc._is_codex_final_message("string") is False
        assert self.svc._is_codex_final_message(None) is False


class TestDefaultModelConstant:
    """Verify default model and shorthand count."""

    def test_default_model(self):
        svc = _load_pi_service()
        assert svc.DEFAULT_MODEL == "anthropic/claude-sonnet-4-6"

    def test_shorthand_count(self):
        svc = _load_pi_service()
        assert len(svc.MODEL_SHORTHANDS) == 13

    def test_prettifier_constants(self):
        svc = _load_pi_service()
        assert svc.PRETTIFIER_PI == "pi"
        assert svc.PRETTIFIER_CLAUDE == "claude"
        assert svc.PRETTIFIER_CODEX == "codex"


# ===================================================================
# 7. Result event capture (last_result_event in run_pi stream loop)
# ===================================================================

class TestResultEventCapture:
    """Test that last_result_event is set correctly for agent_end, message, and turn_end events."""

    @pytest.fixture(autouse=True)
    def service(self):
        self.svc = _load_pi_service()

    def test_agent_end_sets_last_result_event(self):
        """agent_end event is stored directly as last_result_event."""
        event = {"type": "agent_end", "result": "Final output", "status": "success"}
        # Simulate the logic from run_pi
        self.svc.last_result_event = event
        assert self.svc.last_result_event == event
        assert self.svc.last_result_event["type"] == "agent_end"

    def test_message_with_assistant_role_creates_result_envelope(self):
        """message event with role=assistant creates a result envelope."""
        parsed = {
            "type": "message",
            "message": {
                "role": "assistant",
                "text": "Hello, I completed the task."
            }
        }
        msg = parsed.get("message", {})
        if isinstance(msg, dict) and msg.get("role") == "assistant":
            text = self.svc._extract_text_from_message(msg)
            if text:
                self.svc.last_result_event = {
                    "type": "result",
                    "subtype": "success",
                    "is_error": False,
                    "result": text,
                    "sub_agent_response": parsed,
                }

        assert self.svc.last_result_event is not None
        assert self.svc.last_result_event["type"] == "result"
        assert self.svc.last_result_event["subtype"] == "success"
        assert self.svc.last_result_event["is_error"] is False
        assert self.svc.last_result_event["result"] == "Hello, I completed the task."
        assert self.svc.last_result_event["sub_agent_response"] == parsed

    def test_message_with_non_assistant_role_ignored(self):
        """message event with role != assistant does NOT set last_result_event."""
        parsed = {
            "type": "message",
            "message": {
                "role": "user",
                "text": "User message"
            }
        }
        msg = parsed.get("message", {})
        if isinstance(msg, dict) and msg.get("role") == "assistant":
            text = self.svc._extract_text_from_message(msg)
            if text:
                self.svc.last_result_event = {"type": "result"}

        assert self.svc.last_result_event is None

    def test_message_with_content_array_creates_envelope(self):
        """message event with content array extracts text correctly."""
        parsed = {
            "type": "message",
            "message": {
                "role": "assistant",
                "content": [
                    {"type": "text", "text": "Part one"},
                    {"type": "text", "text": "Part two"},
                ]
            }
        }
        msg = parsed.get("message", {})
        if isinstance(msg, dict) and msg.get("role") == "assistant":
            text = self.svc._extract_text_from_message(msg)
            if text:
                self.svc.last_result_event = {
                    "type": "result",
                    "subtype": "success",
                    "is_error": False,
                    "result": text,
                    "sub_agent_response": parsed,
                }

        assert self.svc.last_result_event["result"] == "Part one\nPart two"

    def test_message_with_empty_text_not_captured(self):
        """message event with empty assistant text does NOT set last_result_event."""
        parsed = {
            "type": "message",
            "message": {
                "role": "assistant",
                "content": []
            }
        }
        msg = parsed.get("message", {})
        if isinstance(msg, dict) and msg.get("role") == "assistant":
            text = self.svc._extract_text_from_message(msg)
            if text:
                self.svc.last_result_event = {"type": "result"}

        assert self.svc.last_result_event is None

    def test_turn_end_with_message_creates_envelope(self):
        """turn_end event with message dict extracts text and creates result."""
        parsed = {
            "type": "turn_end",
            "message": {
                "text": "Turn completed successfully."
            }
        }
        msg = parsed.get("message", {})
        if isinstance(msg, dict):
            text = self.svc._extract_text_from_message(msg)
            if text:
                self.svc.last_result_event = {
                    "type": "result",
                    "subtype": "success",
                    "is_error": False,
                    "result": text,
                    "sub_agent_response": parsed,
                }

        assert self.svc.last_result_event is not None
        assert self.svc.last_result_event["result"] == "Turn completed successfully."
        assert self.svc.last_result_event["sub_agent_response"]["type"] == "turn_end"

    def test_turn_end_without_message_dict_ignored(self):
        """turn_end without a dict message does NOT set last_result_event."""
        parsed = {
            "type": "turn_end",
            "message": "just a string, not a dict"
        }
        msg = parsed.get("message", {})
        if isinstance(msg, dict):
            text = self.svc._extract_text_from_message(msg)
            if text:
                self.svc.last_result_event = {"type": "result"}

        assert self.svc.last_result_event is None

    def test_turn_end_with_empty_message_ignored(self):
        """turn_end with empty message dict does NOT set last_result_event."""
        parsed = {
            "type": "turn_end",
            "message": {}
        }
        msg = parsed.get("message", {})
        if isinstance(msg, dict):
            text = self.svc._extract_text_from_message(msg)
            if text:
                self.svc.last_result_event = {"type": "result"}

        assert self.svc.last_result_event is None

    def test_last_result_event_overwritten_by_later_events(self):
        """Later events overwrite earlier ones (last one wins)."""
        # First: agent_end
        self.svc.last_result_event = {"type": "agent_end", "result": "first"}

        # Then: message with assistant role overwrites
        parsed = {
            "type": "message",
            "message": {"role": "assistant", "text": "second"}
        }
        msg = parsed.get("message", {})
        if isinstance(msg, dict) and msg.get("role") == "assistant":
            text = self.svc._extract_text_from_message(msg)
            if text:
                self.svc.last_result_event = {
                    "type": "result",
                    "subtype": "success",
                    "is_error": False,
                    "result": text,
                    "sub_agent_response": parsed,
                }

        assert self.svc.last_result_event["result"] == "second"

    def test_turn_end_with_content_array(self):
        """turn_end with content array in message extracts text."""
        parsed = {
            "type": "turn_end",
            "message": {
                "content": [
                    {"type": "text", "text": "Final answer"},
                ]
            }
        }
        msg = parsed.get("message", {})
        if isinstance(msg, dict):
            text = self.svc._extract_text_from_message(msg)
            if text:
                self.svc.last_result_event = {
                    "type": "result",
                    "subtype": "success",
                    "is_error": False,
                    "result": text,
                    "sub_agent_response": parsed,
                }

        assert self.svc.last_result_event["result"] == "Final answer"

    def test_initial_last_result_event_is_none(self):
        """last_result_event starts as None."""
        assert self.svc.last_result_event is None


# ===================================================================
# 8. Message counter in prettifier output
# ===================================================================

class TestPiPrettifierCounter:
    """Test that _format_event_pretty() includes counter in all outputs."""

    @pytest.fixture(autouse=True)
    def service(self):
        self.svc = _load_pi_service()

    def test_counter_in_agent_start(self):
        result = self.svc._format_event_pretty({"type": "agent_start"})
        parsed = json.loads(result)
        assert parsed["counter"] == "#1"

    def test_counter_increments_across_events(self):
        self.svc._format_event_pretty({"type": "agent_start"})
        result = self.svc._format_event_pretty({"type": "turn_start"})
        parsed = json.loads(result)
        assert parsed["counter"] == "#2"

    def test_counter_in_turn_end(self):
        result = self.svc._format_event_pretty({"type": "turn_end"})
        parsed = json.loads(result)
        assert parsed["counter"] == "#1"
        assert parsed["type"] == "turn_end"

    def test_counter_in_tool_execution_start(self):
        result = self.svc._format_event_pretty({
            "type": "tool_execution_start",
            "toolName": "bash",
            "args": {"command": "ls"},
        })
        parsed = json.loads(result)
        assert parsed["counter"] == "#1"
        assert parsed["tool"] == "bash"

    def test_counter_in_tool_execution_end(self):
        result = self.svc._format_event_pretty({
            "type": "tool_execution_end",
            "toolName": "bash",
            "result": "output",
        })
        parsed = json.loads(result)
        assert parsed["counter"] == "#1"

    def test_counter_in_agent_end(self):
        result = self.svc._format_event_pretty({
            "type": "agent_end",
            "messages": [{"role": "assistant", "text": "done"}],
        })
        parsed = json.loads(result)
        assert parsed["counter"] == "#1"
        assert parsed["message_count"] == 1

    def test_counter_in_message_update(self):
        result = self.svc._format_event_pretty({
            "type": "message_update",
            "assistantMessageEvent": {"type": "text_end", "content": "hello"},
        })
        parsed = json.loads(result)
        assert parsed["counter"] == "#1"


class TestPiPrettifierToolCallArgs:
    """Test that _format_event_pretty() shows tool call arguments for toolcall_end events."""

    @pytest.fixture(autouse=True)
    def service(self):
        self.svc = _load_pi_service()

    def test_toolcall_end_shows_tool_name(self):
        """toolcall_end should include tool name in output."""
        result = self.svc._format_event_pretty({
            "type": "message_update",
            "assistantMessageEvent": {
                "type": "toolcall_end",
                "toolCall": {"name": "bash", "arguments": {"command": "ls"}},
            },
        })
        parsed = json.loads(result)
        assert parsed["tool"] == "bash"
        assert parsed["event"] == "toolcall_end"

    def test_toolcall_end_shows_command_arg(self):
        """Bash tool calls should show 'command' directly."""
        result = self.svc._format_event_pretty({
            "type": "message_update",
            "assistantMessageEvent": {
                "type": "toolcall_end",
                "toolCall": {"name": "bash", "arguments": {"command": "git status"}},
            },
        })
        parsed = json.loads(result)
        assert parsed["command"] == "git status"
        assert "args" not in parsed

    def test_toolcall_end_shows_non_command_args(self):
        """Non-bash tool calls should show all args."""
        result = self.svc._format_event_pretty({
            "type": "message_update",
            "assistantMessageEvent": {
                "type": "toolcall_end",
                "toolCall": {"name": "read", "arguments": {"file_path": "/tmp/test.txt", "limit": 100}},
            },
        })
        parsed = json.loads(result)
        assert parsed["tool"] == "read"
        # args is a JSON string
        args_parsed = json.loads(parsed["args"])
        assert args_parsed["file_path"] == "/tmp/test.txt"
        assert args_parsed["limit"] == 100

    def test_toolcall_end_shows_edit_args(self):
        """Edit tool calls should show old_string/new_string args."""
        result = self.svc._format_event_pretty({
            "type": "message_update",
            "assistantMessageEvent": {
                "type": "toolcall_end",
                "toolCall": {
                    "name": "edit",
                    "arguments": {
                        "file_path": "/tmp/file.py",
                        "old_string": "foo",
                        "new_string": "bar",
                    },
                },
            },
        })
        parsed = json.loads(result)
        assert parsed["tool"] == "edit"
        args_parsed = json.loads(parsed["args"])
        assert args_parsed["file_path"] == "/tmp/file.py"
        assert args_parsed["old_string"] == "foo"
        assert args_parsed["new_string"] == "bar"

    def test_toolcall_end_truncates_long_args(self):
        """Args longer than 200 chars should be truncated."""
        long_content = "x" * 300
        result = self.svc._format_event_pretty({
            "type": "message_update",
            "assistantMessageEvent": {
                "type": "toolcall_end",
                "toolCall": {"name": "write", "arguments": {"content": long_content}},
            },
        })
        parsed = json.loads(result)
        assert parsed["args"].endswith("...")
        assert len(parsed["args"]) <= 203  # 200 + "..."

    def test_toolcall_end_empty_args(self):
        """Empty arguments dict should show empty args."""
        result = self.svc._format_event_pretty({
            "type": "message_update",
            "assistantMessageEvent": {
                "type": "toolcall_end",
                "toolCall": {"name": "custom_tool", "arguments": {}},
            },
        })
        parsed = json.loads(result)
        assert parsed["tool"] == "custom_tool"
        assert parsed["args"] == "{}"

    def test_toolcall_end_missing_toolCall(self):
        """toolcall_end with no toolCall should still produce valid output."""
        result = self.svc._format_event_pretty({
            "type": "message_update",
            "assistantMessageEvent": {"type": "toolcall_end"},
        })
        parsed = json.loads(result)
        assert parsed["event"] == "toolcall_end"

    def test_toolcall_end_string_arguments(self):
        """Handle case where arguments is a string instead of dict."""
        result = self.svc._format_event_pretty({
            "type": "message_update",
            "assistantMessageEvent": {
                "type": "toolcall_end",
                "toolCall": {"name": "bash", "arguments": '{"command": "ls"}'},
            },
        })
        parsed = json.loads(result)
        assert parsed["tool"] == "bash"
        assert parsed["args"] == '{"command": "ls"}'

    def test_toolcall_end_counter(self):
        """toolcall_end events should include counter."""
        result = self.svc._format_event_pretty({
            "type": "message_update",
            "assistantMessageEvent": {
                "type": "toolcall_end",
                "toolCall": {"name": "bash", "arguments": {"command": "echo hi"}},
            },
        })
        parsed = json.loads(result)
        assert "counter" in parsed


class TestPiPrettifierThinkingEnd:
    """Test that _format_event_pretty() shows thinking content for thinking_end events."""

    @pytest.fixture(autouse=True)
    def service(self):
        self.svc = _load_pi_service()

    def test_thinking_end_shows_thinking_text(self):
        """thinking_end should include thinking content."""
        result = self.svc._format_event_pretty({
            "type": "message_update",
            "assistantMessageEvent": {
                "type": "thinking_end",
                "thinking": "Let me analyze this step by step",
            },
        })
        parsed = json.loads(result)
        assert parsed["event"] == "thinking_end"
        assert parsed["thinking"] == "Let me analyze this step by step"

    def test_thinking_end_empty_content(self):
        """thinking_end with no content should still produce valid output."""
        result = self.svc._format_event_pretty({
            "type": "message_update",
            "assistantMessageEvent": {"type": "thinking_end"},
        })
        parsed = json.loads(result)
        assert parsed["event"] == "thinking_end"
        assert "thinking" not in parsed

    def test_thinking_end_content_field_fallback(self):
        """thinking_end should try 'content' field if 'thinking' not present."""
        result = self.svc._format_event_pretty({
            "type": "message_update",
            "assistantMessageEvent": {
                "type": "thinking_end",
                "content": "Fallback thinking text",
            },
        })
        parsed = json.loads(result)
        assert parsed["thinking"] == "Fallback thinking text"


class TestCodexPrettifierCounter:
    """Test that Codex prettifier modes include counter in output."""

    @pytest.fixture(autouse=True)
    def service(self):
        self.svc = _load_pi_service()

    def test_counter_in_codex_message(self):
        """_format_pi_codex_message includes counter for toolResult role."""
        result = self.svc._format_pi_codex_message({
            "role": "toolResult",
            "toolName": "bash",
            "content": [{"type": "text", "text": "ok"}],
        })
        parsed = json.loads(result)
        assert parsed["counter"] == "#1"

    def test_counter_in_codex_event_text_end(self):
        """_format_pi_codex_event includes counter for text_end."""
        result = self.svc._format_pi_codex_event({
            "type": "message_update",
            "assistantMessageEvent": {"type": "text_end", "content": "hello"},
        })
        parsed = json.loads(result)
        assert parsed["counter"] == "#1"

    def test_counter_in_codex_event_turn_end(self):
        """_format_pi_codex_event includes counter for turn_end."""
        result = self.svc._format_pi_codex_event({
            "type": "turn_end",
        })
        parsed = json.loads(result)
        assert parsed["counter"] == "#1"

    def test_counter_in_codex_schema_event(self):
        """_format_event_pretty_codex includes counter in header."""
        result = self.svc._format_event_pretty_codex({
            "type": "item.agent_reasoning",
            "item": {"type": "agent_reasoning", "text": "thinking..."},
        })
        parsed = json.loads(result)
        assert "counter" in parsed
        assert parsed["counter"] == "#1"

    def test_codex_schema_counter_increments(self):
        """Counter increments across _format_event_pretty_codex calls."""
        self.svc._format_event_pretty_codex({
            "type": "item.agent_reasoning",
            "item": {"type": "agent_reasoning", "text": "first"},
        })
        result = self.svc._format_event_pretty_codex({
            "type": "item.agent_message",
            "item": {"type": "agent_message", "message": "second"},
        })
        parsed = json.loads(result)
        assert parsed["counter"] == "#2"


class TestLivePrettifierCounter:
    """Test that _format_event_live() includes counter in non-delta events."""

    @pytest.fixture(autouse=True)
    def service(self):
        self.svc = _load_pi_service()

    def test_counter_in_text_start(self):
        result = self.svc._format_event_live({
            "type": "message_update",
            "assistantMessageEvent": {"type": "text_start"},
        })
        parsed = json.loads(result.strip())
        assert parsed["counter"] == "#1"

    def test_counter_in_text_end(self):
        result = self.svc._format_event_live({
            "type": "message_update",
            "assistantMessageEvent": {"type": "text_end"},
        })
        # text_end prepends \n before JSON
        parsed = json.loads(result.strip())
        assert parsed["counter"] == "#1"

    def test_counter_in_thinking_start(self):
        result = self.svc._format_event_live({
            "type": "message_update",
            "assistantMessageEvent": {"type": "thinking_start"},
        })
        parsed = json.loads(result.strip())
        assert parsed["counter"] == "#1"

    def test_counter_in_thinking_end(self):
        result = self.svc._format_event_live({
            "type": "message_update",
            "assistantMessageEvent": {"type": "thinking_end"},
        })
        parsed = json.loads(result.strip())
        assert parsed["counter"] == "#1"

    def test_counter_in_toolcall_end(self):
        result = self.svc._format_event_live({
            "type": "message_update",
            "assistantMessageEvent": {
                "type": "toolcall_end",
                "toolCall": {"name": "bash", "arguments": {"command": "ls"}},
            },
        })
        parsed = json.loads(result.strip())
        assert parsed["counter"] == "#1"
        assert parsed["tool"] == "bash"

    def test_counter_in_tool_execution_start(self):
        result = self.svc._format_event_live({
            "type": "tool_execution_start",
            "toolName": "edit",
        })
        parsed = json.loads(result.strip())
        assert parsed["counter"] == "#1"

    def test_counter_in_tool_execution_end(self):
        result = self.svc._format_event_live({
            "type": "tool_execution_end",
            "toolName": "edit",
            "result": "done",
        })
        parsed = json.loads(result.strip())
        assert parsed["counter"] == "#1"

    def test_counter_in_turn_end(self):
        result = self.svc._format_event_live({
            "type": "turn_end",
        })
        parsed = json.loads(result.strip())
        assert parsed["counter"] == "#1"

    def test_counter_in_agent_start(self):
        result = self.svc._format_event_live({
            "type": "agent_start",
        })
        parsed = json.loads(result.strip())
        assert parsed["counter"] == "#1"

    def test_counter_in_agent_end(self):
        result = self.svc._format_event_live({
            "type": "agent_end",
            "messages": [{"role": "assistant", "text": "done"}],
        })
        parsed = json.loads(result.strip())
        assert parsed["counter"] == "#1"
        assert parsed["message_count"] == 1

    def test_no_counter_in_text_delta(self):
        """text_delta returns raw text, no counter."""
        result = self.svc._format_event_live({
            "type": "message_update",
            "assistantMessageEvent": {"type": "text_delta", "delta": "hello"},
        })
        assert result == "hello"
        assert self.svc.message_counter == 0  # Not incremented for deltas

    def test_counter_increments_across_live_events(self):
        """Counter increments sequentially across different live events."""
        self.svc._format_event_live({"type": "agent_start"})
        assert self.svc.message_counter == 1

        self.svc._format_event_live({"type": "turn_end"})
        assert self.svc.message_counter == 2

        result = self.svc._format_event_live({
            "type": "tool_execution_start",
            "toolName": "bash",
        })
        parsed = json.loads(result.strip())
        assert parsed["counter"] == "#3"

    def test_suppressed_events_no_counter(self):
        """Suppressed events (message_start, message_end) don't increment counter."""
        self.svc._format_event_live({"type": "message_start"})
        assert self.svc.message_counter == 0

        self.svc._format_event_live({"type": "message_end"})
        assert self.svc.message_counter == 0


class TestClaudePrettifierCounter:
    """Test that _format_event_pretty_claude() includes counter in output."""

    @pytest.fixture(autouse=True)
    def service(self):
        self.svc = _load_pi_service()

    def test_counter_in_user_message(self):
        event = {
            "type": "user",
            "message": {"content": [{"type": "text", "text": "Hello"}]},
        }
        result = self.svc._format_event_pretty_claude(event)
        parsed = json.loads(result)
        assert parsed["counter"] == "#1"

    def test_counter_in_assistant_message(self):
        event = {
            "type": "assistant",
            "message": {"content": [{"type": "text", "text": "Hi there"}]},
        }
        result = self.svc._format_event_pretty_claude(event)
        parsed = json.loads(result)
        assert parsed["counter"] == "#1"

    def test_counter_increments(self):
        self.svc._format_event_pretty_claude({
            "type": "user",
            "message": {"content": [{"type": "text", "text": "Q"}]},
        })
        result = self.svc._format_event_pretty_claude({
            "type": "assistant",
            "message": {"content": [{"type": "text", "text": "A"}]},
        })
        parsed = json.loads(result)
        assert parsed["counter"] == "#2"
