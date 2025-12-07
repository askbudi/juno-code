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


def test_codex_stream_filters_suppressed_types():
    here = os.path.dirname(__file__)
    services_dir = os.path.abspath(os.path.join(here, "..", "src", "templates", "services"))
    # When running from repo root, adjust path
    if not os.path.isdir(services_dir):
        services_dir = os.path.abspath(os.path.join(here, "..", "..", "src", "templates", "services"))
    sys.path.insert(0, services_dir)
    try:
        from codex import CodexService  # type: ignore
    finally:
        # Keep path for potential further imports
        pass

    svc = CodexService()

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

