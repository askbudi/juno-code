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
    assert "aggregated_output:\n---\nexample:\n  value: 1" in out

    # reasoning output (item.completed) pretty printed with text block
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
    # Ensure raw pretty-printed JSON object lines are not passed through verbatim
    assert '\n  "aggregated_output":' not in out
