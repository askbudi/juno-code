#!/usr/bin/env python3
"""Emit named, reviewable workflow assertion diagnostics."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


def dotted_get(value: Any, field: str) -> tuple[bool, Any]:
    current = value
    for part in field.split("."):
        if isinstance(current, dict) and part in current:
            current = current[part]
        else:
            return False, None
    return True, current


def emit(name: str, passed: bool, *, expected: Any, actual: Any, source: str = "") -> int:
    payload = {
        "schema_version": "juno_workflow_assertion.v1",
        "name": name,
        "passed": passed,
        "expected": expected,
        "actual": actual,
        "source": source,
    }
    print(json.dumps(payload, sort_keys=True))
    return 0 if passed else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    equal = subparsers.add_parser("equal")
    equal.add_argument("--name", required=True)
    equal.add_argument("--expected", required=True)
    equal.add_argument("--actual", required=True)

    exists = subparsers.add_parser("file-exists")
    exists.add_argument("--name", required=True)
    exists.add_argument("--path", required=True)

    json_field = subparsers.add_parser("json-field")
    json_field.add_argument("--name", required=True)
    json_field.add_argument("--file", required=True)
    json_field.add_argument("--field", required=True)
    json_field.add_argument("--expected", required=True)

    args = parser.parse_args()
    if args.command == "equal":
        return emit(args.name, args.actual == args.expected, expected=args.expected, actual=args.actual)
    if args.command == "file-exists":
        path = Path(args.path)
        return emit(args.name, path.is_file(), expected="regular_file", actual="regular_file" if path.is_file() else "missing", source=str(path))

    path = Path(args.file)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        present, actual = dotted_get(payload, args.field)
    except Exception as exc:
        return emit(args.name, False, expected=args.expected, actual=f"invalid_json:{exc}", source=str(path))
    return emit(
        args.name,
        present and str(actual) == args.expected,
        expected=args.expected,
        actual=actual if present else "missing",
        source=f"{path}:{args.field}",
    )


if __name__ == "__main__":
    sys.exit(main())
