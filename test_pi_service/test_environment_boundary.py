import json
import os
import subprocess
import sys
from pathlib import Path

import pytest


SERVICES = Path(__file__).resolve().parents[1] / "src" / "templates" / "services"


@pytest.mark.parametrize("module", ["claude", "codex", "gemini", "pi"])
def test_service_entrypoints_scrub_continuity_without_dropping_config(module):
    environment = dict(os.environ)
    environment["PYTHONPATH"] = str(SERVICES)
    environment["JUNO_CODE_LAST_SESSION_ID_SCOPE_0123456789ABCDEF"] = "not-printed"
    environment["JUNO_CODE_LAST_SESSION_ID_SCOPE_malformed_old_suffix"] = "not-printed"
    environment["JUNO_CODE_LAST_EXECUTION_SETTINGS_SCOPE_"] = "not-printed"
    environment["JUNO_CODE_LAST_EXECUTION_SETTINGS"] = "not-printed"
    environment["JUNO_TASK_ROOT"] = "/controller"
    environment["BOUNDARY_CONFIG"] = "preserved"

    completed = subprocess.run(
        [
            sys.executable,
            "-c",
            (
                f"import {module}, json, os; "
                "print(json.dumps({'continuity_names': sorted(k for k in os.environ if k.startswith('JUNO_CODE_LAST_')), "
                "'routing_present': 'JUNO_TASK_ROOT' in os.environ, "
                "'config_present': 'BOUNDARY_CONFIG' in os.environ}))"
            ),
        ],
        cwd=SERVICES,
        env=environment,
        text=True,
        capture_output=True,
        check=True,
    )

    assert json.loads(completed.stdout) == {
        "continuity_names": [],
        "routing_present": True,
        "config_present": True,
    }


def test_provider_child_boundary_drops_internal_shortcut_transport(monkeypatch):
    sys.path.insert(0, str(SERVICES))
    try:
        from environment_boundary import (
            child_process_environment,
            sanitize_model_shortcut_environment,
        )

        base = {
            "JUNO_MODEL_SHORTCUTS": '{"pi":{":fav":"provider/model"}}',
            "JUNO_SELECTED_SUBAGENT": "pi",
            "JUNO_TASK_ROOT": "/controller",
            "BOUNDARY_CONFIG": "preserved",
        }
        assert child_process_environment(base) == {
            "JUNO_TASK_ROOT": "/controller",
            "BOUNDARY_CONFIG": "preserved",
        }

        monkeypatch.setenv("JUNO_MODEL_SHORTCUTS", base["JUNO_MODEL_SHORTCUTS"])
        monkeypatch.setenv("JUNO_SELECTED_SUBAGENT", "pi")
        sanitize_model_shortcut_environment()
        assert "JUNO_MODEL_SHORTCUTS" not in os.environ
        assert "JUNO_SELECTED_SUBAGENT" not in os.environ
    finally:
        sys.path.remove(str(SERVICES))
