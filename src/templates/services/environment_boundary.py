#!/usr/bin/env python3
"""Shared child-environment boundary; never emits environment values."""

from __future__ import annotations

import os
from collections.abc import Mapping

_SCOPED_CONTINUITY_KEY_PREFIXES = (
    "JUNO_CODE_LAST_SESSION_ID_SCOPE_",
    "JUNO_CODE_LAST_EXECUTION_SETTINGS_SCOPE_",
)
_LEGACY_CONTINUITY_KEYS = frozenset(
    {"JUNO_CODE_LAST_SESSION_ID", "JUNO_CODE_LAST_EXECUTION_SETTINGS"}
)


def is_continuity_environment_key(name: str) -> bool:
    return name in _LEGACY_CONTINUITY_KEYS or name.startswith(_SCOPED_CONTINUITY_KEY_PREFIXES)


def child_process_environment(
    base: Mapping[str, str] | None = None,
    overrides: Mapping[str, str] | None = None,
) -> dict[str, str]:
    environment = dict(os.environ if base is None else base)
    if overrides:
        environment.update(overrides)
    return {
        name: value
        for name, value in environment.items()
        if not is_continuity_environment_key(name)
    }


def sanitize_current_process_environment() -> None:
    for name in tuple(os.environ):
        if is_continuity_environment_key(name):
            os.environ.pop(name, None)
