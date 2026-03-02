"""
Comprehensive tests for the Pi service script (pi.py).
Covers model shorthand expansion, command building, prettifier mode detection,
result event tracking, and Codex prettifier helpers.
"""

import argparse
import copy
import io
import json
import os
import subprocess
import sys
import time

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
    """Test all 14 MODEL_SHORTHANDS plus edge cases."""

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
        assert self.svc.expand_model_shorthand(":codex") == "openai-codex/gpt-5.3-codex"

    def test_shorthand_api_codex(self):
        assert self.svc.expand_model_shorthand(":api-codex") == "openai/gpt-5.3-codex"

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
        """Codex models default to LIVE for real-time streaming."""
        assert self.svc._detect_prettifier_mode("gpt-5.3-codex") == "live"

    def test_codex_model_mixed_case(self):
        """Codex detection is case-insensitive, defaults to LIVE."""
        assert self.svc._detect_prettifier_mode("openai/GPT-5.3-CODEX") == "live"

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
        """The word 'codex' anywhere in model string triggers LIVE mode."""
        assert self.svc._detect_prettifier_mode("openai/gpt-5.3-codex") == "live"

    def test_sonnet_in_full_path(self):
        """Claude models use Pi native prettifier (Pi always emits its own event protocol)."""
        assert self.svc._detect_prettifier_mode("anthropic/claude-sonnet-4-6") == "pi"


# ===================================================================
# 3b. Verbose mode + prettifier interaction (gmgFZ5)
# ===================================================================

class TestVerbosePrettifierInteraction:
    """Codex models default to LIVE for real-time streaming.

    Phase 42 (H5bZwt): Codex models now default to LIVE prettifier instead
    of CODEX, giving users real-time streaming output. The verbose flag
    still switches non-codex models from PI to LIVE. For codex models,
    verbose is a no-op since they already default to LIVE.
    """

    @pytest.fixture(autouse=True)
    def service(self):
        self.svc = _load_pi_service()

    def _apply_run_logic(self, model: str, verbose: bool) -> str:
        """Simulate the prettifier mode assignment from PiService.run()."""
        self.svc.model_name = self.svc.expand_model_shorthand(model)
        self.svc.prettifier_mode = self.svc._detect_prettifier_mode(self.svc.model_name)
        self.svc.verbose = verbose
        if verbose:
            self.svc.prettifier_mode = self.svc.PRETTIFIER_LIVE
        return self.svc.prettifier_mode

    def test_codex_defaults_to_live(self):
        """Codex model without verbose should default to LIVE prettifier."""
        assert self._apply_run_logic("openai-codex/gpt-5.3-codex", verbose=False) == "live"

    def test_codex_verbose_stays_live(self):
        """Codex model + verbose should stay LIVE (already default)."""
        assert self._apply_run_logic("openai-codex/gpt-5.3-codex", verbose=True) == "live"

    def test_codex_shorthand_defaults_to_live(self):
        """Codex shorthand should default to LIVE prettifier."""
        assert self._apply_run_logic(":codex", verbose=False) == "live"

    def test_codex_shorthand_verbose_stays_live(self):
        """Codex shorthand + verbose should stay LIVE."""
        assert self._apply_run_logic(":codex", verbose=True) == "live"

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

    def test_codex_uppercase_defaults_to_live(self):
        """Case-insensitive codex detection should use LIVE."""
        assert self._apply_run_logic("openai/GPT-5.3-CODEX", verbose=False) == "live"

    def test_codex_uppercase_verbose_stays_live(self):
        """Case-insensitive codex + verbose should stay LIVE."""
        assert self._apply_run_logic("openai/GPT-5.3-CODEX", verbose=True) == "live"


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
        assert len(svc.MODEL_SHORTHANDS) == 14

    def test_prettifier_constants(self):
        svc = _load_pi_service()
        assert svc.PRETTIFIER_PI == "pi"
        assert svc.PRETTIFIER_CLAUDE == "claude"
        assert svc.PRETTIFIER_CODEX == "codex"


class TestPiUsageAndCostCapture:
    """Cost/usage extraction used for pi.py result envelopes."""

    @pytest.fixture(autouse=True)
    def service(self):
        self.svc = _load_pi_service()

    def test_extract_usage_from_agent_end_messages(self):
        usage = {
            "input": 120,
            "output": 40,
            "cacheRead": 0,
            "cacheWrite": 0,
            "totalTokens": 160,
            "cost": {"input": 0.0012, "output": 0.0016, "cacheRead": 0.0, "cacheWrite": 0.0, "total": 0.0028},
        }
        event = {
            "type": "agent_end",
            "messages": [
                {"role": "user", "content": "hi"},
                {"role": "assistant", "content": [{"type": "text", "text": "done"}], "usage": usage},
            ],
        }

        assert self.svc._extract_usage_from_event(event) == usage
        assert self.svc._extract_total_cost_usd(event) == pytest.approx(0.0028)

    def test_extract_usage_and_cost_are_aggregated_for_agent_end_messages(self):
        usage_1 = {
            "input": 100,
            "output": 20,
            "cacheRead": 0,
            "cacheWrite": 0,
            "totalTokens": 120,
            "cost": {"input": 0.0010, "output": 0.0004, "cacheRead": 0.0, "cacheWrite": 0.0, "total": 0.0014},
        }
        usage_2 = {
            "input": 80,
            "output": 30,
            "cacheRead": 10,
            "cacheWrite": 0,
            "totalTokens": 120,
            "cost": {"input": 0.0008, "output": 0.0006, "cacheRead": 0.0001, "cacheWrite": 0.0, "total": 0.0015},
        }
        event = {
            "type": "agent_end",
            "messages": [
                {"role": "assistant", "content": [{"type": "text", "text": "first"}], "usage": usage_1},
                {"role": "assistant", "content": [{"type": "text", "text": "second"}], "usage": usage_2},
            ],
        }

        usage = self.svc._extract_usage_from_event(event)
        assert usage is not None
        assert usage["input"] == pytest.approx(180)
        assert usage["output"] == pytest.approx(50)
        assert usage["cacheRead"] == pytest.approx(10)
        assert usage["cacheWrite"] == pytest.approx(0)
        assert usage["totalTokens"] == pytest.approx(240)
        assert usage["cost"]["input"] == pytest.approx(0.0018)
        assert usage["cost"]["output"] == pytest.approx(0.0010)
        assert usage["cost"]["cacheRead"] == pytest.approx(0.0001)
        assert usage["cost"]["cacheWrite"] == pytest.approx(0.0)
        assert usage["cost"]["total"] == pytest.approx(0.0029)
        assert self.svc._extract_total_cost_usd(event) == pytest.approx(0.0029)

    def test_extract_total_cost_usd_prefers_explicit_field(self):
        event = {
            "type": "result",
            "total_cost_usd": 0.77,
            "usage": {"cost": {"total": 0.12}},
        }

        assert self.svc._extract_total_cost_usd(event) == pytest.approx(0.77)

    def test_build_success_result_event_includes_usage_and_cost(self):
        self.svc.session_id = "sess-123"
        usage = {
            "input": 10,
            "output": 5,
            "cacheRead": 0,
            "cacheWrite": 0,
            "totalTokens": 15,
            "cost": {"input": 0.0001, "output": 0.0002, "cacheRead": 0.0, "cacheWrite": 0.0, "total": 0.0003},
        }
        event = {
            "type": "turn_end",
            "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": "done"}],
                "usage": usage,
            },
        }

        result = self.svc._build_success_result_event("done", event)

        assert result["type"] == "result"
        assert result["subtype"] == "success"
        assert result["session_id"] == "sess-123"
        assert result["usage"] == usage
        assert result["total_cost_usd"] == pytest.approx(0.0003)
        assert result["sub_agent_response"]["message"]["usage"] == usage
        assert "type" not in result["sub_agent_response"]


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


class TestRunPiRawToolOutputBuffering:
    """run_pi buffers non-JSON tool stdout to avoid interleaving structured events."""

    @pytest.fixture(autouse=True)
    def service(self):
        self.svc = _load_pi_service()

    class _FakeProcess:
        def __init__(self, stdout_lines):
            self.stdout = io.StringIO("".join(stdout_lines))
            self.stderr = io.StringIO("")
            self.stdin = None
            self.returncode = 0

        def poll(self):
            return self.returncode

        def wait(self, timeout=None):
            return self.returncode

        def terminate(self):
            self.returncode = -15

        def kill(self):
            self.returncode = -9

    class _DelayedStdout:
        def __init__(self, scheduled_lines):
            self._scheduled_lines = list(scheduled_lines)
            self._index = 0
            self.closed = False

        def __iter__(self):
            return self

        def __next__(self):
            if self._index >= len(self._scheduled_lines):
                raise StopIteration
            delay, line = self._scheduled_lines[self._index]
            self._index += 1
            if delay > 0:
                time.sleep(delay)
            return line

        def close(self):
            self.closed = True

    class _FakeDelayedProcess:
        def __init__(self, scheduled_lines):
            self.stdout = TestRunPiRawToolOutputBuffering._DelayedStdout(scheduled_lines)
            self.stderr = io.StringIO("")
            self.stdin = None
            self.returncode = 0

        def poll(self):
            return self.returncode

        def wait(self, timeout=None):
            return self.returncode

        def terminate(self):
            self.returncode = -15

        def kill(self):
            self.returncode = -9

    def test_raw_tool_lines_are_buffered_and_attached_to_tool_event(self, monkeypatch, capsys):
        """Non-JSON lines during tool execution are not printed out-of-order."""
        stdout_lines = [
            '{"type":"tool_execution_start","toolCallId":"tc-1","toolName":"bash","args":{"command":"echo hi"}}\n',
            'RAW-LINE-1\n',
            'RAW-LINE-2\n',
            '{"type":"tool_execution_end","toolCallId":"tc-1","toolName":"bash","result":""}\n',
            '{"type":"turn_end","message":{},"toolResults":[]}\n',
        ]

        fake = self._FakeProcess(stdout_lines)
        monkeypatch.setattr(subprocess, "Popen", lambda *a, **k: fake)

        args = _make_args(pretty="true", verbose=False)
        rc = self.svc.run_pi(["pi", "--mode", "json"], args)
        assert rc == 0

        out = capsys.readouterr().out
        # Raw lines appear once, inside the structured tool result block.
        assert out.count("RAW-LINE-1") == 1
        assert out.count("RAW-LINE-2") == 1
        assert "result:\nRAW-LINE-1\nRAW-LINE-2" in out
        assert out.find("result:\nRAW-LINE-1\nRAW-LINE-2") < out.find('"type": "turn_end"')

    def test_turn_end_is_deferred_until_late_raw_tool_lines_flush(self, monkeypatch, capsys):
        """Late non-JSON tool lines should still print before turn_end metadata."""
        stdout_lines = [
            '{"type":"tool_execution_start","toolCallId":"tc-late","toolName":"bash","args":{"command":"rg -n hi src"}}\n',
            '{"type":"tool_execution_end","toolCallId":"tc-late","toolName":"bash","result":""}\n',
            'RAW-LATE-1\n',
            '{"type":"turn_end","message":{},"toolResults":[]}\n',
            'RAW-LATE-2\n',
            '{"type":"agent_end","messages":[]}\n',
        ]

        fake = self._FakeProcess(stdout_lines)
        monkeypatch.setattr(subprocess, "Popen", lambda *a, **k: fake)

        args = _make_args(pretty="true", verbose=False)
        rc = self.svc.run_pi(["pi", "--mode", "json"], args)
        assert rc == 0

        out = capsys.readouterr().out
        assert out.count("RAW-LATE-1") == 1
        assert out.count("RAW-LATE-2") == 1
        # Both late lines should appear before turn_end so transcript flow stays readable.
        turn_idx = out.find('"type": "turn_end"')
        assert turn_idx != -1
        assert out.find("RAW-LATE-1") < turn_idx
        assert out.find("RAW-LATE-2") < turn_idx

    def test_toolcall_end_is_suppressed_when_tool_finishes_within_delay(self, monkeypatch, capsys):
        """Fallback toolcall_end should be hidden when tool finishes before delay threshold."""
        stdout_lines = [
            '{"type":"message_update","assistantMessageEvent":{"type":"toolcall_end","toolCall":{"name":"bash","arguments":{"command":"echo hi"}}}}\n',
            '{"type":"tool_execution_start","toolCallId":"tc-fast","toolName":"bash","args":{"command":"echo hi"}}\n',
            '{"type":"tool_execution_end","toolCallId":"tc-fast","toolName":"bash","result":"hi"}\n',
            '{"type":"turn_end","message":{},"toolResults":[]}\n',
        ]

        fake = self._FakeProcess(stdout_lines)
        monkeypatch.setattr(subprocess, "Popen", lambda *a, **k: fake)
        monkeypatch.setenv("PI_TOOLCALL_END_DELAY_SECONDS", "1")

        args = _make_args(pretty="true", verbose=False)
        rc = self.svc.run_pi(["pi", "--mode", "json"], args)
        assert rc == 0

        out = capsys.readouterr().out
        assert '"event": "toolcall_end"' not in out
        assert '"type": "tool"' in out
        assert '"result": "hi"' in out

    def test_toolcall_end_is_emitted_when_tool_exceeds_delay(self, monkeypatch, capsys):
        """Fallback toolcall_end should appear when tool_execution_end arrives after delay."""
        scheduled_lines = [
            (0.0, '{"type":"message_update","assistantMessageEvent":{"type":"toolcall_end","toolCall":{"name":"bash","arguments":{"command":"echo hi"}}}}\n'),
            (0.08, '{"type":"tool_execution_start","toolCallId":"tc-slow","toolName":"bash","args":{"command":"echo hi"}}\n'),
            (0.0, '{"type":"tool_execution_end","toolCallId":"tc-slow","toolName":"bash","result":"hi"}\n'),
            (0.0, '{"type":"turn_end","message":{},"toolResults":[]}\n'),
        ]

        fake = self._FakeDelayedProcess(scheduled_lines)
        monkeypatch.setattr(subprocess, "Popen", lambda *a, **k: fake)
        monkeypatch.setenv("PI_TOOLCALL_END_DELAY_SECONDS", "0.02")

        args = _make_args(pretty="true", verbose=False)
        rc = self.svc.run_pi(["pi", "--mode", "json"], args)
        assert rc == 0

        out = capsys.readouterr().out
        assert '"event": "toolcall_end"' in out
        assert '"type": "tool"' in out

    def test_agent_end_and_result_use_run_accumulated_cost_not_last_or_history(self, monkeypatch, capsys):
        """Per-run accumulation should win over last-message or full-history agent_end payloads."""
        usage_1 = {
            "input": 30,
            "output": 10,
            "cacheRead": 0,
            "cacheWrite": 0,
            "totalTokens": 40,
            "cost": {"input": 0.0003, "output": 0.0001, "cacheRead": 0.0, "cacheWrite": 0.0, "total": 0.0004},
        }
        usage_2 = {
            "input": 50,
            "output": 20,
            "cacheRead": 0,
            "cacheWrite": 0,
            "totalTokens": 70,
            "cost": {"input": 0.0005, "output": 0.0002, "cacheRead": 0.0, "cacheWrite": 0.0, "total": 0.0007},
        }
        usage_old_history = {
            "input": 999,
            "output": 999,
            "cacheRead": 0,
            "cacheWrite": 0,
            "totalTokens": 1998,
            "cost": {"input": 0.999, "output": 0.111, "cacheRead": 0.0, "cacheWrite": 0.0, "total": 1.11},
        }

        msg1 = {
            "id": "msg-1",
            "role": "assistant",
            "content": [{"type": "text", "text": "first"}],
            "usage": usage_1,
            "timestamp": 101,
        }
        msg2 = {
            "id": "msg-2",
            "role": "assistant",
            "content": [{"type": "text", "text": "final"}],
            "usage": usage_2,
            "timestamp": 202,
        }

        stdout_lines = [
            json.dumps({"type": "message", "message": msg1}) + "\n",
            json.dumps({"type": "turn_end", "message": msg1, "toolResults": []}) + "\n",
            json.dumps({"type": "message", "message": msg2}) + "\n",
            json.dumps({"type": "turn_end", "message": msg2, "toolResults": []}) + "\n",
            json.dumps(
                {
                    "type": "agent_end",
                    "messages": [
                        {
                            "id": "old-prev",
                            "role": "assistant",
                            "content": [{"type": "text", "text": "old history"}],
                            "usage": usage_old_history,
                            "timestamp": 1,
                        },
                        msg1,
                        msg2,
                    ],
                }
            ) + "\n",
        ]

        fake = self._FakeProcess(stdout_lines)
        monkeypatch.setattr(subprocess, "Popen", lambda *a, **k: fake)

        args = _make_args(pretty="true", verbose=False)
        rc = self.svc.run_pi(["pi", "--mode", "json"], args)
        assert rc == 0

        out = capsys.readouterr().out
        agent_end_events = [
            json.loads(line)
            for line in out.splitlines()
            if line.strip().startswith("{") and '"type": "agent_end"' in line
        ]
        assert agent_end_events
        assert agent_end_events[-1]["total_cost_usd"] == pytest.approx(0.0011)

        assert self.svc.last_result_event is not None
        assert self.svc.last_result_event["total_cost_usd"] == pytest.approx(0.0011)
        assert self.svc.last_result_event["usage"]["cost"]["total"] == pytest.approx(0.0011)


# ===================================================================
# 8. Message counter in prettifier output
# ===================================================================

class TestPiPrettifierCounter:
    """Test that _format_event_pretty() includes counter ONLY on *_end events."""

    @pytest.fixture(autouse=True)
    def service(self):
        self.svc = _load_pi_service()

    def test_no_counter_in_agent_start(self):
        """agent_start is not an *_end event — no counter."""
        result = self.svc._format_event_pretty({"type": "agent_start"})
        parsed = json.loads(result)
        assert "counter" not in parsed

    def test_turn_start_suppressed(self):
        """turn_start should be completely suppressed (returns None)."""
        result = self.svc._format_event_pretty({"type": "turn_start"})
        assert result is None

    def test_counter_increments_across_end_events(self):
        """Counter increments only for *_end events."""
        result1 = self.svc._format_event_pretty({"type": "turn_end"})
        parsed1 = json.loads(result1)
        assert parsed1["counter"] == "#1"
        result2 = self.svc._format_event_pretty({
            "type": "tool_execution_end", "toolName": "bash", "result": "ok",
        })
        parsed2 = json.loads(result2)
        assert parsed2["counter"] == "#2"

    def test_counter_in_turn_end(self):
        result = self.svc._format_event_pretty({"type": "turn_end"})
        parsed = json.loads(result)
        assert parsed["counter"] == "#1"
        assert parsed["type"] == "turn_end"

    def test_tool_execution_start_suppressed(self):
        """tool_execution_start is always suppressed (returns None)."""
        result = self.svc._format_event_pretty({
            "type": "tool_execution_start",
            "toolName": "bash",
            "toolCallId": "tc1",
            "args": {"command": "ls"},
        })
        assert result is None

    def test_counter_in_tool_execution_end(self):
        """tool_execution_end emits as 'tool' type with counter."""
        result = self.svc._format_event_pretty({
            "type": "tool_execution_end",
            "toolName": "bash",
            "result": "output",
        })
        parsed = json.loads(result)
        assert parsed["counter"] == "#1"
        assert parsed["type"] == "tool"

    def test_counter_in_agent_end(self):
        result = self.svc._format_event_pretty({
            "type": "agent_end",
            "messages": [{
                "role": "assistant",
                "text": "done",
                "usage": {"cost": {"total": 0.0025}},
            }],
        })
        parsed = json.loads(result)
        assert parsed["counter"] == "#1"
        assert parsed["message_count"] == 1
        assert parsed["total_cost_usd"] == pytest.approx(0.0025)

    def test_counter_in_message_update_text_end(self):
        """text_end is an *_end subtype — gets counter."""
        result = self.svc._format_event_pretty({
            "type": "message_update",
            "assistantMessageEvent": {"type": "text_end", "content": "hello"},
        })
        parsed = json.loads(result)
        assert parsed["counter"] == "#1"

    def test_no_counter_in_session(self):
        """session is not an *_end event — no counter."""
        result = self.svc._format_event_pretty({"type": "session", "version": "1.0", "id": "abc"})
        parsed = json.loads(result)
        assert "counter" not in parsed

    def test_no_counter_in_message_start(self):
        """message_start is not an *_end event — no counter."""
        result = self.svc._format_event_pretty({"type": "message_start", "message": {"role": "assistant"}})
        parsed = json.loads(result)
        assert "counter" not in parsed

    def test_counter_in_message_end(self):
        """message_end is an *_end event — gets counter."""
        result = self.svc._format_event_pretty({"type": "message_end"})
        parsed = json.loads(result)
        assert parsed["counter"] == "#1"

    def test_no_counter_in_auto_retry_start(self):
        """auto_retry_start is not an *_end event — no counter."""
        result = self.svc._format_event_pretty({
            "type": "auto_retry_start", "attempt": 1, "maxAttempts": 3, "delayMs": 1000,
        })
        parsed = json.loads(result)
        assert "counter" not in parsed

    def test_counter_in_auto_retry_end(self):
        """auto_retry_end is an *_end event — gets counter."""
        result = self.svc._format_event_pretty({
            "type": "auto_retry_end", "success": True, "attempt": 1,
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

    def test_toolcall_end_multiline_command_shows_readable_block(self):
        """Multiline command renders as a separate command block (not escaped JSON)."""
        result = self.svc._format_event_pretty({
            "type": "message_update",
            "assistantMessageEvent": {
                "type": "toolcall_end",
                "toolCall": {
                    "name": "bash",
                    "arguments": {"command": "python3 - <<'PY'\\nprint('hello')\\nPY"},
                },
            },
        })
        lines = result.split("\n")
        header = json.loads(lines[0])
        assert header["tool"] == "bash"
        assert "command" not in header
        assert lines[1] == "command:"
        assert lines[2] == "python3 - <<'PY'"
        assert lines[3] == "print('hello')"
        assert lines[4] == "PY"

    def test_toolcall_end_escaped_newline_sequences_are_humanized(self):
        """Literal \\n sequences in command strings are shown as real newlines."""
        result = self.svc._format_event_pretty({
            "type": "message_update",
            "assistantMessageEvent": {
                "type": "toolcall_end",
                "toolCall": {
                    "name": "bash",
                    "arguments": {"command": r"echo one\necho two"},
                },
            },
        })
        lines = result.split("\n")
        assert lines[1] == "command:"
        assert lines[2] == "echo one"
        assert lines[3] == "echo two"

    def test_toolcall_end_shows_non_command_args(self):
        """Non-bash tool calls should preserve args as JSON object."""
        result = self.svc._format_event_pretty({
            "type": "message_update",
            "assistantMessageEvent": {
                "type": "toolcall_end",
                "toolCall": {"name": "read", "arguments": {"file_path": "/tmp/test.txt", "limit": 100}},
            },
        })
        parsed = json.loads(result)
        assert parsed["tool"] == "read"
        assert parsed["args"]["file_path"] == "/tmp/test.txt"
        assert parsed["args"]["limit"] == 100

    def test_toolcall_end_shows_edit_args(self):
        """Edit tool calls should show structured old_string/new_string args."""
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
        assert parsed["args"]["file_path"] == "/tmp/file.py"
        assert parsed["args"]["old_string"] == "foo"
        assert parsed["args"]["new_string"] == "bar"

    def test_toolcall_end_truncates_long_args(self):
        """Long string arg values are truncated while preserving object shape."""
        long_content = "x" * 500
        result = self.svc._format_event_pretty({
            "type": "message_update",
            "assistantMessageEvent": {
                "type": "toolcall_end",
                "toolCall": {"name": "write", "arguments": {"content": long_content}},
            },
        })
        parsed = json.loads(result)
        assert parsed["args"]["content"].endswith("...")
        assert len(parsed["args"]["content"]) <= 403  # 400 + "..."

    def test_toolcall_end_empty_args(self):
        """Empty arguments dict should remain an empty object."""
        result = self.svc._format_event_pretty({
            "type": "message_update",
            "assistantMessageEvent": {
                "type": "toolcall_end",
                "toolCall": {"name": "custom_tool", "arguments": {}},
            },
        })
        parsed = json.loads(result)
        assert parsed["tool"] == "custom_tool"
        assert parsed["args"] == {}

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
    """Test that Codex prettifier modes include counter ONLY on *_end events."""

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
        """_format_pi_codex_event includes counter for text_end (*_end event)."""
        result = self.svc._format_pi_codex_event({
            "type": "message_update",
            "assistantMessageEvent": {"type": "text_end", "content": "hello"},
        })
        parsed = json.loads(result)
        assert parsed["counter"] == "#1"

    def test_counter_in_codex_event_turn_end(self):
        """_format_pi_codex_event includes counter for turn_end (*_end event)."""
        result = self.svc._format_pi_codex_event({
            "type": "turn_end",
        })
        parsed = json.loads(result)
        assert parsed["counter"] == "#1"

    def test_no_counter_in_codex_event_message_start(self):
        """_format_pi_codex_event: message_start has no counter."""
        result = self.svc._format_pi_codex_event({
            "type": "message_start",
            "message": {"role": "assistant"},
        })
        parsed = json.loads(result)
        assert "counter" not in parsed

    def test_codex_event_tool_execution_start_suppressed(self):
        """_format_pi_codex_event: tool_execution_start is always suppressed."""
        result = self.svc._format_pi_codex_event({
            "type": "tool_execution_start",
            "toolName": "bash",
            "toolCallId": "tc1",
        })
        assert result == ""

    def test_codex_event_turn_start_suppressed(self):
        """_format_pi_codex_event: turn_start is suppressed (empty string)."""
        result = self.svc._format_pi_codex_event({"type": "turn_start"})
        assert result == ""

    def test_no_counter_in_codex_event_agent_start(self):
        """_format_pi_codex_event: agent_start has no counter."""
        result = self.svc._format_pi_codex_event({"type": "agent_start"})
        parsed = json.loads(result)
        assert "counter" not in parsed

    def test_counter_in_codex_event_agent_end(self):
        """_format_pi_codex_event: agent_end gets counter (*_end event)."""
        result = self.svc._format_pi_codex_event({
            "type": "agent_end",
            "messages": [{"role": "assistant", "usage": {"cost": {"total": 0.0011}}}],
        })
        parsed = json.loads(result)
        assert parsed["counter"] == "#1"
        assert parsed["total_cost_usd"] == pytest.approx(0.0011)

    def test_counter_in_codex_event_message_end(self):
        """_format_pi_codex_event: message_end gets counter (*_end event)."""
        result = self.svc._format_pi_codex_event({"type": "message_end"})
        parsed = json.loads(result)
        assert parsed["counter"] == "#1"

    def test_counter_in_codex_event_tool_execution_end(self):
        """_format_pi_codex_event: tool_execution_end gets counter (*_end event)."""
        result = self.svc._format_pi_codex_event({
            "type": "tool_execution_end",
            "toolName": "bash",
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
    """Test that _format_event_live() includes counter ONLY on *_end events."""

    @pytest.fixture(autouse=True)
    def service(self):
        self.svc = _load_pi_service()

    def test_no_counter_in_text_start(self):
        """text_start is not an *_end event — no counter."""
        result = self.svc._format_event_live({
            "type": "message_update",
            "assistantMessageEvent": {"type": "text_start"},
        })
        parsed = json.loads(result.strip())
        assert "counter" not in parsed

    def test_counter_in_text_end(self):
        result = self.svc._format_event_live({
            "type": "message_update",
            "assistantMessageEvent": {"type": "text_end"},
        })
        # text_end prepends \n before JSON
        parsed = json.loads(result.strip())
        assert parsed["counter"] == "#1"

    def test_no_counter_in_thinking_start(self):
        """thinking_start is not an *_end event — no counter."""
        result = self.svc._format_event_live({
            "type": "message_update",
            "assistantMessageEvent": {"type": "thinking_start"},
        })
        parsed = json.loads(result.strip())
        assert "counter" not in parsed

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

    def test_tool_execution_start_suppressed(self):
        """tool_execution_start is always suppressed in live mode."""
        result = self.svc._format_event_live({
            "type": "tool_execution_start",
            "toolName": "edit",
            "toolCallId": "tc1",
        })
        assert result == ""

    def test_counter_in_tool_execution_end(self):
        """tool_execution_end emits as 'tool' type with counter."""
        result = self.svc._format_event_live({
            "type": "tool_execution_end",
            "toolName": "edit",
            "result": "done",
        })
        parsed = json.loads(result.strip())
        assert parsed["counter"] == "#1"
        assert parsed["type"] == "tool"

    def test_counter_in_turn_end(self):
        result = self.svc._format_event_live({
            "type": "turn_end",
        })
        parsed = json.loads(result.strip())
        assert parsed["counter"] == "#1"

    def test_turn_start_suppressed(self):
        """turn_start should be completely suppressed (empty string)."""
        result = self.svc._format_event_live({"type": "turn_start"})
        assert result == ""
        assert self.svc.message_counter == 0

    def test_no_counter_in_agent_start(self):
        """agent_start is not an *_end event — no counter."""
        result = self.svc._format_event_live({
            "type": "agent_start",
        })
        parsed = json.loads(result.strip())
        assert "counter" not in parsed

    def test_counter_in_agent_end(self):
        result = self.svc._format_event_live({
            "type": "agent_end",
            "messages": [{
                "role": "assistant",
                "text": "done",
                "usage": {"cost": {"total": 0.0033}},
            }],
        })
        parsed = json.loads(result.strip())
        assert parsed["counter"] == "#1"
        assert parsed["message_count"] == 1
        assert parsed["total_cost_usd"] == pytest.approx(0.0033)

    def test_no_counter_in_text_delta(self):
        """text_delta returns raw text, no counter."""
        result = self.svc._format_event_live({
            "type": "message_update",
            "assistantMessageEvent": {"type": "text_delta", "delta": "hello"},
        })
        assert result == "hello"
        assert self.svc.message_counter == 0  # Not incremented for deltas

    def test_counter_increments_across_end_events(self):
        """Counter increments only for *_end events, not start events."""
        # agent_start: no counter, no increment
        self.svc._format_event_live({"type": "agent_start"})
        assert self.svc.message_counter == 0

        # turn_end: counter #1
        result = self.svc._format_event_live({"type": "turn_end"})
        assert self.svc.message_counter == 1
        parsed = json.loads(result.strip())
        assert parsed["counter"] == "#1"

        # tool_execution_end: counter #2
        result = self.svc._format_event_live({
            "type": "tool_execution_end",
            "toolName": "bash",
            "result": "ok",
        })
        parsed = json.loads(result.strip())
        assert parsed["counter"] == "#2"

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


# ===========================================================================
# Tool Call Grouping Tests
# ===========================================================================


class TestPiToolCallGrouping:
    """Test tool call grouping in _format_event_pretty(): toolcall_end + tool_execution_end
    are combined into a single 'tool' event with args and result together."""

    @pytest.fixture(autouse=True)
    def service(self):
        self.svc = _load_pi_service()

    def _toolcall_end(self, tool_name, args, tc_id="tc-001"):
        return {
            "type": "message_update",
            "assistantMessageEvent": {
                "type": "toolcall_end",
                "toolCall": {
                    "toolCallId": tc_id,
                    "name": tool_name,
                    "arguments": args,
                },
            },
        }

    def _tool_exec_start(self, tool_name, args, tc_id="tc-001"):
        return {
            "type": "tool_execution_start",
            "toolCallId": tc_id,
            "toolName": tool_name,
            "args": args,
        }

    def _tool_exec_end(self, tool_name, result, tc_id="tc-001", is_error=False):
        return {
            "type": "tool_execution_end",
            "toolCallId": tc_id,
            "toolName": tool_name,
            "result": result,
            "isError": is_error,
        }

    def test_toolcall_end_with_id_is_suppressed(self):
        """toolcall_end with toolCallId should be buffered (returns None)."""
        result = self.svc._format_event_pretty(self._toolcall_end("bash", {"command": "ls"}))
        assert result is None

    def test_tool_execution_start_suppressed_when_pending(self):
        """tool_execution_start should be suppressed when matching pending exists."""
        self.svc._format_event_pretty(self._toolcall_end("read", {"path": "/tmp/f.txt"}))
        result = self.svc._format_event_pretty(self._tool_exec_start("read", {"path": "/tmp/f.txt"}))
        assert result is None

    def test_tool_execution_end_emits_combined_event(self):
        """tool_execution_end with matching pending should emit combined 'tool' event."""
        self.svc._format_event_pretty(self._toolcall_end("bash", {"command": "ls -la"}))
        self.svc._format_event_pretty(self._tool_exec_start("bash", {"command": "ls -la"}))
        result = self.svc._format_event_pretty(self._tool_exec_end("bash", "file1.txt\nfile2.txt"))
        assert result is not None
        # Result has multi-line content, so it's formatted with \nresult:\n
        lines = result.split("\n")
        header = json.loads(lines[0])
        assert header["type"] == "tool"
        assert header["tool"] == "bash"
        assert header["command"] == "ls -la"
        assert "counter" in header

    def test_combined_event_single_line_result(self):
        """Combined event with single-line result has result inline."""
        self.svc._format_event_pretty(self._toolcall_end("edit", {"file_path": "/tmp/f.py", "old_string": "a", "new_string": "b"}))
        result = self.svc._format_event_pretty(self._tool_exec_end("edit", "Successfully replaced text."))
        parsed = json.loads(result)
        assert parsed["type"] == "tool"
        assert parsed["tool"] == "edit"
        assert parsed["result"] == "Successfully replaced text."
        assert "args" in parsed  # non-command args

    def test_combined_event_counter(self):
        """Combined event gets exactly one counter (not two)."""
        self.svc._format_event_pretty(self._toolcall_end("bash", {"command": "echo hi"}))
        result = self.svc._format_event_pretty(self._tool_exec_end("bash", "hi"))
        parsed = json.loads(result)
        assert parsed["counter"] == "#1"
        assert self.svc.message_counter == 1

    def test_combined_event_error_flag(self):
        """Combined event includes isError when tool execution failed."""
        self.svc._format_event_pretty(self._toolcall_end("bash", {"command": "false"}))
        result = self.svc._format_event_pretty(self._tool_exec_end("bash", "command failed", is_error=True))
        parsed = json.loads(result)
        assert parsed["isError"] is True

    def test_parallel_tool_calls_grouped_correctly(self):
        """Multiple concurrent tool calls resolve to their correct pending."""
        self.svc._format_event_pretty(self._toolcall_end("read", {"path": "/a.txt"}, tc_id="tc-A"))
        self.svc._format_event_pretty(self._toolcall_end("bash", {"command": "ls"}, tc_id="tc-B"))
        # Resolve B first
        result_b = self.svc._format_event_pretty(self._tool_exec_end("bash", "output", tc_id="tc-B"))
        parsed_b = json.loads(result_b)
        assert parsed_b["tool"] == "bash"
        assert parsed_b["command"] == "ls"
        # Resolve A second
        result_a = self.svc._format_event_pretty(self._tool_exec_end("read", "file content", tc_id="tc-A"))
        parsed_a = json.loads(result_a)
        assert parsed_a["tool"] == "read"
        assert "args" in parsed_a

    def test_no_pending_fallback(self):
        """tool_execution_end without any buffered data emits 'tool' type."""
        result = self.svc._format_event_pretty(self._tool_exec_end("bash", "output", tc_id="tc-orphan"))
        parsed = json.loads(result)
        assert parsed["type"] == "tool"  # unified type
        assert parsed["tool"] == "bash"

    def test_tool_execution_start_always_suppressed(self):
        """tool_execution_start is always suppressed (returns None) and buffers args."""
        result = self.svc._format_event_pretty(self._tool_exec_start("read", {"path": "/tmp/f.txt"}, tc_id="tc-orphan"))
        assert result is None
        # Args should be buffered in _pending_exec_starts
        assert "tc-orphan" in self.svc._pending_exec_starts
        assert self.svc._pending_exec_starts["tc-orphan"]["tool"] == "read"

    def test_exec_start_args_used_by_exec_end(self):
        """When toolcall_end is missing, tool_execution_end uses buffered exec_start args."""
        # Buffer tool_execution_start
        self.svc._format_event_pretty(self._tool_exec_start("bash", {"command": "echo hi"}, tc_id="tc-late"))
        # Now tool_execution_end arrives — should use buffered args
        result = self.svc._format_event_pretty(self._tool_exec_end("bash", "hi", tc_id="tc-late"))
        parsed = json.loads(result)
        assert parsed["type"] == "tool"
        assert parsed["tool"] == "bash"
        assert parsed["command"] == "echo hi"

    def test_toolcall_end_without_id_emits_normally(self):
        """toolcall_end without toolCallId emits immediately (no grouping)."""
        result = self.svc._format_event_pretty({
            "type": "message_update",
            "assistantMessageEvent": {
                "type": "toolcall_end",
                "toolCall": {"name": "bash", "arguments": {"command": "ls"}},
            },
        })
        parsed = json.loads(result)
        assert parsed["event"] == "toolcall_end"
        assert parsed["tool"] == "bash"
        assert "counter" in parsed

    def test_combined_event_dict_result_with_content_array(self):
        """Combined event handles dict result with content array (Codex-style)."""
        self.svc._format_event_pretty(self._toolcall_end("read", {"path": "/tmp/f.txt"}))
        result = self.svc._format_event_pretty(self._tool_exec_end(
            "read",
            {"content": [{"type": "text", "text": "file contents here"}]},
        ))
        # _build_combined_tool_event extracts text from content array
        assert "file contents here" in result

    def test_pending_cleared_after_use(self):
        """Pending tool call is removed after being consumed."""
        self.svc._format_event_pretty(self._toolcall_end("bash", {"command": "ls"}))
        assert len(self.svc._pending_tool_calls) == 1
        self.svc._format_event_pretty(self._tool_exec_end("bash", "output"))
        assert len(self.svc._pending_tool_calls) == 0


class TestCodexToolCallGrouping:
    """Test tool call grouping in _format_pi_codex_event()."""

    @pytest.fixture(autouse=True)
    def service(self):
        self.svc = _load_pi_service()
        self.svc.prettifier_mode = self.svc.PRETTIFIER_CODEX

    def test_toolcall_end_with_id_is_suppressed(self):
        """toolcall_end with toolCallId should be suppressed (returns empty string)."""
        result = self.svc._format_pi_codex_event({
            "type": "message_update",
            "assistantMessageEvent": {
                "type": "toolcall_end",
                "toolCall": {"toolCallId": "tc-001", "name": "bash", "arguments": {"command": "ls"}},
            },
        })
        assert result == ""

    def test_tool_execution_start_suppressed_when_pending(self):
        """tool_execution_start suppressed when matching pending exists."""
        self.svc._format_pi_codex_event({
            "type": "message_update",
            "assistantMessageEvent": {
                "type": "toolcall_end",
                "toolCall": {"toolCallId": "tc-001", "name": "read", "arguments": {"path": "/tmp/f.txt"}},
            },
        })
        result = self.svc._format_pi_codex_event({
            "type": "tool_execution_start",
            "toolCallId": "tc-001",
            "toolName": "read",
            "args": {"path": "/tmp/f.txt"},
        })
        assert result == ""

    def test_tool_execution_end_emits_combined_event(self):
        """tool_execution_end with matching pending emits combined 'tool' event."""
        self.svc._format_pi_codex_event({
            "type": "message_update",
            "assistantMessageEvent": {
                "type": "toolcall_end",
                "toolCall": {"toolCallId": "tc-001", "name": "bash", "arguments": {"command": "echo test"}},
            },
        })
        result = self.svc._format_pi_codex_event({
            "type": "tool_execution_end",
            "toolCallId": "tc-001",
            "toolName": "bash",
            "result": "test",
        })
        parsed = json.loads(result)
        assert parsed["type"] == "tool"
        assert parsed["tool"] == "bash"
        assert parsed["command"] == "echo test"
        assert parsed["result"] == "test"
        assert "counter" in parsed

    def test_no_pending_fallback(self):
        """tool_execution_end without buffered data emits 'tool' type."""
        result = self.svc._format_pi_codex_event({
            "type": "tool_execution_end",
            "toolCallId": "tc-orphan",
            "toolName": "bash",
            "result": {"content": [{"type": "text", "text": "output"}]},
        })
        parsed = json.loads(result)
        assert parsed["type"] == "tool"

    def test_codex_exec_start_args_used_by_exec_end(self):
        """When toolcall_end is missing, codex tool_execution_end uses buffered exec_start args."""
        # Buffer tool_execution_start
        self.svc._format_pi_codex_event({
            "type": "tool_execution_start",
            "toolCallId": "tc-late",
            "toolName": "bash",
            "args": {"command": "pwd"},
        })
        # Now tool_execution_end arrives — should use buffered args
        result = self.svc._format_pi_codex_event({
            "type": "tool_execution_end",
            "toolCallId": "tc-late",
            "toolName": "bash",
            "result": {"content": [{"type": "text", "text": "/home"}]},
        })
        parsed = json.loads(result)
        assert parsed["type"] == "tool"
        assert parsed["command"] == "pwd"

    def test_codex_result_content_array_in_combined(self):
        """Combined event correctly extracts text from Codex-style content array."""
        self.svc._format_pi_codex_event({
            "type": "message_update",
            "assistantMessageEvent": {
                "type": "toolcall_end",
                "toolCall": {"toolCallId": "tc-001", "name": "read", "arguments": {"path": "/tmp/f.txt"}},
            },
        })
        result = self.svc._format_pi_codex_event({
            "type": "tool_execution_end",
            "toolCallId": "tc-001",
            "toolName": "read",
            "result": {"content": [{"type": "text", "text": "file content"}]},
        })
        assert "file content" in result

    def test_codex_toolcall_end_without_id_multiline_command_block(self):
        """Codex prettifier renders multiline toolcall command as readable command block."""
        result = self.svc._format_pi_codex_event({
            "type": "message_update",
            "assistantMessageEvent": {
                "type": "toolcall_end",
                "toolCall": {
                    "name": "bash",
                    "arguments": {"command": "python3 - <<'PY'\\nprint('ok')\\nPY"},
                },
            },
        })
        lines = result.split("\n")
        header = json.loads(lines[0])
        assert header["type"] == "toolcall_end"
        assert "command" not in header
        assert lines[1] == "command:"
        assert lines[2] == "python3 - <<'PY'"
        assert lines[3] == "print('ok')"
        assert lines[4] == "PY"


class TestLiveToolCallGrouping:
    """Test tool call grouping in _format_event_live()."""

    @pytest.fixture(autouse=True)
    def service(self):
        self.svc = _load_pi_service()

    def test_toolcall_end_with_id_is_suppressed(self):
        """toolcall_end with toolCallId should be suppressed (returns empty string)."""
        result = self.svc._format_event_live({
            "type": "message_update",
            "assistantMessageEvent": {
                "type": "toolcall_end",
                "toolCall": {"toolCallId": "tc-001", "name": "bash", "arguments": {"command": "ls"}},
            },
        })
        assert result == ""

    def test_tool_execution_start_suppressed_when_pending(self):
        """tool_execution_start suppressed when matching pending exists."""
        self.svc._format_event_live({
            "type": "message_update",
            "assistantMessageEvent": {
                "type": "toolcall_end",
                "toolCall": {"toolCallId": "tc-001", "name": "read", "arguments": {"path": "/tmp/f.txt"}},
            },
        })
        result = self.svc._format_event_live({
            "type": "tool_execution_start",
            "toolCallId": "tc-001",
            "toolName": "read",
            "args": {"path": "/tmp/f.txt"},
        })
        assert result == ""

    def test_tool_execution_end_emits_combined_event(self):
        """tool_execution_end with matching pending emits combined 'tool' event."""
        self.svc._format_event_live({
            "type": "message_update",
            "assistantMessageEvent": {
                "type": "toolcall_end",
                "toolCall": {"toolCallId": "tc-001", "name": "bash", "arguments": {"command": "echo hi"}},
            },
        })
        result = self.svc._format_event_live({
            "type": "tool_execution_end",
            "toolCallId": "tc-001",
            "toolName": "bash",
            "result": "hi",
        })
        assert result.endswith("\n")  # live mode always ends with \n
        parsed = json.loads(result.strip())
        assert parsed["type"] == "tool"
        assert parsed["tool"] == "bash"
        assert parsed["command"] == "echo hi"
        assert parsed["result"] == "hi"

    def test_no_pending_fallback(self):
        """tool_execution_end without buffered data emits 'tool' type."""
        result = self.svc._format_event_live({
            "type": "tool_execution_end",
            "toolCallId": "tc-orphan",
            "toolName": "bash",
            "result": "output",
        })
        parsed = json.loads(result.strip())
        assert parsed["type"] == "tool"

    def test_live_exec_start_args_used_by_exec_end(self):
        """When toolcall_end is missing, live tool_execution_end uses buffered exec_start args."""
        # Buffer tool_execution_start
        self.svc._format_event_live({
            "type": "tool_execution_start",
            "toolCallId": "tc-late",
            "toolName": "bash",
            "args": {"command": "date"},
        })
        # Now tool_execution_end arrives — should use buffered args
        result = self.svc._format_event_live({
            "type": "tool_execution_end",
            "toolCallId": "tc-late",
            "toolName": "bash",
            "result": "Wed Feb 26",
        })
        parsed = json.loads(result.strip())
        assert parsed["type"] == "tool"
        assert parsed["command"] == "date"

    def test_live_multiline_result_combined(self):
        """Combined event with multiline result in live mode."""
        self.svc._format_event_live({
            "type": "message_update",
            "assistantMessageEvent": {
                "type": "toolcall_end",
                "toolCall": {"toolCallId": "tc-001", "name": "bash", "arguments": {"command": "ls"}},
            },
        })
        result = self.svc._format_event_live({
            "type": "tool_execution_end",
            "toolCallId": "tc-001",
            "toolName": "bash",
            "result": "file1.txt\nfile2.txt\nfile3.txt",
        })
        assert "result:" in result
        assert "file1.txt" in result

    def test_toolcall_end_without_id_emits_normally(self):
        """toolcall_end without toolCallId emits immediately (no grouping)."""
        result = self.svc._format_event_live({
            "type": "message_update",
            "assistantMessageEvent": {
                "type": "toolcall_end",
                "toolCall": {"name": "bash", "arguments": {"command": "ls"}},
            },
        })
        assert result.endswith("\n")
        parsed = json.loads(result.strip())
        assert parsed["type"] == "toolcall_end"
        assert parsed["tool"] == "bash"

    def test_toolcall_end_without_id_multiline_command_block(self):
        """Live prettifier renders multiline command in a readable command block."""
        result = self.svc._format_event_live({
            "type": "message_update",
            "assistantMessageEvent": {
                "type": "toolcall_end",
                "toolCall": {
                    "name": "bash",
                    "arguments": {"command": "python - <<'PY'\\nprint('x')\\nPY"},
                },
            },
        })
        assert result.endswith("\n")
        lines = result.rstrip("\n").split("\n")
        header = json.loads(lines[0])
        assert header["type"] == "toolcall_end"
        assert "command" not in header
        assert lines[1] == "command:"
        assert lines[2] == "python - <<'PY'"
        assert lines[3] == "print('x')"
        assert lines[4] == "PY"


class TestBufferToolCallEnd:
    """Test the _buffer_tool_call_end() helper method."""

    @pytest.fixture(autouse=True)
    def service(self):
        self.svc = _load_pi_service()

    def test_buffers_with_toolcall_id(self):
        """Returns True and stores pending when toolCallId present."""
        tc = {"toolCallId": "tc-001", "name": "bash", "arguments": {"command": "ls"}}
        assert self.svc._buffer_tool_call_end(tc, "12:00:00 PM") is True
        assert "tc-001" in self.svc._pending_tool_calls
        assert self.svc._pending_tool_calls["tc-001"]["tool"] == "bash"
        assert self.svc._pending_tool_calls["tc-001"]["command"] == "ls"

    def test_returns_false_without_toolcall_id(self):
        """Returns False when no toolCallId."""
        tc = {"name": "bash", "arguments": {"command": "ls"}}
        assert self.svc._buffer_tool_call_end(tc, "12:00:00 PM") is False
        assert len(self.svc._pending_tool_calls) == 0

    def test_buffers_non_command_args(self):
        """Non-bash tool args are preserved as structured objects."""
        tc = {"toolCallId": "tc-002", "name": "read", "arguments": {"path": "/tmp/f.txt", "limit": 100}}
        self.svc._buffer_tool_call_end(tc, "12:00:00 PM")
        pending = self.svc._pending_tool_calls["tc-002"]
        assert pending["tool"] == "read"
        assert "args" in pending
        assert pending["args"]["path"] == "/tmp/f.txt"
        assert pending["args"]["limit"] == 100
        assert "command" not in pending

    def test_buffers_string_args(self):
        """String arguments are stored directly."""
        tc = {"toolCallId": "tc-003", "name": "custom", "arguments": "raw args string"}
        self.svc._buffer_tool_call_end(tc, "12:00:00 PM")
        pending = self.svc._pending_tool_calls["tc-003"]
        assert pending["args"] == "raw args string"

    def test_truncates_long_args(self):
        """Long arg values are truncated to keep tool events readable."""
        long_content = "x" * 500
        tc = {"toolCallId": "tc-004", "name": "write", "arguments": {"content": long_content}}
        self.svc._buffer_tool_call_end(tc, "12:00:00 PM")
        pending = self.svc._pending_tool_calls["tc-004"]
        assert pending["args"]["content"].endswith("...")
        assert len(pending["args"]["content"]) <= 403

    def test_empty_dict_not_treated_as_toolcall(self):
        """Empty dict (no toolCallId) returns False."""
        assert self.svc._buffer_tool_call_end({}, "12:00:00 PM") is False

    def test_non_dict_returns_false(self):
        """Non-dict input returns False."""
        assert self.svc._buffer_tool_call_end("not a dict", "12:00:00 PM") is False
        assert self.svc._buffer_tool_call_end(None, "12:00:00 PM") is False


class TestBuildCombinedToolEvent:
    """Test the _build_combined_tool_event() helper method."""

    @pytest.fixture(autouse=True)
    def service(self):
        self.svc = _load_pi_service()

    def test_combined_event_with_command(self):
        """Combined event for bash tool includes command field."""
        pending = {"tool": "bash", "command": "ls -la", "datetime": "12:00:00 PM"}
        payload = {"toolName": "bash", "result": "file.txt"}
        result = self.svc._build_combined_tool_event(pending, payload, "12:00:01 PM")
        parsed = json.loads(result)
        assert parsed["type"] == "tool"
        assert parsed["tool"] == "bash"
        assert parsed["command"] == "ls -la"
        assert parsed["result"] == "file.txt"
        assert parsed["counter"] == "#1"

    def test_combined_event_multiline_command_uses_command_block(self):
        """Combined tool events render multiline command as readable block."""
        pending = {"tool": "bash", "command": "line1\nline2", "datetime": "12:00:00 PM"}
        payload = {"toolName": "bash", "result": "ok"}
        result = self.svc._build_combined_tool_event(pending, payload, "12:00:01 PM")
        lines = result.split("\n")
        header = json.loads(lines[0])
        assert "command" not in header
        assert header["result"] == "ok"
        assert lines[1] == "command:"
        assert lines[2] == "line1"
        assert lines[3] == "line2"

    def test_combined_event_with_args(self):
        """Combined event for non-bash tool includes structured args field."""
        pending = {"tool": "read", "args": {"path": "/tmp/f.txt"}, "datetime": "12:00:00 PM"}
        payload = {"toolName": "read", "result": "file content"}
        result = self.svc._build_combined_tool_event(pending, payload, "12:00:01 PM")
        parsed = json.loads(result)
        assert parsed["type"] == "tool"
        assert parsed["args"]["path"] == "/tmp/f.txt"
        assert parsed["result"] == "file content"

    def test_combined_event_multiline_result(self):
        """Multiline result is shown after \\nresult:\\n."""
        pending = {"tool": "bash", "command": "ls", "datetime": "12:00:00 PM"}
        payload = {"toolName": "bash", "result": "a.txt\nb.txt\nc.txt"}
        result = self.svc._build_combined_tool_event(pending, payload, "12:00:01 PM")
        lines = result.split("\n")
        header = json.loads(lines[0])
        assert header["type"] == "tool"
        assert lines[1] == "result:"
        assert "a.txt" in result

    def test_combined_event_error(self):
        """Combined event includes isError when set."""
        pending = {"tool": "bash", "command": "false", "datetime": "12:00:00 PM"}
        payload = {"toolName": "bash", "result": "exit 1", "isError": True}
        result = self.svc._build_combined_tool_event(pending, payload, "12:00:01 PM")
        parsed = json.loads(result)
        assert parsed["isError"] is True

    def test_combined_event_dict_result(self):
        """Dict result with content array extracts text."""
        pending = {"tool": "read", "args": {"path": "/f.txt"}, "datetime": "12:00:00 PM"}
        payload = {"toolName": "read", "result": {"content": [{"type": "text", "text": "contents"}]}}
        result = self.svc._build_combined_tool_event(pending, payload, "12:00:01 PM")
        assert "contents" in result

    def test_combined_event_empty_result(self):
        """Combined event with no result still produces valid JSON."""
        pending = {"tool": "bash", "command": "true", "datetime": "12:00:00 PM"}
        payload = {"toolName": "bash", "result": ""}
        result = self.svc._build_combined_tool_event(pending, payload, "12:00:01 PM")
        parsed = json.loads(result)
        assert parsed["type"] == "tool"
        assert "result" not in parsed  # empty result omitted

    def test_combined_event_strips_ansi_from_result(self):
        """ANSI escape sequences are stripped from tool result text."""
        pending = {"tool": "bash", "command": "echo ok", "datetime": "12:00:00 PM"}
        payload = {"toolName": "bash", "result": "\x1b[32mok\x1b[0m"}
        result = self.svc._build_combined_tool_event(pending, payload, "12:00:01 PM")
        parsed = json.loads(result)
        assert parsed["result"] == "ok"

    def test_counter_increments_correctly(self):
        """Counter increments by 1 per combined event."""
        pending1 = {"tool": "bash", "command": "ls", "datetime": "12:00:00 PM"}
        self.svc._build_combined_tool_event(pending1, {"toolName": "bash", "result": "ok"}, "12:00:01 PM")
        assert self.svc.message_counter == 1
        pending2 = {"tool": "bash", "command": "pwd", "datetime": "12:00:02 PM"}
        self.svc._build_combined_tool_event(pending2, {"toolName": "bash", "result": "/tmp"}, "12:00:03 PM")
        assert self.svc.message_counter == 2

    def test_combined_event_includes_execution_time_from_pending_start(self, monkeypatch):
        """execution_time is computed from started_at when available."""
        monkeypatch.setattr(time, "perf_counter", lambda: 10.345)
        pending = {"tool": "bash", "command": "ls", "datetime": "12:00:00 PM", "started_at": 10.0}
        payload = {"toolName": "bash", "result": "ok"}
        result = self.svc._build_combined_tool_event(pending, payload, "12:00:01 PM")
        parsed = json.loads(result)
        assert parsed["execution_time"] == "0.35s"

    def test_combined_event_includes_execution_time_from_payload_ms(self):
        """execution_time uses payload duration fields when provided."""
        pending = {"tool": "read", "args": {"path": "f.txt"}, "datetime": "12:00:00 PM"}
        payload = {"toolName": "read", "result": "ok", "durationMs": 1250}
        result = self.svc._build_combined_tool_event(pending, payload, "12:00:01 PM")
        parsed = json.loads(result)
        assert parsed["execution_time"] == "1.25s"


# ---------------------------------------------------------------------------
# Tool result color tests
# ---------------------------------------------------------------------------

class TestColorEnabled:
    """Test _color_enabled() TTY and NO_COLOR detection."""

    @pytest.fixture(autouse=True)
    def service(self):
        self.svc = _load_pi_service()

    def test_non_tty_returns_false(self):
        """Non-TTY stdout (e.g. piped or captured) disables color."""
        # In test runners, stdout is not a TTY
        assert self.svc._color_enabled() is False

    def test_no_color_env_disables(self, monkeypatch):
        """NO_COLOR environment variable disables color even if TTY."""
        monkeypatch.setenv("NO_COLOR", "1")
        assert self.svc._color_enabled() is False

    def test_no_color_empty_string_disables(self, monkeypatch):
        """NO_COLOR="" (set but empty) still disables color per spec."""
        monkeypatch.setenv("NO_COLOR", "")
        assert self.svc._color_enabled() is False

    def test_tty_without_no_color_enables(self, monkeypatch):
        """TTY stdout without NO_COLOR enables color."""
        monkeypatch.delenv("NO_COLOR", raising=False)
        monkeypatch.setattr(sys.stdout, "isatty", lambda: True)
        assert self.svc._color_enabled() is True


class TestColorizeResult:
    """Test _colorize_result() behavior (errors only are colorized)."""

    RED = "\x1b[38;5;203m"
    RESET = "\x1b[0m"

    @pytest.fixture(autouse=True)
    def service(self):
        self.svc = _load_pi_service()

    def test_no_color_passthrough(self):
        """When color is disabled, text passes through unchanged."""
        # Test runs in non-TTY, so color is disabled
        assert self.svc._colorize_result("hello") == "hello"
        assert self.svc._colorize_result("error text", is_error=True) == "error text"

    def test_success_passthrough_on_tty(self, monkeypatch):
        """Success output remains terminal-default even when TTY supports color."""
        monkeypatch.delenv("NO_COLOR", raising=False)
        monkeypatch.setattr(sys.stdout, "isatty", lambda: True)
        result = self.svc._colorize_result("ok")
        assert result == "ok"

    def test_red_for_error(self, monkeypatch):
        """Error results get red ANSI wrapping."""
        monkeypatch.delenv("NO_COLOR", raising=False)
        monkeypatch.setattr(sys.stdout, "isatty", lambda: True)
        result = self.svc._colorize_result("fail", is_error=True)
        assert result == f"{self.RED}fail{self.RESET}"

    def test_multiline_success_not_colored(self, monkeypatch):
        """Multi-line success text remains uncolored."""
        monkeypatch.delenv("NO_COLOR", raising=False)
        monkeypatch.setattr(sys.stdout, "isatty", lambda: True)
        text = "line1\nline2\nline3"
        result = self.svc._colorize_result(text)
        assert result == text

    def test_no_color_env_suppresses(self, monkeypatch):
        """NO_COLOR env var prevents ANSI codes even with TTY."""
        monkeypatch.setenv("NO_COLOR", "1")
        monkeypatch.setattr(sys.stdout, "isatty", lambda: True)
        result = self.svc._colorize_result("ok")
        assert result == "ok"
        assert "\x1b" not in result


class TestCombinedToolEventColor:
    """Test tool result coloring policy in _build_combined_tool_event output."""

    GREEN = "\x1b[38;5;40m"
    RED = "\x1b[38;5;203m"
    RESET = "\x1b[0m"

    @pytest.fixture(autouse=True)
    def service(self):
        self.svc = _load_pi_service()

    def test_no_color_in_non_tty(self):
        """Non-TTY: combined event output has no ANSI codes."""
        pending = {"tool": "bash", "command": "ls", "datetime": "12:00:00 PM"}
        payload = {"toolName": "bash", "result": "file1\nfile2"}
        result = self.svc._build_combined_tool_event(pending, payload, "12:00:01 PM")
        assert "\x1b" not in result
        assert "result:" in result
        assert "file1" in result

    def test_success_stays_uncolored_with_tty(self, monkeypatch):
        """TTY: success result remains uncolored (default terminal color)."""
        monkeypatch.delenv("NO_COLOR", raising=False)
        monkeypatch.setattr(sys.stdout, "isatty", lambda: True)
        pending = {"tool": "bash", "command": "ls", "datetime": "12:00:00 PM"}
        payload = {"toolName": "bash", "result": "file1\nfile2"}
        result = self.svc._build_combined_tool_event(pending, payload, "12:00:01 PM")
        assert "\x1b" not in result

    def test_multiline_command_green_with_tty(self, monkeypatch):
        """TTY: each multiline command line is explicitly green for line-based renderers."""
        monkeypatch.delenv("NO_COLOR", raising=False)
        monkeypatch.setattr(sys.stdout, "isatty", lambda: True)
        pending = {"tool": "bash", "command": "line1\nline2", "datetime": "12:00:00 PM"}
        payload = {"toolName": "bash", "result": "ok"}
        result = self.svc._build_combined_tool_event(pending, payload, "12:00:01 PM")
        assert "\ncommand:\n" in result
        assert f"{self.GREEN}line1{self.RESET}\n{self.GREEN}line2{self.RESET}" in result

    def test_escaped_newline_command_green_with_tty(self, monkeypatch):
        """TTY: escaped newline commands are humanized and colorized line-by-line."""
        monkeypatch.delenv("NO_COLOR", raising=False)
        monkeypatch.setattr(sys.stdout, "isatty", lambda: True)
        pending = {"tool": "bash", "command": "line1\\nline2\\nline3", "datetime": "12:00:00 PM"}
        payload = {"toolName": "bash", "result": "ok"}
        result = self.svc._build_combined_tool_event(pending, payload, "12:00:01 PM")
        assert f"{self.GREEN}line1{self.RESET}\n{self.GREEN}line2{self.RESET}\n{self.GREEN}line3{self.RESET}" in result

    def test_error_result_red(self, monkeypatch):
        """TTY: error result uses red ANSI code."""
        monkeypatch.delenv("NO_COLOR", raising=False)
        monkeypatch.setattr(sys.stdout, "isatty", lambda: True)
        pending = {"tool": "bash", "command": "false", "datetime": "12:00:00 PM"}
        payload = {"toolName": "bash", "result": "command failed", "isError": True}
        result = self.svc._build_combined_tool_event(pending, payload, "12:00:01 PM")
        assert self.RED in result
        assert self.RESET in result

    def test_inline_result_stays_json_inline(self, monkeypatch):
        """TTY: success single-line results stay inline in JSON header."""
        monkeypatch.delenv("NO_COLOR", raising=False)
        monkeypatch.setattr(sys.stdout, "isatty", lambda: True)
        pending = {"tool": "bash", "command": "pwd", "datetime": "12:00:00 PM"}
        payload = {"toolName": "bash", "result": "/home/user"}
        result = self.svc._build_combined_tool_event(pending, payload, "12:00:01 PM")
        parsed = json.loads(result)
        assert parsed["result"] == "/home/user"

    def test_result_label_plain_for_success(self, monkeypatch):
        """TTY: multiline success output keeps plain (uncolored) 'result:' label."""
        monkeypatch.delenv("NO_COLOR", raising=False)
        monkeypatch.setattr(sys.stdout, "isatty", lambda: True)
        pending = {"tool": "bash", "command": "ls", "datetime": "12:00:00 PM"}
        payload = {"toolName": "bash", "result": "a\nb\nc"}
        result = self.svc._build_combined_tool_event(pending, payload, "12:00:01 PM")
        assert "\nresult:\n" in result
        assert "\x1b" not in result


class TestPrettifierFallbackColor:
    """Test color behavior in fallback tool_execution_end paths."""

    RED = "\x1b[38;5;203m"
    RESET = "\x1b[0m"

    @pytest.fixture(autouse=True)
    def service(self):
        self.svc = _load_pi_service()

    def _enable_color(self, monkeypatch):
        monkeypatch.delenv("NO_COLOR", raising=False)
        monkeypatch.setattr(sys.stdout, "isatty", lambda: True)

    # --- Pi prettifier (_format_event_pretty) ---

    def test_pi_fallback_multiline_uncolored_success(self, monkeypatch):
        """Pi prettifier: fallback success output remains uncolored."""
        self._enable_color(monkeypatch)
        payload = {
            "type": "tool_execution_end",
            "toolName": "read",
            "result": "line1\nline2",
        }
        result = self.svc._format_event_pretty(payload)
        assert "\x1b" not in result
        assert "line1" in result

    def test_pi_fallback_error_red(self, monkeypatch):
        """Pi prettifier: fallback tool_execution_end error result is red."""
        self._enable_color(monkeypatch)
        payload = {
            "type": "tool_execution_end",
            "toolName": "bash",
            "result": "command not found",
            "isError": True,
        }
        result = self.svc._format_event_pretty(payload)
        assert self.RED in result

    def test_pi_fallback_no_color_no_ansi(self):
        """Pi prettifier: fallback without TTY has no ANSI codes."""
        payload = {
            "type": "tool_execution_end",
            "toolName": "read",
            "result": "line1\nline2",
        }
        result = self.svc._format_event_pretty(payload)
        assert "\x1b" not in result

    def test_pi_fallback_includes_execution_time(self):
        """Fallback tool events include execution_time when duration is provided."""
        payload = {
            "type": "tool_execution_end",
            "toolName": "read",
            "result": "ok",
            "durationMs": 20,
        }
        result = self.svc._format_event_pretty(payload)
        parsed = json.loads(result)
        assert parsed["execution_time"] == "0.02s"

    # --- Codex prettifier (_format_pi_codex_event) ---

    def test_codex_fallback_multiline_uncolored_success(self, monkeypatch):
        """Codex prettifier: fallback success output remains uncolored."""
        self._enable_color(monkeypatch)
        payload = {
            "type": "tool_execution_end",
            "toolName": "read",
            "result": {
                "content": [{"type": "text", "text": "line1\nline2"}],
            },
        }
        result = self.svc._format_pi_codex_event(payload)
        assert "\x1b" not in result
        assert "line1" in result

    def test_codex_fallback_error_red(self, monkeypatch):
        """Codex prettifier: fallback tool_execution_end error is red."""
        self._enable_color(monkeypatch)
        payload = {
            "type": "tool_execution_end",
            "toolName": "bash",
            "isError": True,
            "result": {
                "content": [{"type": "text", "text": "error output"}],
            },
        }
        result = self.svc._format_pi_codex_event(payload)
        assert self.RED in result

    def test_codex_fallback_no_color_no_ansi(self):
        """Codex prettifier: fallback without TTY has no ANSI codes."""
        payload = {
            "type": "tool_execution_end",
            "toolName": "read",
            "result": {
                "content": [{"type": "text", "text": "line1\nline2"}],
            },
        }
        result = self.svc._format_pi_codex_event(payload)
        assert "\x1b" not in result

    # --- Live prettifier (_format_event_live) ---

    def test_live_fallback_multiline_uncolored_success(self, monkeypatch):
        """Live prettifier: fallback success output remains uncolored."""
        self._enable_color(monkeypatch)
        payload = {
            "type": "tool_execution_end",
            "toolName": "read",
            "result": "line1\nline2",
        }
        result = self.svc._format_event_live(payload)
        assert "\x1b" not in result
        assert "line1" in result

    def test_live_fallback_error_red(self, monkeypatch):
        """Live prettifier: fallback tool_execution_end error result is red."""
        self._enable_color(monkeypatch)
        payload = {
            "type": "tool_execution_end",
            "toolName": "bash",
            "result": "fail\noutput",
            "isError": True,
        }
        result = self.svc._format_event_live(payload)
        assert self.RED in result

    def test_live_fallback_no_color_no_ansi(self):
        """Live prettifier: fallback without TTY has no ANSI codes."""
        payload = {
            "type": "tool_execution_end",
            "toolName": "read",
            "result": "line1\nline2",
        }
        result = self.svc._format_event_live(payload)
        assert "\x1b" not in result

    # --- Combined event color via all 3 prettifiers ---

    def test_pi_combined_uncolored_success(self, monkeypatch):
        """Pi prettifier: combined success output remains uncolored."""
        self._enable_color(monkeypatch)
        tc = {"toolCallId": "tc-color-1", "name": "bash", "arguments": {"command": "ls"}}
        self.svc._buffer_tool_call_end(tc, "12:00:00 PM")
        payload = {
            "type": "tool_execution_end",
            "toolCallId": "tc-color-1",
            "toolName": "bash",
            "result": "file1\nfile2",
        }
        result = self.svc._format_event_pretty(payload)
        assert "\x1b" not in result
        assert "file1" in result

    def test_codex_combined_uncolored_success(self, monkeypatch):
        """Codex prettifier: combined success output remains uncolored."""
        self._enable_color(monkeypatch)
        tc = {"toolCallId": "tc-color-2", "name": "read", "arguments": {"path": "f.txt"}}
        self.svc._buffer_tool_call_end(tc, "12:00:00 PM")
        payload = {
            "type": "tool_execution_end",
            "toolCallId": "tc-color-2",
            "toolName": "read",
            "result": "contents\nof\nfile",
        }
        result = self.svc._format_pi_codex_event(payload)
        assert "\x1b" not in result

    def test_live_combined_uncolored_success(self, monkeypatch):
        """Live prettifier: combined success output remains uncolored."""
        self._enable_color(monkeypatch)
        tc = {"toolCallId": "tc-color-3", "name": "bash", "arguments": {"command": "pwd"}}
        self.svc._buffer_tool_call_end(tc, "12:00:00 PM")
        payload = {
            "type": "tool_execution_end",
            "toolCallId": "tc-color-3",
            "toolName": "bash",
            "result": "output\nlines",
        }
        result = self.svc._format_event_live(payload)
        assert "\x1b" not in result


# ===================================================================
# LIVE Prettifier: Codex-Native Event Handling (Phase 42 H5bZwt)
# ===================================================================

class TestLiveCodexNativeEvents:
    """LIVE prettifier handles native Codex events for real-time output.

    Phase 42 (H5bZwt): Codex models now default to LIVE prettifier.
    LIVE must handle native Codex events (agent_reasoning, agent_message,
    exec_command_end, command_execution) and role-based messages
    (toolResult, assistant) that may come through.
    """

    @pytest.fixture(autouse=True)
    def service(self):
        self.svc = _load_pi_service()
        self.svc.prettifier_mode = self.svc.PRETTIFIER_LIVE

    # --- Role-based messages ---

    def test_tool_result_role_basic(self):
        """toolResult role message formats with toolName and content."""
        event = {
            "role": "toolResult",
            "toolName": "bash",
            "content": [{"type": "text", "text": "hello"}],
        }
        result = self.svc._format_event_live(event)
        parsed = json.loads(result.strip())
        assert parsed["type"] == "toolResult"
        assert parsed["toolName"] == "bash"
        assert parsed["content"] == "hello"
        assert "counter" in parsed

    def test_tool_result_role_multiline(self, monkeypatch):
        """toolResult with multiline text shows content on separate lines."""
        monkeypatch.delenv("NO_COLOR", raising=False)
        monkeypatch.setattr("sys.stdout", type("FakeTTY", (), {"isatty": lambda self: False, "write": lambda self, x: None, "flush": lambda self: None})())
        event = {
            "role": "toolResult",
            "toolName": "bash",
            "content": [{"type": "text", "text": "line1\nline2\nline3"}],
        }
        result = self.svc._format_event_live(event)
        assert "toolResult" in result
        assert "line1\nline2\nline3" in result

    def test_tool_result_role_error(self):
        """toolResult with isError=True includes isError in header."""
        event = {
            "role": "toolResult",
            "toolName": "bash",
            "isError": True,
            "content": [{"type": "text", "text": "error msg"}],
        }
        result = self.svc._format_event_live(event)
        parsed = json.loads(result.strip())
        assert parsed["isError"] is True

    def test_assistant_role_text(self):
        """assistant role message extracts text content."""
        event = {
            "role": "assistant",
            "content": [{"type": "text", "text": "Hello world"}],
        }
        result = self.svc._format_event_live(event)
        parsed = json.loads(result.strip())
        assert parsed["type"] == "assistant"
        assert parsed["content"] == "Hello world"

    def test_assistant_role_thinking(self):
        """assistant role message extracts thinking content."""
        event = {
            "role": "assistant",
            "content": [{"type": "thinking", "thinking": "Let me think..."}],
        }
        result = self.svc._format_event_live(event)
        assert "[thinking] Let me think..." in result

    def test_assistant_role_toolcall(self):
        """assistant role message extracts toolCall content."""
        event = {
            "role": "assistant",
            "content": [{"type": "toolCall", "name": "bash", "arguments": {"command": "ls -la"}}],
        }
        result = self.svc._format_event_live(event)
        assert "[toolCall] bash: ls -la" in result

    def test_assistant_role_strips_thinking_signature(self):
        """assistant role message strips thinkingSignature from content."""
        event = {
            "role": "assistant",
            "content": [
                {"type": "thinking", "thinking": "hmm", "thinkingSignature": "sig123"},
                {"type": "text", "text": "answer"},
            ],
        }
        result = self.svc._format_event_live(event)
        assert "thinkingSignature" not in result
        assert "[thinking] hmm" in result
        assert "answer" in result

    def test_other_role_minimal_header(self):
        """Unknown role gets minimal JSON header with counter."""
        event = {"role": "system", "content": "something"}
        result = self.svc._format_event_live(event)
        parsed = json.loads(result.strip())
        assert parsed["type"] == "system"
        assert "counter" in parsed

    # --- Native Codex events ---

    def test_agent_reasoning_event(self):
        """agent_reasoning event extracts reasoning text."""
        event = {"type": "agent_reasoning", "msg": {"type": "agent_reasoning", "text": "Thinking about this"}}
        result = self.svc._format_event_live(event)
        parsed = json.loads(result.strip())
        assert parsed["type"] == "agent_reasoning"
        assert parsed["text"] == "Thinking about this"

    def test_agent_reasoning_multiline(self):
        """agent_reasoning with multiline text shows on separate lines."""
        event = {"type": "agent_reasoning", "msg": {"type": "agent_reasoning", "text": "Line 1\nLine 2"}}
        result = self.svc._format_event_live(event)
        assert "agent_reasoning" in result
        assert "text:" in result
        assert "Line 1\nLine 2" in result

    def test_agent_message_event(self):
        """agent_message event extracts message text."""
        event = {"type": "agent_message", "msg": {"type": "agent_message", "message": "Here is my answer"}}
        result = self.svc._format_event_live(event)
        parsed = json.loads(result.strip())
        assert parsed["type"] == "agent_message"
        assert parsed["message"] == "Here is my answer"

    def test_exec_command_end_event(self):
        """exec_command_end event extracts formatted_output."""
        event = {"type": "exec_command_end", "msg": {"type": "exec_command_end", "formatted_output": "$ ls\nfile.txt"}}
        result = self.svc._format_event_live(event)
        assert "exec_command_end" in result
        assert "file.txt" in result

    def test_command_execution_event(self):
        """command_execution event extracts aggregated_output."""
        event = {"type": "command_execution", "msg": {"type": "command_execution", "aggregated_output": "output"}}
        result = self.svc._format_event_live(event)
        parsed = json.loads(result.strip())
        assert parsed["type"] == "command_execution"
        assert parsed["aggregated_output"] == "output"

    def test_codex_default_is_live(self):
        """Codex model should default to LIVE prettifier."""
        assert self.svc._detect_prettifier_mode("openai-codex/gpt-5.3-codex") == "live"

    def test_non_codex_default_is_pi(self):
        """Non-codex model should default to PI prettifier."""
        assert self.svc._detect_prettifier_mode("anthropic/claude-sonnet") == "pi"

    def test_counter_increments_for_codex_native_events(self):
        """Counter should increment for each native Codex event handled in LIVE."""
        self.svc.message_counter = 0
        self.svc._format_event_live({"type": "agent_reasoning", "msg": {"type": "agent_reasoning", "text": "r1"}})
        assert self.svc.message_counter == 1
        self.svc._format_event_live({"type": "agent_message", "msg": {"type": "agent_message", "message": "m1"}})
        assert self.svc.message_counter == 2
        self.svc._format_event_live({"role": "assistant", "content": [{"type": "text", "text": "a1"}]})
        assert self.svc.message_counter == 3
