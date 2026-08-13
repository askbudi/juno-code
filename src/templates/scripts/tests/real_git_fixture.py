#!/usr/bin/env python3
"""Authoritative minimum Juno source-repository declarations for real-Git tests."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

JUNO_PACKAGE = "juno-code/package.json"
GENERATED_DECLARATION = "juno-code/scripts/implementation-contract.json"
MANAGED_DECLARATION = "juno-code/src/templates/managed-assets.json"
GENERATED_SOURCE = "juno-code/src/templates/skills/canonical/fixture.md"
GENERATED_DESTINATION = ".agents/skills/fixture.md"
MANAGED_SOURCE = "juno-code/src/templates/scripts/task_workspace.py"
MANAGED_DESTINATION = ".juno_task/scripts/task_workspace.py"
REQUIRED_DECLARATIONS = (JUNO_PACKAGE, GENERATED_DECLARATION, MANAGED_DECLARATION)


def _write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n")


def install_juno_admission_fixture(repository: Path, runtime_bytes: bytes,
                                    *, version: str = "9.0.0") -> list[str]:
    """Install one useful generated pair and one useful managed pair."""
    source = repository / GENERATED_SOURCE
    destination = repository / GENERATED_DESTINATION
    source.parent.mkdir(parents=True, exist_ok=True)
    destination.parent.mkdir(parents=True, exist_ok=True)
    source.write_text("authoritative generated fixture\n")
    destination.write_bytes(source.read_bytes())
    managed_source = repository / MANAGED_SOURCE
    managed_destination = repository / MANAGED_DESTINATION
    managed_source.parent.mkdir(parents=True, exist_ok=True)
    managed_destination.parent.mkdir(parents=True, exist_ok=True)
    managed_source.write_bytes(runtime_bytes)
    managed_destination.write_bytes(runtime_bytes)
    _write_json(repository / JUNO_PACKAGE, {"name": "juno-code", "version": version})
    _write_json(repository / GENERATED_DECLARATION, {
        "schema_version": "juno_generated_output_contract.v1",
        "source": GENERATED_SOURCE,
        "destinations": [GENERATED_DESTINATION],
    })
    _write_json(repository / MANAGED_DECLARATION, {
        "schemaVersion": 1,
        "assets": [{"source": "scripts/task_workspace.py",
                    "destination": MANAGED_DESTINATION,
                    "installClass": "script", "type": "script"}],
        "admissionOutputs": [{"source": "scripts/task_workspace.py",
                              "destination": MANAGED_DESTINATION}],
    })
    assert_juno_admission_fixture(repository)
    return [JUNO_PACKAGE, GENERATED_DECLARATION, MANAGED_DECLARATION,
            GENERATED_SOURCE, GENERATED_DESTINATION, MANAGED_SOURCE, MANAGED_DESTINATION]


def assert_juno_admission_fixture(repository: Path) -> None:
    missing = [relative for relative in REQUIRED_DECLARATIONS
               if not (repository / relative).is_file()]
    if missing:
        raise AssertionError(
            "real-Git Juno fixture missing authoritative admission assets: " + ", ".join(missing))
    package = json.loads((repository / JUNO_PACKAGE).read_text())
    generated = json.loads((repository / GENERATED_DECLARATION).read_text())
    managed = json.loads((repository / MANAGED_DECLARATION).read_text())
    valid = (
        package.get("name") == "juno-code"
        and generated.get("schema_version") == "juno_generated_output_contract.v1"
        and generated.get("source") == GENERATED_SOURCE
        and generated.get("destinations") == [GENERATED_DESTINATION]
        and managed.get("schemaVersion") == 1
        and isinstance(managed.get("assets"), list)
        and managed.get("admissionOutputs") == [{
            "source": "scripts/task_workspace.py", "destination": MANAGED_DESTINATION,
        }]
    )
    if not valid:
        raise AssertionError("real-Git Juno fixture authoritative admission manifests are misaligned")
