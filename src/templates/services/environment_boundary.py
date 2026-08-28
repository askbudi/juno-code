#!/usr/bin/env python3
"""Shared child-environment boundary; never emits environment values."""

from __future__ import annotations

import json
import os
import re
from collections.abc import Mapping

_SCOPED_CONTINUITY_KEY_PREFIXES = (
    "YYLO_LAST_SESSION_ID_SCOPE_",
    "YYLO_LAST_EXECUTION_SETTINGS_SCOPE_",
    "JUNO_CODE_LAST_SESSION_ID_SCOPE_",
    "JUNO_CODE_LAST_EXECUTION_SETTINGS_SCOPE_",
)
_LEGACY_CONTINUITY_KEYS = frozenset(
    {
        "YYLO_LAST_SESSION_ID",
        "YYLO_LAST_EXECUTION_SETTINGS",
        "JUNO_CODE_LAST_SESSION_ID",
        "JUNO_CODE_LAST_EXECUTION_SETTINGS",
    }
)
_MODEL_SHORTCUTS_ENV = "JUNO_MODEL_SHORTCUTS"
_MODEL_SHORTCUT_ENV_KEYS = frozenset({_MODEL_SHORTCUTS_ENV, "JUNO_SELECTED_SUBAGENT"})
_MODEL_SHORTCUT_KEY = re.compile(r"^:[A-Za-z0-9_-]+$")
_MODEL_SHORTCUT_SUBAGENTS = frozenset({"claude", "cursor", "codex", "gemini", "pi"})


class ModelShortcutError(ValueError):
    """Raised when model-shortcut input cannot be safely resolved."""


def _project_model_shortcuts(
    subagent: str,
    environment: Mapping[str, str],
) -> dict[str, str]:
    raw = environment.get(_MODEL_SHORTCUTS_ENV)
    if raw is None:
        return {}
    try:
        configured = json.loads(raw)
    except (json.JSONDecodeError, TypeError) as error:
        raise ModelShortcutError(f"malformed {_MODEL_SHORTCUTS_ENV}: expected JSON object") from error
    if not isinstance(configured, dict):
        raise ModelShortcutError(f"malformed {_MODEL_SHORTCUTS_ENV}: expected JSON object")
    unknown_subagents = sorted(set(configured) - _MODEL_SHORTCUT_SUBAGENTS)
    if unknown_subagents:
        raise ModelShortcutError(
            f"malformed {_MODEL_SHORTCUTS_ENV}: unknown subagent {unknown_subagents[0]}"
        )
    selected = configured.get(subagent, {})
    if not isinstance(selected, dict):
        raise ModelShortcutError(
            f"malformed {_MODEL_SHORTCUTS_ENV}: {subagent} shortcuts must be an object"
        )
    shortcuts: dict[str, str] = {}
    for key, value in selected.items():
        if not isinstance(key, str) or not _MODEL_SHORTCUT_KEY.fullmatch(key):
            raise ModelShortcutError(
                f"malformed {_MODEL_SHORTCUTS_ENV}: invalid {subagent} shortcut key"
            )
        if not isinstance(value, str) or not value.strip():
            raise ModelShortcutError(
                f"malformed {_MODEL_SHORTCUTS_ENV}: target for {key} must be a non-empty string"
            )
        shortcuts[key] = value.strip()
    return shortcuts


def resolve_model_shortcut(
    model: str,
    shipped_shortcuts: Mapping[str, str],
    subagent: str,
    environment: Mapping[str, str] | None = None,
) -> str:
    """Resolve shipped and project shortcuts, refusing malformed or unknown aliases."""
    if subagent not in _MODEL_SHORTCUT_SUBAGENTS:
        raise ModelShortcutError(f"unknown model-shortcut subagent: {subagent}")
    source = os.environ if environment is None else environment
    shortcuts = {**shipped_shortcuts, **_project_model_shortcuts(subagent, source)}
    current = model
    chain: list[str] = []
    while current.startswith(":"):
        if current in chain:
            cycle = " -> ".join([*chain[chain.index(current):], current])
            raise ModelShortcutError(f"model shortcut cycle for {subagent}: {cycle}")
        target = shortcuts.get(current)
        if target is None:
            raise ModelShortcutError(f"unknown model shortcut for {subagent}: {current}")
        chain.append(current)
        current = target
    return current


def is_continuity_environment_key(name: str) -> bool:
    return name in _LEGACY_CONTINUITY_KEYS or name.startswith(_SCOPED_CONTINUITY_KEY_PREFIXES)


def sanitize_model_shortcut_environment() -> None:
    """Remove internal shortcut transport before launching a provider process."""
    for name in _MODEL_SHORTCUT_ENV_KEYS:
        os.environ.pop(name, None)


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
        if not is_continuity_environment_key(name) and name not in _MODEL_SHORTCUT_ENV_KEYS
    }


def sanitize_current_process_environment() -> None:
    for name in tuple(os.environ):
        if is_continuity_environment_key(name):
            os.environ.pop(name, None)
