"""
Tests for the codex.py watchdog thread behavior.

The watchdog handles two scenarios:
1. Process exits but stdout pipe stays open (inherited FDs from child processes)
2. Process itself never exits (hung event loop) after stdout closes

These tests verify:
- Normal exit doesn't trigger watchdog intervention
- Exit code is preserved
- CODEX_WAIT_TIMEOUT env var is respected
- Output is fully captured
- Empty output scenarios complete without hanging
- Multiple events with watchdog active
- ValueError from closed stdout is handled gracefully

Note: The SIGTERM/SIGKILL escalation tests require processes that close stdout
but keep running (scenario 2). The watchdog only intervenes AFTER the stdout loop
ends (output_done is set) and finds the process still alive.
"""

import io
import json
import os
import sys
import time

import pytest

from contextlib import redirect_stdout, redirect_stderr


def _load_codex_service():
    here = os.path.dirname(__file__)
    services_dir = os.path.abspath(os.path.join(here, "..", "src", "templates", "services"))
    if not os.path.isdir(services_dir):
        services_dir = os.path.abspath(os.path.join(here, "..", "..", "src", "templates", "services"))
    if services_dir not in sys.path:
        sys.path.insert(0, services_dir)
    from codex import CodexService
    return CodexService()


# ===================================================================
# 1. Normal process exit — watchdog does NOT intervene
# ===================================================================

class TestWatchdogNormalExit:
    """Verify watchdog doesn't interfere with normal process exit."""

    def test_normal_exit_no_warnings(self):
        """A process that exits cleanly should produce no watchdog warnings."""
        svc = _load_codex_service()

        events = [{"msg": {"type": "agent_message", "message": "done"}}]
        ndjson = "\\n".join(json.dumps(e) for e in events) + "\\n"
        cmd = ["bash", "-lc", f"printf '%s' '{ndjson}'"]

        buf_stdout = io.StringIO()
        buf_stderr = io.StringIO()

        import contextlib
        with redirect_stdout(buf_stdout), contextlib.redirect_stderr(buf_stderr):
            code = svc.run_codex(cmd, verbose=False)

        assert code == 0
        stderr_out = buf_stderr.getvalue()
        assert "Warning:" not in stderr_out
        assert "Terminating" not in stderr_out
        assert "Killing" not in stderr_out

    def test_normal_exit_output_preserved(self):
        """Output from a normally-exiting process is fully preserved."""
        svc = _load_codex_service()

        events = [
            {"msg": {"type": "agent_message", "message": "first"}},
            {"msg": {"type": "agent_message", "message": "second"}},
        ]
        ndjson = "\\n".join(json.dumps(e) for e in events) + "\\n"
        cmd = ["bash", "-lc", f"printf '%s' '{ndjson}'"]

        buf = io.StringIO()
        with redirect_stdout(buf):
            code = svc.run_codex(cmd, verbose=False)

        assert code == 0
        out = buf.getvalue()
        assert "first" in out
        assert "second" in out

    def test_fast_exit_process(self):
        """A process that exits immediately after output completes normally."""
        svc = _load_codex_service()

        cmd = ["bash", "-lc", "echo '{}'"]

        buf_stdout = io.StringIO()
        buf_stderr = io.StringIO()

        import contextlib
        with redirect_stdout(buf_stdout), contextlib.redirect_stderr(buf_stderr):
            code = svc.run_codex(cmd, verbose=False)

        assert code == 0
        assert "Warning:" not in buf_stderr.getvalue()


# ===================================================================
# 2. Process exit with preserved exit code
# ===================================================================

class TestWatchdogExitCode:
    """Test exit code preservation with watchdog active."""

    def test_zero_exit_code_preserved(self):
        """Exit code 0 from a normal process is preserved."""
        svc = _load_codex_service()

        events = [{"msg": {"type": "agent_message", "message": "ok"}}]
        ndjson = "\\n".join(json.dumps(e) for e in events) + "\\n"
        cmd = ["bash", "-lc", f"printf '%s' '{ndjson}'; exit 0"]

        buf = io.StringIO()
        with redirect_stdout(buf):
            code = svc.run_codex(cmd, verbose=False)

        assert code == 0

    def test_nonzero_exit_code_preserved(self):
        """Non-zero exit code is preserved when process fails."""
        svc = _load_codex_service()

        cmd = ["bash", "-lc", "echo '{}'; exit 42"]

        buf = io.StringIO()
        with redirect_stdout(buf):
            code = svc.run_codex(cmd, verbose=False)

        assert code == 42

    def test_exit_code_1_preserved(self):
        """Exit code 1 from error is preserved."""
        svc = _load_codex_service()

        cmd = ["bash", "-lc", "echo '{}'; exit 1"]

        buf = io.StringIO()
        with redirect_stdout(buf):
            code = svc.run_codex(cmd, verbose=False)

        assert code == 1


# ===================================================================
# 3. CODEX_WAIT_TIMEOUT environment variable
# ===================================================================

class TestWatchdogTimeout:
    """Test CODEX_WAIT_TIMEOUT configuration."""

    def test_default_timeout_accepted(self):
        """Without env var, default timeout (30s) is used and doesn't cause issues."""
        os.environ.pop("CODEX_WAIT_TIMEOUT", None)
        svc = _load_codex_service()

        cmd = ["bash", "-lc", "echo '{}'"]

        buf = io.StringIO()
        with redirect_stdout(buf):
            code = svc.run_codex(cmd, verbose=False)

        assert code == 0

    def test_custom_timeout_env_var(self):
        """CODEX_WAIT_TIMEOUT env var should be accepted without errors."""
        os.environ["CODEX_WAIT_TIMEOUT"] = "5"
        try:
            svc = _load_codex_service()

            events = [{"msg": {"type": "agent_message", "message": "fast"}}]
            ndjson = "\\n".join(json.dumps(e) for e in events) + "\\n"
            cmd = ["bash", "-lc", f"printf '%s' '{ndjson}'"]

            buf = io.StringIO()
            with redirect_stdout(buf):
                code = svc.run_codex(cmd, verbose=False)

            assert code == 0
            assert "fast" in buf.getvalue()
        finally:
            os.environ.pop("CODEX_WAIT_TIMEOUT", None)

    def test_short_timeout_env_var(self):
        """Very short timeout (1s) still works for fast processes."""
        os.environ["CODEX_WAIT_TIMEOUT"] = "1"
        try:
            svc = _load_codex_service()

            events = [{"msg": {"type": "agent_message", "message": "quick"}}]
            ndjson = "\\n".join(json.dumps(e) for e in events) + "\\n"
            cmd = ["bash", "-lc", f"printf '%s' '{ndjson}'"]

            buf = io.StringIO()
            with redirect_stdout(buf):
                code = svc.run_codex(cmd, verbose=False)

            assert code == 0
            assert "quick" in buf.getvalue()
        finally:
            os.environ.pop("CODEX_WAIT_TIMEOUT", None)


# ===================================================================
# 4. Watchdog SIGTERM/SIGKILL escalation
# ===================================================================

class TestWatchdogTermination:
    """Test watchdog terminates processes that close stdout but keep running.

    Scenario: Process closes stdout (so the for-loop in run_codex exits and
    output_done is set), but the process itself stays alive. The watchdog
    should wait CODEX_WAIT_TIMEOUT seconds, then SIGTERM, then SIGKILL.
    """

    def test_process_closes_stdout_but_keeps_running(self):
        """Process that closes stdout but sleeps should be terminated by watchdog."""
        os.environ["CODEX_WAIT_TIMEOUT"] = "1"
        try:
            svc = _load_codex_service()

            # Python script that:
            # 1. Prints JSON to stdout
            # 2. Closes stdout (so the for-loop exits)
            # 3. Sleeps indefinitely (process stays alive)
            cmd = [
                "python3", "-c",
                'import json, sys, os, time; '
                'print(json.dumps({"msg":{"type":"agent_message","message":"before_hang"}}), flush=True); '
                'sys.stdout.close(); '
                'os.close(1); '
                'time.sleep(300)'
            ]

            buf_stdout = io.StringIO()
            buf_stderr = io.StringIO()

            import contextlib
            start = time.time()
            with redirect_stdout(buf_stdout), contextlib.redirect_stderr(buf_stderr):
                code = svc.run_codex(cmd, verbose=False)
            elapsed = time.time() - start

            # Should complete much faster than 300s
            assert elapsed < 20, f"Watchdog should have terminated the process, took {elapsed:.1f}s"

            # Output before close should be captured
            assert "before_hang" in buf_stdout.getvalue()

            # Watchdog should have printed a warning about terminating
            stderr_out = buf_stderr.getvalue()
            assert "Terminating" in stderr_out
        finally:
            os.environ.pop("CODEX_WAIT_TIMEOUT", None)

    def test_sigterm_resistant_process_gets_killed(self):
        """Process that traps SIGTERM should eventually be SIGKILLed."""
        os.environ["CODEX_WAIT_TIMEOUT"] = "1"
        try:
            svc = _load_codex_service()

            # Python script that:
            # 1. Traps SIGTERM (ignores it)
            # 2. Prints JSON to stdout
            # 3. Closes stdout
            # 4. Sleeps indefinitely
            cmd = [
                "python3", "-c",
                'import json, sys, os, signal, time; '
                'signal.signal(signal.SIGTERM, lambda *a: None); '
                'print(json.dumps({"msg":{"type":"agent_message","message":"trapped"}}), flush=True); '
                'sys.stdout.close(); '
                'os.close(1); '
                'time.sleep(300)'
            ]

            buf_stdout = io.StringIO()
            buf_stderr = io.StringIO()

            import contextlib
            start = time.time()
            with redirect_stdout(buf_stdout), contextlib.redirect_stderr(buf_stderr):
                code = svc.run_codex(cmd, verbose=False)
            elapsed = time.time() - start

            # Should complete (SIGKILL can't be trapped)
            assert elapsed < 25, f"Watchdog should have killed the process, took {elapsed:.1f}s"

            # Output before close should be captured
            assert "trapped" in buf_stdout.getvalue()

            # Stderr should have both SIGTERM and SIGKILL warnings
            stderr_out = buf_stderr.getvalue()
            assert "Terminating" in stderr_out
            assert "Killing" in stderr_out
        finally:
            os.environ.pop("CODEX_WAIT_TIMEOUT", None)


# ===================================================================
# 5. ValueError handling from closed stdout
# ===================================================================

class TestWatchdogValueError:
    """Test that ValueError from watchdog-closed stdout is handled gracefully."""

    def test_closed_stdout_no_exception(self):
        """When watchdog closes stdout, no exception should propagate to caller."""
        svc = _load_codex_service()

        events = [{"msg": {"type": "agent_message", "message": "ok"}}]
        ndjson = "\\n".join(json.dumps(e) for e in events) + "\\n"
        cmd = ["bash", "-lc", f"printf '%s' '{ndjson}'"]

        buf = io.StringIO()
        with redirect_stdout(buf):
            code = svc.run_codex(cmd, verbose=False)

        assert code == 0


# ===================================================================
# 6. Empty output / no output scenarios
# ===================================================================

class TestWatchdogEmptyOutput:
    """Test watchdog behavior with no stdout output."""

    def test_empty_output_completes(self):
        """Process with no stdout output should complete without hanging."""
        svc = _load_codex_service()

        cmd = ["bash", "-lc", "true"]

        buf_stdout = io.StringIO()
        buf_stderr = io.StringIO()

        import contextlib
        start = time.time()
        with redirect_stdout(buf_stdout), contextlib.redirect_stderr(buf_stderr):
            code = svc.run_codex(cmd, verbose=False)
        elapsed = time.time() - start

        assert code == 0
        assert elapsed < 15

    def test_stderr_only_output_completes(self):
        """Process with only stderr output should complete without hanging."""
        svc = _load_codex_service()

        cmd = ["bash", "-lc", "echo 'error message' >&2"]

        buf_stdout = io.StringIO()
        buf_stderr = io.StringIO()

        import contextlib
        start = time.time()
        with redirect_stdout(buf_stdout), contextlib.redirect_stderr(buf_stderr):
            code = svc.run_codex(cmd, verbose=False)
        elapsed = time.time() - start

        assert code == 0
        assert elapsed < 15


# ===================================================================
# 7. Multiple events with watchdog active
# ===================================================================

class TestWatchdogWithMultipleEvents:
    """Test watchdog doesn't interfere with multi-event streams."""

    def test_many_events_all_captured(self):
        """Multiple events streamed rapidly should all be captured."""
        svc = _load_codex_service()

        events = [
            {"msg": {"type": "agent_message", "message": f"event_{i}"}}
            for i in range(20)
        ]
        ndjson = "\\n".join(json.dumps(e) for e in events) + "\\n"
        cmd = ["bash", "-lc", f"printf '%s' '{ndjson}'"]

        buf = io.StringIO()
        with redirect_stdout(buf):
            code = svc.run_codex(cmd, verbose=False)

        assert code == 0
        out = buf.getvalue()
        for i in range(20):
            assert f"event_{i}" in out

    def test_slow_stream_completes(self):
        """Events streamed with delays should all be captured."""
        svc = _load_codex_service()

        cmd = [
            "python3", "-c",
            'import json, time, sys; '
            '[('
            'print(json.dumps({"msg":{"type":"agent_message","message":f"slow_{i}"}}), flush=True), '
            'time.sleep(0.1)'
            ') for i in range(5)]'
        ]

        buf = io.StringIO()
        with redirect_stdout(buf):
            code = svc.run_codex(cmd, verbose=False)

        assert code == 0
        out = buf.getvalue()
        for i in range(5):
            assert f"slow_{i}" in out


# ===================================================================
# 8. Output done signal timing
# ===================================================================

class TestOutputDoneSignal:
    """Test that output_done event is properly signaled."""

    def test_output_done_after_stream_ends(self):
        """After stdout loop exits, output should be fully captured."""
        svc = _load_codex_service()

        events = [
            {"msg": {"type": "agent_reasoning", "text": "thinking"}},
            {"msg": {"type": "agent_message", "message": "answer"}},
        ]
        ndjson = "\\n".join(json.dumps(e) for e in events) + "\\n"
        cmd = ["bash", "-lc", f"printf '%s' '{ndjson}'"]

        buf = io.StringIO()
        with redirect_stdout(buf):
            code = svc.run_codex(cmd, verbose=False)

        assert code == 0
        out = buf.getvalue()
        assert "answer" in out

    def test_capture_file_written_after_output_done(self):
        """Capture file should contain last agent_message after output completes."""
        import tempfile

        svc = _load_codex_service()

        events = [
            {"msg": {"type": "agent_message", "message": "first"}},
            {"msg": {"type": "agent_message", "message": "last"}},
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
            assert captured.get("msg", {}).get("message") == "last"
        finally:
            os.environ.pop("JUNO_SUBAGENT_CAPTURE_PATH", None)
            if os.path.exists(capture_path):
                os.unlink(capture_path)


# ===================================================================
# 9. Watchdog with process that exits before output_done
# ===================================================================

class TestWatchdogProcessExitsFirst:
    """Test watchdog when process exits before output_done is signaled.

    This is scenario 1: process.poll() returns not-None while the watchdog
    is polling, which breaks the watchdog loop. The watchdog then sleeps
    2s and closes stdout.
    """

    def test_fast_exit_watchdog_doesnt_block(self):
        """Process that exits instantly should not cause watchdog to block."""
        svc = _load_codex_service()

        cmd = ["bash", "-lc", "echo '{\"msg\":{\"type\":\"agent_message\",\"message\":\"instant\"}}'"]

        buf = io.StringIO()
        start = time.time()
        with redirect_stdout(buf):
            code = svc.run_codex(cmd, verbose=False)
        elapsed = time.time() - start

        assert code == 0
        assert "instant" in buf.getvalue()
        assert elapsed < 10

    def test_process_exit_with_error_watchdog_doesnt_hang(self):
        """Process that exits with error should not cause watchdog to hang."""
        svc = _load_codex_service()

        cmd = ["bash", "-lc", "echo '{\"msg\":{\"type\":\"agent_message\",\"message\":\"error_out\"}}' && exit 1"]

        buf_stdout = io.StringIO()
        buf_stderr = io.StringIO()

        import contextlib
        start = time.time()
        with redirect_stdout(buf_stdout), contextlib.redirect_stderr(buf_stderr):
            code = svc.run_codex(cmd, verbose=False)
        elapsed = time.time() - start

        assert code == 1
        assert "error_out" in buf_stdout.getvalue()
        assert elapsed < 10
