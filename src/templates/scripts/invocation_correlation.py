#!/usr/bin/env python3
"""Minimal environment contract for canonical Juno child invocations."""
from __future__ import annotations

from typing import Mapping

CHILD_MARKER = "JUNO_CODE_INVOCATION_CHILD"
CHILD_KEYS = {
    "trace_id": "JUNO_CODE_TRACE_ID",
    "parent_span_id": "JUNO_CODE_PARENT_SPAN_ID",
    "task_id": "JUNO_CODE_TASK_ID",
    "workflow_run_id": "JUNO_CODE_WORKFLOW_RUN_ID",
    "workflow_step_id": "JUNO_CODE_WORKFLOW_STEP_ID",
    "launch_surface": "JUNO_CODE_LAUNCH_SURFACE",
}
ACTIVE_KEYS = {
    "trace_id": "JUNO_CODE_ACTIVE_TRACE_ID",
    "span_id": "JUNO_CODE_ACTIVE_SPAN_ID",
    "task_id": "JUNO_CODE_ACTIVE_TASK_ID",
    "workflow_run_id": "JUNO_CODE_ACTIVE_WORKFLOW_RUN_ID",
    "workflow_step_id": "JUNO_CODE_ACTIVE_WORKFLOW_STEP_ID",
}
ALL_KEYS = {CHILD_MARKER, *CHILD_KEYS.values(), *ACTIVE_KEYS.values()}


def child_invocation_environment(
    base: Mapping[str, str], *, launch_surface: str, task_id: str | None = None,
    workflow_run_id: str | None = None, workflow_step_id: str | None = None,
    source: Mapping[str, str] | None = None,
) -> dict[str, str]:
    """Return a copied environment containing one explicit, non-ambient child contract.

    Active context is published by a running Juno invocation. A canonical runner
    may also transparently forward an unconsumed contract when it is itself the
    process launched at that boundary. Contract keys are always rebuilt, so a
    later unrelated launch from ``base`` cannot inherit stale child state.
    """
    source = source or base
    env = {key: value for key, value in base.items() if key not in ALL_KEYS}
    active_trace = source.get(ACTIVE_KEYS["trace_id"], "").strip()
    active_span = source.get(ACTIVE_KEYS["span_id"], "").strip()
    forwarded = source.get(CHILD_MARKER) == "1"
    trace_id = active_trace or (source.get(CHILD_KEYS["trace_id"], "").strip() if forwarded else "")
    parent_span_id = active_span or (source.get(CHILD_KEYS["parent_span_id"], "").strip() if forwarded else "")

    inherited = {
        "task_id": source.get(ACTIVE_KEYS["task_id"], "").strip()
        or (source.get(CHILD_KEYS["task_id"], "").strip() if forwarded else ""),
        "workflow_run_id": source.get(ACTIVE_KEYS["workflow_run_id"], "").strip()
        or (source.get(CHILD_KEYS["workflow_run_id"], "").strip() if forwarded else ""),
        "workflow_step_id": source.get(ACTIVE_KEYS["workflow_step_id"], "").strip()
        or (source.get(CHILD_KEYS["workflow_step_id"], "").strip() if forwarded else ""),
    }
    values = {
        "task_id": task_id if task_id is not None else inherited["task_id"],
        "workflow_run_id": workflow_run_id if workflow_run_id is not None else inherited["workflow_run_id"],
        "workflow_step_id": workflow_step_id if workflow_step_id is not None else inherited["workflow_step_id"],
    }
    env[CHILD_MARKER] = "1"
    env[CHILD_KEYS["launch_surface"]] = launch_surface
    if trace_id and parent_span_id:
        env[CHILD_KEYS["trace_id"]] = trace_id
        env[CHILD_KEYS["parent_span_id"]] = parent_span_id
    for name, value in values.items():
        if value:
            env[CHILD_KEYS[name]] = value
    return env
