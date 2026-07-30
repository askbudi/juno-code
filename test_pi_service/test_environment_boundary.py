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
