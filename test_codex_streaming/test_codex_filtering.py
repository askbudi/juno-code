import io
import os
import sys
import json
import subprocess
from contextlib import redirect_stdout


def _build_ndjson_stream():
    events = [
        {"msg": {"type": "turn_diff", "delta": "ignored"}},
        {"msg": {"type": "token_count", "input": 100, "output": 20}},
        {"msg": {"type": "exec_command_output_delta", "value": "ignored"}},
        {"msg": {"type": "agent_message", "message": "Hello\nWorld"}},
        {"msg": {"type": "agent_reasoning", "text": "Think\nMore"}},
        {"msg": {"type": "exec_command_end", "formatted_output": "Done\nOK"}},
    ]
    # printf-escaped single-line strings
    lines = [json.dumps(e) for e in events]
    # Join with literal \n for printf
    return "\\n".join(lines) + "\\n"


def _build_item_schema_stream():
    events = [
        {
            "type": "item.completed",
            "item": {
                "id": "item_4",
                "type": "command_execution",
                "command": "/bin/zsh -lc cat .juno_task/implement.md",
                "aggregated_output": "---\nexample:\n  value: 1\n",
            },
        },
        {
            "type": "item.completed",
            "item": {
                "id": "item_20",
                "type": "reasoning",
                "text": "**Identifying data-model as key resource**\n\nLine two.",
            },
        },
        {
            "type": "item.started",
            "item": {
                "id": "item_42",
                "type": "command_execution",
                "command": "/bin/zsh -lc ./scripts/kanban.sh help",
                "status": "in_progress",
            },
        },
    ]
    lines = [json.dumps(e) for e in events]
    return "\\n".join(lines) + "\\n"


def _build_pretty_item_schema_stream():
    events = [
        {
            "type": "item.completed",
            "item": {
                "id": "item_122",
                "type": "command_execution",
                "command": "/bin/zsh -lc 'ls backend/tests'",
                "aggregated_output": "__init__.py\n__pycache__\napi\ncore\nintegration\nmanual_test_magic_filter.py\nmodels\nparity\nservices\nstreamlit_logic\n",
                "exit_code": 0,
                "status": "completed",
            },
        },
        {
            "type": "item.completed",
            "item": {
                "id": "item_99",
                "type": "reasoning",
                "text": "**Exploring database usage for backend scaffolding**\n\nI'm checking database session management in the backend core and investigating how existing features like shop_summary interact with the database to guide implementing data fetch services for wrap data. This will inform scaffolding a service that reads from the existing database, potentially via Supabase.",
            },
        },
    ]
    return "\n".join(json.dumps(e, indent=2) for e in events) + "\n"


def _build_nested_item_schema_stream():
    events = [
        {
            "type": "item.completed",
            "item": {
                "id": "item_nested_out",
                "type": "command_execution",
                "command": "/bin/zsh -lc 'cat README.md'",
                "result": {
                    "aggregated_output": "line one\nline two\nline three\n",
                    "exit_code": 0,
                },
            },
        },
        {
            "type": "item.completed",
            "item": {
                "id": "item_reason_nested",
                "type": "reasoning",
                "reasoning": {"text": "Nested reasoning text"},
            },
        },
        {
            "type": "item.completed",
            "item": {
                "id": "item_message",
                "type": "message",
                "role": "assistant",
                "content": [
                    {"type": "text", "text": "Final line one"},
                    {"type": "output_text", "text": "Final line two"},
                ],
            },
        },
    ]
    return "\\n".join(json.dumps(e) for e in events) + "\\n"


def _build_agent_message_text_stream():
    events = [
        {
            "type": "item.completed",
            "item": {
                "id": "item_agent_text",
                "type": "agent_message",
                "text": "Yes, a README exists in the repository root.",
            },
        },
    ]
    return "\\n".join(json.dumps(e) for e in events) + "\\n"


def _build_item_schema_stream_without_ids():
    events = [
        {
            "type": "item.completed",
            "item": {
                "type": "command_execution",
                "aggregated_output": "first output\nline two\n",
            },
        },
        {
            "type": "item.completed",
            "item": {
                "type": "reasoning",
                "text": "Second block of reasoning text.",
            },
        },
    ]
    lines = [json.dumps(e) for e in events]
    return "\\n".join(lines) + "\\n"


def _load_codex_service():
    here = os.path.dirname(__file__)
    services_dir = os.path.abspath(os.path.join(here, "..", "src", "templates", "services"))
    # When running from repo root, adjust path
    if not os.path.isdir(services_dir):
        services_dir = os.path.abspath(os.path.join(here, "..", "..", "src", "templates", "services"))
    if services_dir not in sys.path:
        sys.path.insert(0, services_dir)
    from codex import CodexService  # type: ignore
    return CodexService()


def test_codex_stream_filters_suppressed_types():
    svc = _load_codex_service()

    ndjson = _build_ndjson_stream()
    cmd = [
        "bash",
        "-lc",
        f"printf '%s' '{ndjson}'",
    ]

    buf = io.StringIO()
    with redirect_stdout(buf):
        code = svc.run_codex(cmd, verbose=False)

    out = buf.getvalue()

    # Should succeed
    assert code == 0

    # Suppressed types should not appear
    assert '"type": "token_count"' not in out
    assert '"type": "turn_diff"' not in out
    assert '"type": "exec_command_output_delta"' not in out

    # Pretty prints should appear with headers and blocks
    assert '"type": "agent_message"' in out and 'message:\nHello\nWorld' in out
    assert '"type": "agent_reasoning"' in out and 'text:\nThink\nMore' in out
    assert '"type": "exec_command_end"' in out and 'formatted_output:\nDone\nOK' in out


def test_codex_stream_handles_item_schema():
    svc = _load_codex_service()

    ndjson = _build_item_schema_stream()
    cmd = [
        "bash",
        "-lc",
        f"printf '%s' '{ndjson}'",
    ]

    buf = io.StringIO()
    with redirect_stdout(buf):
        code = svc.run_codex(cmd, verbose=False)

    out = buf.getvalue()

    assert code == 0

    # command_execution output (item.completed) pretty printed with aggregated_output block
    assert '"type": "item.completed"' in out
    assert '"item_type": "command_execution"' in out
    assert '"id": "item_4"' in out
    assert "aggregated_output:\n---\nexample:\n  value: 1" in out

    # reasoning output (item.completed) pretty printed with text block
    assert '"id": "item_20"' in out
    assert "text:\n**Identifying data-model as key resource**\n\nLine two." in out

    # item.started events are surfaced with header context
    assert '"type": "item.started"' in out
    assert "kanban.sh help" in out


def test_codex_stream_handles_pretty_multiline_item_schema():
    svc = _load_codex_service()

    pretty_stream = _build_pretty_item_schema_stream()
    stream_literal = repr(pretty_stream)
    cmd = [
        "python",
        "-c",
        f"print({stream_literal}, end='')",
    ]

    buf = io.StringIO()
    with redirect_stdout(buf):
        code = svc.run_codex(cmd, verbose=False)

    out = buf.getvalue()

    assert code == 0

    # Should pretty render aggregated_output from multi-line JSON objects
    assert "aggregated_output:\n__init__.py\n__pycache__\napi\ncore\nintegration\nmanual_test_magic_filter.py\nmodels\nparity\nservices\nstreamlit_logic\n" in out
    # Should pretty render reasoning text block (no raw escaped \\n sequences)
    assert "text:\n**Exploring database usage for backend scaffolding**\n\nI'm checking database session management in the backend core" in out
    # Should include ids in pretty headers
    assert '"id": "item_122"' in out
    assert '"id": "item_99"' in out
    # Ensure raw pretty-printed JSON object lines are not passed through verbatim
    assert '\n  "aggregated_output":' not in out


def test_codex_stream_handles_nested_item_fields_and_message_content():
    svc = _load_codex_service()

    ndjson = _build_nested_item_schema_stream()
    cmd = [
        "bash",
        "-lc",
        f"printf '%s' '{ndjson}'",
    ]

    buf = io.StringIO()
    with redirect_stdout(buf):
        code = svc.run_codex(cmd, verbose=False)

    out = buf.getvalue()

    assert code == 0

    # Aggregated output should render even when nested under result
    assert "aggregated_output:\nline one\nline two\nline three\n" in out
    # Nested reasoning text should render (even when nested under reasoning/result)
    assert '"item_type": "reasoning"' in out
    assert '"text": "Nested reasoning text"' in out
    # Final assistant message content array should render as a message block
    assert "message:\nFinal line one\nFinal line two" in out
    assert '"item_type": "message"' in out
    # ids should remain visible in headers
    assert '"id": "item_nested_out"' in out
    assert '"id": "item_reason_nested"' in out
    assert '"id": "item_message"' in out


def test_codex_agent_message_text_field_renders_message():
    svc = _load_codex_service()

    ndjson = _build_agent_message_text_stream()
    cmd = [
        "bash",
        "-lc",
        f"printf '%s' '{ndjson}'",
    ]

    buf = io.StringIO()
    with redirect_stdout(buf):
        code = svc.run_codex(cmd, verbose=False)

    out = buf.getvalue()

    assert code == 0
    assert '"type": "item.completed"' in out
    assert '"item_type": "agent_message"' in out
    assert "Yes, a README exists in the repository root." in out
    assert '"id": "item_agent_text"' in out


def test_codex_stream_synthesizes_missing_item_ids():
    svc = _load_codex_service()

    ndjson = _build_item_schema_stream_without_ids()
    cmd = [
        "bash",
        "-lc",
        f"printf '%s' '{ndjson}'",
    ]

    buf = io.StringIO()
    with redirect_stdout(buf):
        code = svc.run_codex(cmd, verbose=False)

    out = buf.getvalue()

    assert code == 0
    # Synthesized ids should appear and increment
    assert '"id": "item_0"' in out
    assert '"id": "item_1"' in out
    assert out.index("item_0") < out.index("item_1")


# ---------------------------------------------------------------------------
# split_json_stream edge-case tests
# ---------------------------------------------------------------------------

def test_split_json_stream_concatenated_single_line():
    """Multiple JSON objects collapsed into a single line (no newlines between them)."""
    svc = _load_codex_service()

    events = [
        {"msg": {"type": "agent_message", "message": "Hello"}},
        {"msg": {"type": "agent_reasoning", "text": "Thinking"}},
    ]
    # Concatenate with no separator — the way some environments collapse NDJSON
    concatenated = "".join(json.dumps(e) for e in events)
    stream_literal = repr(concatenated)
    cmd = ["python", "-c", f"print({stream_literal}, end='')"]

    buf = io.StringIO()
    with redirect_stdout(buf):
        code = svc.run_codex(cmd, verbose=False)

    out = buf.getvalue()
    assert code == 0
    # Both events should be parsed and rendered
    assert "Hello" in out
    assert "Thinking" in out


def test_split_json_stream_escaped_braces_in_strings():
    """Braces inside JSON string values should not confuse the splitter."""
    svc = _load_codex_service()

    event = {"msg": {"type": "agent_message", "message": 'function() { return {}; }'}}
    stream = json.dumps(event)
    stream_literal = repr(stream)
    cmd = ["python", "-c", f"print({stream_literal}, end='')"]

    buf = io.StringIO()
    with redirect_stdout(buf):
        code = svc.run_codex(cmd, verbose=False)

    out = buf.getvalue()
    assert code == 0
    assert "function() { return {}; }" in out


def test_split_json_stream_escaped_quotes_in_strings():
    """Escaped double quotes inside JSON strings should not break the parser."""
    svc = _load_codex_service()

    event = {"msg": {"type": "agent_message", "message": 'He said "hello" to me'}}
    stream = json.dumps(event)
    stream_literal = repr(stream)
    cmd = ["python", "-c", f"print({stream_literal}, end='')"]

    buf = io.StringIO()
    with redirect_stdout(buf):
        code = svc.run_codex(cmd, verbose=False)

    out = buf.getvalue()
    assert code == 0
    # The message appears in JSON output with escaped quotes
    assert 'He said' in out and 'hello' in out and 'to me' in out
    # Verify the JSON was parsed correctly (escaped quotes didn't break split_json_stream)
    assert '"type": "agent_message"' in out


def test_split_json_stream_incomplete_json_buffering():
    """Incomplete JSON (split across lines) should be buffered and completed."""
    svc = _load_codex_service()

    event = {"msg": {"type": "agent_message", "message": "complete"}}
    full_json = json.dumps(event)
    # Split JSON across two lines to simulate chunked reading
    mid = len(full_json) // 2
    line1 = full_json[:mid]
    line2 = full_json[mid:]
    # Each line on its own is incomplete JSON; together they form a valid object
    stream_literal = repr(line1 + "\n" + line2)
    cmd = ["python", "-c", f"print({stream_literal}, end='')"]

    buf = io.StringIO()
    with redirect_stdout(buf):
        code = svc.run_codex(cmd, verbose=False)

    out = buf.getvalue()
    assert code == 0
    assert "complete" in out


def test_split_json_stream_deeply_nested_objects():
    """Deeply nested JSON objects should be parsed as a single top-level object."""
    svc = _load_codex_service()

    event = {
        "type": "item.completed",
        "item": {
            "id": "item_deep",
            "type": "command_execution",
            "command": "/bin/zsh -lc 'ls'",
            "result": {
                "aggregated_output": "deep output\nmore lines",
                "metadata": {
                    "nested": {
                        "very": "deep"
                    }
                }
            }
        }
    }
    stream = json.dumps(event)
    stream_literal = repr(stream)
    cmd = ["python", "-c", f"print({stream_literal}, end='')"]

    buf = io.StringIO()
    with redirect_stdout(buf):
        code = svc.run_codex(cmd, verbose=False)

    out = buf.getvalue()
    assert code == 0
    assert '"id": "item_deep"' in out
    assert "deep output" in out


def test_split_json_stream_mixed_separator_styles():
    """JSON objects separated by literal \\n (the text, not newline char) in concatenated NDJSON."""
    svc = _load_codex_service()

    events = [
        {"msg": {"type": "agent_message", "message": "first"}},
        {"msg": {"type": "agent_message", "message": "second"}},
        {"msg": {"type": "agent_message", "message": "third"}},
    ]
    # Simulate: each JSON on its own, separated by literal backslash-n (printf-style)
    ndjson = "\\n".join(json.dumps(e) for e in events)
    cmd = ["bash", "-lc", f"printf '%s' '{ndjson}'"]

    buf = io.StringIO()
    with redirect_stdout(buf):
        code = svc.run_codex(cmd, verbose=False)

    out = buf.getvalue()
    assert code == 0
    assert "first" in out
    assert "second" in out
    assert "third" in out


def test_split_json_stream_empty_input():
    """Empty input should produce no output and no errors."""
    svc = _load_codex_service()

    cmd = ["bash", "-lc", "printf ''"]

    buf = io.StringIO()
    with redirect_stdout(buf):
        code = svc.run_codex(cmd, verbose=False)

    out = buf.getvalue()
    assert code == 0
    assert out.strip() == ""


def test_split_json_stream_whitespace_between_objects():
    """Whitespace and newlines between JSON objects should be ignored."""
    svc = _load_codex_service()

    events = [
        {"msg": {"type": "agent_message", "message": "alpha"}},
        {"msg": {"type": "agent_message", "message": "beta"}},
    ]
    # Lots of whitespace between objects
    stream = json.dumps(events[0]) + "\n\n   \n\n" + json.dumps(events[1])
    stream_literal = repr(stream)
    cmd = ["python", "-c", f"print({stream_literal}, end='')"]

    buf = io.StringIO()
    with redirect_stdout(buf):
        code = svc.run_codex(cmd, verbose=False)

    out = buf.getvalue()
    assert code == 0
    assert "alpha" in out
    assert "beta" in out


# ---------------------------------------------------------------------------
# Verbose flag passthrough test
# ---------------------------------------------------------------------------

def test_codex_verbose_flag_prints_command_to_stderr():
    """When verbose=True, the command should be printed to stderr."""
    svc = _load_codex_service()

    cmd = ["bash", "-lc", "printf ''"]

    buf_stdout = io.StringIO()
    buf_stderr = io.StringIO()

    import contextlib
    with redirect_stdout(buf_stdout), contextlib.redirect_stderr(buf_stderr):
        code = svc.run_codex(cmd, verbose=True)

    stderr_out = buf_stderr.getvalue()
    assert code == 0
    assert "Executing:" in stderr_out
    assert "bash" in stderr_out
    # Separator line should also be present
    assert "-" * 80 in stderr_out


def test_codex_verbose_false_no_stderr_command():
    """When verbose=False, no command should be printed to stderr."""
    svc = _load_codex_service()

    cmd = ["bash", "-lc", "printf ''"]

    buf_stdout = io.StringIO()
    buf_stderr = io.StringIO()

    import contextlib
    with redirect_stdout(buf_stdout), contextlib.redirect_stderr(buf_stderr):
        code = svc.run_codex(cmd, verbose=False)

    stderr_out = buf_stderr.getvalue()
    assert code == 0
    assert "Executing:" not in stderr_out


# ---------------------------------------------------------------------------
# Capture file (JUNO_SUBAGENT_CAPTURE_PATH) tests
# ---------------------------------------------------------------------------

def test_codex_capture_file_writes_last_agent_message():
    """JUNO_SUBAGENT_CAPTURE_PATH should capture the last agent_message event."""
    import tempfile
    svc = _load_codex_service()

    events = [
        {"msg": {"type": "agent_message", "message": "first message"}},
        {"msg": {"type": "agent_reasoning", "text": "thinking"}},
        {"msg": {"type": "agent_message", "message": "final answer"}},
    ]
    ndjson = "\\n".join(json.dumps(e) for e in events) + "\\n"

    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        capture_path = f.name

    try:
        os.environ["JUNO_SUBAGENT_CAPTURE_PATH"] = capture_path
        cmd = ["bash", "-lc", f"printf '%s' '{ndjson}'"]

        buf = io.StringIO()
        with redirect_stdout(buf):
            code = svc.run_codex(cmd, verbose=False)

        assert code == 0

        # Capture file should contain the last agent_message event
        with open(capture_path) as f:
            captured = json.load(f)
        assert captured.get("msg", {}).get("type") == "agent_message"
        assert captured.get("msg", {}).get("message") == "final answer"
    finally:
        os.environ.pop("JUNO_SUBAGENT_CAPTURE_PATH", None)
        if os.path.exists(capture_path):
            os.unlink(capture_path)


def test_codex_no_capture_file_without_env():
    """Without JUNO_SUBAGENT_CAPTURE_PATH, no capture file should be created."""
    import tempfile
    svc = _load_codex_service()

    events = [
        {"msg": {"type": "agent_message", "message": "hello"}},
    ]
    ndjson = "\\n".join(json.dumps(e) for e in events) + "\\n"

    # Ensure env var is not set
    os.environ.pop("JUNO_SUBAGENT_CAPTURE_PATH", None)

    capture_path = os.path.join(tempfile.gettempdir(), "should_not_exist_capture.json")
    if os.path.exists(capture_path):
        os.unlink(capture_path)

    cmd = ["bash", "-lc", f"printf '%s' '{ndjson}'"]

    buf = io.StringIO()
    with redirect_stdout(buf):
        code = svc.run_codex(cmd, verbose=False)

    assert code == 0
    assert not os.path.exists(capture_path)


# ---------------------------------------------------------------------------
# Verbose flag tests
# ---------------------------------------------------------------------------

def test_codex_verbose_true_prints_executing_to_stderr():
    """When verbose=True, 'Executing:' and the command should appear on stderr."""
    svc = _load_codex_service()

    events = [{"msg": {"type": "agent_message", "message": "hi"}}]
    ndjson = "\\n".join(json.dumps(e) for e in events) + "\\n"
    cmd = ["bash", "-lc", f"printf '%s' '{ndjson}'"]

    buf_stdout = io.StringIO()
    buf_stderr = io.StringIO()

    import contextlib
    with redirect_stdout(buf_stdout), contextlib.redirect_stderr(buf_stderr):
        code = svc.run_codex(cmd, verbose=True)

    assert code == 0
    stderr_out = buf_stderr.getvalue()
    assert "Executing:" in stderr_out
    assert "bash" in stderr_out


def test_codex_verbose_false_no_executing_on_stderr():
    """When verbose=False, 'Executing:' should NOT appear on stderr."""
    svc = _load_codex_service()

    events = [{"msg": {"type": "agent_message", "message": "hi"}}]
    ndjson = "\\n".join(json.dumps(e) for e in events) + "\\n"
    cmd = ["bash", "-lc", f"printf '%s' '{ndjson}'"]

    buf_stdout = io.StringIO()
    buf_stderr = io.StringIO()

    import contextlib
    with redirect_stdout(buf_stdout), contextlib.redirect_stderr(buf_stderr):
        code = svc.run_codex(cmd, verbose=False)

    assert code == 0
    stderr_out = buf_stderr.getvalue()
    assert "Executing:" not in stderr_out


def test_codex_verbose_prints_separator_line():
    """Verbose output should include an 80-char separator line."""
    svc = _load_codex_service()

    cmd = ["bash", "-lc", "printf ''"]

    buf_stdout = io.StringIO()
    buf_stderr = io.StringIO()

    import contextlib
    with redirect_stdout(buf_stdout), contextlib.redirect_stderr(buf_stderr):
        code = svc.run_codex(cmd, verbose=True)

    assert code == 0
    stderr_out = buf_stderr.getvalue()
    assert "-" * 80 in stderr_out


# ---------------------------------------------------------------------------
# Model shorthand expansion tests
# ---------------------------------------------------------------------------

def test_codex_model_shorthand_codex():
    """':codex' should expand to 'gpt-5.3-codex'."""
    svc = _load_codex_service()
    assert svc.expand_model_shorthand(":codex") == "gpt-5.3-codex"


def test_codex_model_shorthand_codex_mini():
    """':codex-mini' should expand to 'gpt-5.1-codex-mini'."""
    svc = _load_codex_service()
    assert svc.expand_model_shorthand(":codex-mini") == "gpt-5.1-codex-mini"


def test_codex_model_shorthand_gpt5():
    """':gpt-5' should expand to 'gpt-5'."""
    svc = _load_codex_service()
    assert svc.expand_model_shorthand(":gpt-5") == "gpt-5"


def test_codex_model_shorthand_mini():
    """':mini' should expand to 'gpt-5-codex-mini'."""
    svc = _load_codex_service()
    assert svc.expand_model_shorthand(":mini") == "gpt-5-codex-mini"


def test_codex_model_shorthand_passthrough_full_name():
    """A full model name (no colon prefix) should pass through unchanged."""
    svc = _load_codex_service()
    assert svc.expand_model_shorthand("gpt-5.3-codex") == "gpt-5.3-codex"


def test_codex_model_shorthand_unknown_colon_prefix():
    """An unknown colon-prefixed shorthand should pass through unchanged."""
    svc = _load_codex_service()
    assert svc.expand_model_shorthand(":unknown-model") == ":unknown-model"


# ---------------------------------------------------------------------------
# Default model constant tests
# ---------------------------------------------------------------------------

def test_codex_default_model_is_gpt53_codex():
    """DEFAULT_MODEL should be 'gpt-5.3-codex'."""
    svc = _load_codex_service()
    assert svc.DEFAULT_MODEL == "gpt-5.3-codex"


def test_codex_init_model_name_equals_default():
    """After __init__, model_name should equal DEFAULT_MODEL."""
    svc = _load_codex_service()
    assert svc.model_name == svc.DEFAULT_MODEL


# ---------------------------------------------------------------------------
# Capture file - last_result_event tracking tests
# ---------------------------------------------------------------------------

def test_codex_last_result_event_set_on_agent_message():
    """last_result_event should be set when an agent_message event is processed."""
    import tempfile
    svc = _load_codex_service()

    events = [
        {"msg": {"type": "agent_reasoning", "text": "thinking"}},
        {"msg": {"type": "agent_message", "message": "the answer"}},
    ]
    ndjson = "\\n".join(json.dumps(e) for e in events) + "\\n"

    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        capture_path = f.name

    try:
        os.environ["JUNO_SUBAGENT_CAPTURE_PATH"] = capture_path
        cmd = ["bash", "-lc", f"printf '%s' '{ndjson}'"]

        buf = io.StringIO()
        with redirect_stdout(buf):
            code = svc.run_codex(cmd, verbose=False)

        assert code == 0

        with open(capture_path) as f:
            captured = json.load(f)
        # Should capture the agent_message event
        assert captured.get("msg", {}).get("type") == "agent_message"
        assert captured.get("msg", {}).get("message") == "the answer"
    finally:
        os.environ.pop("JUNO_SUBAGENT_CAPTURE_PATH", None)
        if os.path.exists(capture_path):
            os.unlink(capture_path)


def test_codex_last_result_event_tracks_latest_agent_message():
    """When multiple agent_message events arrive, capture file has the last one."""
    import tempfile
    svc = _load_codex_service()

    events = [
        {"msg": {"type": "agent_message", "message": "first"}},
        {"msg": {"type": "agent_message", "message": "second"}},
        {"msg": {"type": "agent_message", "message": "third"}},
    ]
    ndjson = "\\n".join(json.dumps(e) for e in events) + "\\n"

    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        capture_path = f.name

    try:
        os.environ["JUNO_SUBAGENT_CAPTURE_PATH"] = capture_path
        cmd = ["bash", "-lc", f"printf '%s' '{ndjson}'"]

        buf = io.StringIO()
        with redirect_stdout(buf):
            code = svc.run_codex(cmd, verbose=False)

        assert code == 0

        with open(capture_path) as f:
            captured = json.load(f)
        # Should be the LAST agent_message
        assert captured.get("msg", {}).get("message") == "third"
    finally:
        os.environ.pop("JUNO_SUBAGENT_CAPTURE_PATH", None)
        if os.path.exists(capture_path):
            os.unlink(capture_path)


def test_codex_capture_file_not_written_without_agent_message():
    """If no agent_message event arrives, capture file should remain empty or not be written."""
    import tempfile
    svc = _load_codex_service()

    events = [
        {"msg": {"type": "agent_reasoning", "text": "just thinking"}},
        {"msg": {"type": "exec_command_end", "formatted_output": "done"}},
    ]
    ndjson = "\\n".join(json.dumps(e) for e in events) + "\\n"

    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        capture_path = f.name

    try:
        os.environ["JUNO_SUBAGENT_CAPTURE_PATH"] = capture_path
        cmd = ["bash", "-lc", f"printf '%s' '{ndjson}'"]

        buf = io.StringIO()
        with redirect_stdout(buf):
            code = svc.run_codex(cmd, verbose=False)

        assert code == 0

        # Capture file should either not exist or be empty (no agent_message to write)
        if os.path.exists(capture_path):
            content = open(capture_path).read().strip()
            assert content == "", "Capture file should be empty when no agent_message events arrive"
    finally:
        os.environ.pop("JUNO_SUBAGENT_CAPTURE_PATH", None)
        if os.path.exists(capture_path):
            os.unlink(capture_path)
