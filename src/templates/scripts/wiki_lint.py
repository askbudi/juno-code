#!/usr/bin/env python3
"""Lint canonical or legacy .juno_task/wiki Markdown files.

The maintenance SOT is controller/wiki_maintenance.md in a canonical controller
wiki and wiki_maintenance.md in a legacy product install. This helper uses only
the Python standard library so cleanup checks remain runnable in empty agents.
"""
from __future__ import annotations

import argparse
import os
import re
import sys
import tempfile
import textwrap
import urllib.parse
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
WIKI_ROOT = REPO_ROOT / ".juno_task" / "wiki"
MARKDOWN_LINK_RE = re.compile(r"(?<!!)\[[^\]]*\]\(([^)]+)\)")
FENCED_CODE_RE = re.compile(r"(?ms)^[ \t]*(?:```|~~~).*?^[ \t]*(?:```|~~~)[ \t]*$")
INLINE_CODE_RE = re.compile(r"`[^`\n]*`")


def path_is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def maintenance_sot() -> Path:
    canonical = WIKI_ROOT / "controller" / "wiki_maintenance.md"
    return canonical if canonical.is_file() else WIKI_ROOT / "wiki_maintenance.md"
REQUIRED_CONTRACT_FIELDS = {
    "line_limit",
    "purpose",
    "failure_mode_prevented",
    "runtime_contract_enforced",
    "validation_gate",
}
OPTIONAL_CONTRACT_FIELDS = {"related_sots", "owns", "does_not_own"}
ALLOWED_CONTRACT_FIELDS = REQUIRED_CONTRACT_FIELDS | OPTIONAL_CONTRACT_FIELDS
VOLATILE_KEY_RE = re.compile(
    r"(^|_)(task_?id|incident|evidence|run_?id|run_?root|timestamp|status|report|raw_?log|pii|secret|token|password|api_?key|created_?at|updated_?at|current_?date)($|_)",
    re.IGNORECASE,
)
VOLATILE_VALUE_PATTERNS = [
    re.compile(r"\b\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?Z?)?\b"),
    re.compile(r"\b(?:run_id|run_root|task_id|incident_id|incident evidence|raw log|stack trace|traceback|password|secret|api[_-]?key|token)\b", re.IGNORECASE),
    re.compile(r"\[/?task_id\]|\bkanban_task:", re.IGNORECASE),
    re.compile(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", re.IGNORECASE),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
]


class LintResult:
    def __init__(self) -> None:
        self.failures = 0
        self.warnings = 0

    def emit(self, severity: str, path: Path, message: str) -> None:
        rel = path.relative_to(REPO_ROOT) if path.is_absolute() and path_is_relative_to(path, REPO_ROOT) else path
        print(f"{severity}\t{rel}\t{message}")
        if severity == "FAIL":
            self.failures += 1
        elif severity == "WARN":
            self.warnings += 1


def parse_scalar(value: str) -> Any:
    value = value.strip()
    if not value:
        return ""
    if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
        return value[1:-1]
    if value.lower() in {"true", "false"}:
        return value.lower() == "true"
    if re.fullmatch(r"[+-]?\d+", value):
        try:
            return int(value)
        except ValueError:
            return value
    return value


def parse_simple_yaml(raw: str) -> dict[str, Any]:
    """Parse the small YAML subset used by wiki_contract metadata.

    Supported forms: nested mappings via two-space indentation and block lists.
    This is intentionally strict; malformed/unsupported frontmatter fails closed
    instead of being silently accepted as policy metadata.
    """
    root: dict[str, Any] = {}
    stack: list[tuple[int, Any]] = [(-1, root)]
    last_key_at_indent: dict[int, tuple[Any, str]] = {}
    for lineno, line in enumerate(raw.splitlines(), 1):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if "\t" in line[: len(line) - len(line.lstrip())]:
            raise ValueError(f"line {lineno}: tabs are not supported in frontmatter indentation")
        indent = len(line) - len(line.lstrip(" "))
        stripped = line.strip()
        while stack and indent <= stack[-1][0]:
            stack.pop()
        parent = stack[-1][1]
        if stripped.startswith("- "):
            if not isinstance(parent, list):
                holder = last_key_at_indent.get(indent - 2)
                if not holder or not isinstance(holder[0], dict):
                    raise ValueError(f"line {lineno}: list item has no mapping key")
                mapping, key = holder
                if mapping.get(key) in (None, "", {}):
                    mapping[key] = []
                if not isinstance(mapping[key], list):
                    raise ValueError(f"line {lineno}: key {key!r} is not a list")
                parent = mapping[key]
                stack.append((indent - 1, parent))
            item = stripped[2:].strip()
            if not item:
                raise ValueError(f"line {lineno}: empty list items are not supported")
            parent.append(parse_scalar(item))
            continue
        if ":" not in stripped:
            raise ValueError(f"line {lineno}: expected key: value")
        key, value = stripped.split(":", 1)
        key = key.strip()
        if not key or not re.fullmatch(r"[A-Za-z0-9_-]+", key):
            raise ValueError(f"line {lineno}: invalid key {key!r}")
        if not isinstance(parent, dict):
            raise ValueError(f"line {lineno}: nested mappings inside lists are not supported")
        parsed_value: Any
        if value.strip() == "":
            parsed_value = {}
            stack.append((indent, parsed_value))
            last_key_at_indent[indent] = (parent, key)
        else:
            parsed_value = parse_scalar(value)
            last_key_at_indent[indent] = (parent, key)
        parent[key] = parsed_value
    return root


def extract_frontmatter(text: str) -> tuple[str | None, str]:
    if not text.startswith("---\n"):
        return None, text
    end = text.find("\n---\n", 4)
    if end == -1:
        raise ValueError("opening frontmatter delimiter has no closing --- delimiter")
    return text[4:end], text[end + 5 :]


def collect_frontmatter_values(prefix: str, value: Any) -> list[tuple[str, Any]]:
    rows: list[tuple[str, Any]] = []
    if isinstance(value, dict):
        for key, child in value.items():
            child_path = f"{prefix}.{key}" if prefix else str(key)
            rows.append((child_path, child))
            rows.extend(collect_frontmatter_values(child_path, child))
    elif isinstance(value, list):
        for idx, child in enumerate(value):
            rows.append((f"{prefix}[{idx}]", child))
            rows.extend(collect_frontmatter_values(f"{prefix}[{idx}]", child))
    return rows


def validate_no_volatile(path: Path, frontmatter: dict[str, Any], result: LintResult) -> None:
    for key_path, value in collect_frontmatter_values("", frontmatter):
        leaf_key = re.split(r"[.\[]", key_path)[-1].rstrip("]")
        if VOLATILE_KEY_RE.search(leaf_key):
            result.emit("FAIL", path, f"volatile frontmatter key is not allowed: {key_path}")
        if isinstance(value, str):
            for pattern in VOLATILE_VALUE_PATTERNS:
                if pattern.search(value):
                    result.emit("FAIL", path, f"volatile frontmatter value is not allowed at {key_path}")
                    break


def resolve_related_sot(current_file: Path, entry: str) -> Path | None:
    candidate = Path(entry)
    if candidate.is_absolute():
        return candidate if candidate.exists() else None
    current_inside_wiki = path_is_relative_to(current_file.resolve(), WIKI_ROOT.resolve())
    for base in (current_file.parent, WIKI_ROOT):
        resolved = (base / candidate).resolve()
        if current_inside_wiki and not path_is_relative_to(resolved, WIKI_ROOT.resolve()):
            continue
        if resolved.exists() and resolved.is_file():
            return resolved
    return None


def validate_contract(path: Path, contract: Any, result: LintResult) -> int | None:
    if not isinstance(contract, dict):
        result.emit("FAIL", path, "wiki_contract must be a mapping")
        return None
    missing = sorted(REQUIRED_CONTRACT_FIELDS - set(contract))
    for field in missing:
        result.emit("FAIL", path, f"wiki_contract missing required field: {field}")
    unknown = sorted(set(contract) - ALLOWED_CONTRACT_FIELDS)
    for field in unknown:
        result.emit("FAIL", path, f"wiki_contract has unsupported field: {field}")
    line_limit = contract.get("line_limit")
    if not isinstance(line_limit, int) or isinstance(line_limit, bool) or line_limit <= 0:
        result.emit("FAIL", path, "wiki_contract.line_limit must be a positive integer")
        effective_limit: int | None = None
    else:
        effective_limit = line_limit
    for field in sorted(REQUIRED_CONTRACT_FIELDS - {"line_limit"}):
        value = contract.get(field)
        if not isinstance(value, str) or not value.strip():
            result.emit("FAIL", path, f"wiki_contract.{field} must be a non-empty string")
    for field in ("owns", "does_not_own"):
        if field in contract:
            value = contract[field]
            if not isinstance(value, list) or not value or not all(isinstance(item, str) and item.strip() for item in value):
                result.emit("FAIL", path, f"wiki_contract.{field} must be a non-empty list of strings when present")
    if "related_sots" in contract:
        related = contract["related_sots"]
        if not isinstance(related, list) or not related or not all(isinstance(item, str) and item.strip() for item in related):
            result.emit("FAIL", path, "wiki_contract.related_sots must be a non-empty list of strings when present")
        else:
            for entry in related:
                if resolve_related_sot(path, entry) is None:
                    result.emit("FAIL", path, f"wiki_contract.related_sots entry does not exist: {entry}")
    return effective_limit


def markdown_link_target(raw: str) -> str | None:
    value = raw.strip()
    if value.startswith("<") and ">" in value:
        value = value[1:value.index(">")]
    else:
        value = value.split(maxsplit=1)[0] if value else ""
    if not value or value.startswith("#"):
        return None
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme or parsed.netloc:
        return None
    decoded = urllib.parse.unquote(parsed.path)
    if not decoded or any(marker in decoded for marker in ("{{", "}}", "$", "*")):
        return None
    return decoded


def validate_markdown_links(path: Path, text: str, result: LintResult) -> None:
    prose = INLINE_CODE_RE.sub("", FENCED_CODE_RE.sub("", text))
    boundary = REPO_ROOT.resolve() if path_is_relative_to(path.resolve(), REPO_ROOT.resolve()) else path.parent.parent.resolve()
    for match in MARKDOWN_LINK_RE.finditer(prose):
        target = markdown_link_target(match.group(1))
        if target is None:
            continue
        candidate = (REPO_ROOT / target.lstrip("/")) if target.startswith("/") else (path.parent / target)
        resolved = candidate.resolve()
        if not path_is_relative_to(resolved, boundary):
            result.emit("FAIL", path, f"relative Markdown link escapes repository root: {target}")
        elif not resolved.exists():
            result.emit("FAIL", path, f"relative Markdown link target does not exist: {target}")


def raw_frontmatter_has_wiki_contract(raw: str) -> bool:
    return re.search(r"(?m)^wiki_contract\s*:", raw) is not None


def lint_file(path: Path, default_max_lines: int, result: LintResult) -> None:
    path = path.resolve()
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        result.emit("FAIL", path, f"file is not valid UTF-8: {exc}")
        return
    except OSError as exc:
        result.emit("FAIL", path, f"cannot read file: {exc}")
        return
    effective_limit = default_max_lines
    try:
        raw_frontmatter, _body = extract_frontmatter(text)
    except ValueError as exc:
        result.emit("FAIL", path, str(exc))
        raw_frontmatter = None
    if raw_frontmatter is None:
        result.emit("WARN", path, "no YAML frontmatter/wiki_contract; migration warning only")
    else:
        frontmatter_has_contract = raw_frontmatter_has_wiki_contract(raw_frontmatter)
        parse_failed = False
        try:
            frontmatter = parse_simple_yaml(raw_frontmatter)
        except ValueError as exc:
            parse_failed = True
            if frontmatter_has_contract:
                result.emit("FAIL", path, f"invalid YAML frontmatter subset for wiki_contract: {exc}")
            else:
                result.emit("WARN", path, "YAML frontmatter has no wiki_contract; unsupported/malformed non-contract frontmatter ignored during migration")
            frontmatter = {}
        if "wiki_contract" not in frontmatter:
            if frontmatter_has_contract:
                result.emit("FAIL", path, "wiki_contract could not be parsed as a top-level mapping")
            elif not parse_failed:
                result.emit("WARN", path, "YAML frontmatter has no wiki_contract; migration warning only")
        else:
            validate_no_volatile(path, frontmatter, result)
            contract_limit = validate_contract(path, frontmatter["wiki_contract"], result)
            if contract_limit is not None:
                effective_limit = contract_limit
    validate_markdown_links(path, text, result)
    line_count = len(text.splitlines())
    if line_count > effective_limit:
        result.emit("FAIL", path, f"line count {line_count} exceeds effective limit {effective_limit}")
    else:
        result.emit("PASS", path, f"line count {line_count} within effective limit {effective_limit}")


def iter_wiki_files() -> list[Path]:
    return sorted(WIKI_ROOT.rglob("*.md"))


def positive_int(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("must be a positive integer") from exc
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return parsed


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Lint wiki Markdown contracts and local links. Policy SOT: "
            f"{maintenance_sot()}. CLI --max-lines sets the default "
            "limit (250 by default); a valid wiki_contract.line_limit overrides it per file."
        )
    )
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--file", type=Path, help="lint one markdown file")
    mode.add_argument("--all", action="store_true", help="lint every .juno_task/wiki/**/*.md file")
    mode.add_argument("--self-test", action="store_true", help="run built-in stdlib self-tests for the lint helper")
    parser.add_argument("--max-lines", type=positive_int, default=250, help="default max lines when no contract override exists (default: 250)")
    return parser


def run_self_test() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        rel_sot = tmp_path / "sot.md"
        rel_sot.write_text("# SOT\n", encoding="utf-8")
        cases = tmp_path / "cases"
        cases.mkdir()
        valid = cases / "valid.md"
        valid.write_text(textwrap.dedent("""\
        ---
        wiki_contract:
          line_limit: 20
          purpose: "Stable wiki lint test fixture."
          failure_mode_prevented: "Prevents false-green contract parsing."
          runtime_contract_enforced: "Valid frontmatter passes."
          validation_gate: "wiki_lint self-test"
          related_sots:
            - "../sot.md"
          owns:
            - "Fixture ownership."
          does_not_own:
            - "One-off task artifacts."
        ---
        # Valid
        """), encoding="utf-8")
        no_yaml = cases / "no_yaml.md"
        no_yaml.write_text("# No YAML\n", encoding="utf-8")
        invalid = cases / "invalid.md"
        invalid.write_text("---\nwiki_contract:\n  line_limit: nope\n---\n# Invalid\n", encoding="utf-8")
        non_contract_bad = cases / "non_contract_bad.md"
        non_contract_bad.write_text("---\ntitle: Metadata only\nthis line is not simple yaml\n---\n# Metadata\n", encoding="utf-8")
        malformed_contract = cases / "malformed_contract.md"
        malformed_contract.write_text("---\nwiki_contract:\n\tline_limit: 250\n---\n# Bad contract\n", encoding="utf-8")
        missing_sot = cases / "missing_sot.md"
        missing_sot.write_text(textwrap.dedent("""\
        ---
        wiki_contract:
          line_limit: 20
          purpose: "Stable fixture."
          failure_mode_prevented: "Prevents missing SOT false green."
          runtime_contract_enforced: "SOT links must exist."
          validation_gate: "wiki_lint self-test"
          related_sots:
            - "missing.md"
        ---
        # Missing SOT
        """), encoding="utf-8")
        too_long = cases / "too_long.md"
        too_long.write_text("# Too long\n" + "x\n" * 5, encoding="utf-8")
        override = cases / "override.md"
        override.write_text(textwrap.dedent("""\
        ---
        wiki_contract:
          line_limit: 12
          purpose: "Stable fixture."
          failure_mode_prevented: "Prevents default-limit-only lint."
          runtime_contract_enforced: "Per-file override works."
          validation_gate: "wiki_lint self-test"
        ---
        # Override
        one
        two
        three
        """), encoding="utf-8")
        linked = cases / "linked.md"
        linked.write_text("[valid](../sot.md) [external](https://example.com/x) "
                          "`[inline example](missing-inline.md)`\n"
                          "```md\n[example](missing-example.md)\n```\n", encoding="utf-8")
        missing_link = cases / "missing_link.md"
        missing_link.write_text("[missing](missing.md)\n", encoding="utf-8")
        escaping_link = cases / "escaping_link.md"
        escaping_link.write_text("[escape](../../outside.md)\n", encoding="utf-8")
        checks = [
            (valid, 250, 0, "valid contract passes"),
            (no_yaml, 250, 0, "no YAML warns but exits 0"),
            (invalid, 250, 1, "invalid contract fails"),
            (non_contract_bad, 250, 0, "unsupported non-contract frontmatter warns but exits 0"),
            (malformed_contract, 250, 1, "malformed present wiki_contract fails"),
            (missing_sot, 250, 1, "missing related_sot fails"),
            (too_long, 3, 1, "line-limit violation fails"),
            (override, 3, 0, "per-file line_limit override works"),
            (linked, 250, 0, "relative links pass while external and fenced examples are excluded"),
            (missing_link, 250, 1, "missing relative Markdown link fails"),
            (escaping_link, 250, 1, "relative Markdown link cannot escape repository root"),
        ]
        ok = True
        for file_path, max_lines, expected_failure_state, label in checks:
            result = LintResult()
            lint_file(file_path, max_lines, result)
            failed = 1 if result.failures else 0
            if failed != expected_failure_state:
                print(f"FAIL\tSELF_TEST\t{label}: expected failure_state={expected_failure_state} got {failed}")
                ok = False
            else:
                print(f"PASS\tSELF_TEST\t{label}")
        return 0 if ok else 1


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.self_test:
        return run_self_test()
    paths = iter_wiki_files() if args.all else [args.file]
    result = LintResult()
    for path in paths:
        if path.suffix != ".md":
            result.emit("FAIL", path, "target must be a markdown file")
            continue
        if not path.exists():
            result.emit("FAIL", path, "target file does not exist")
            continue
        lint_file(path, args.max_lines, result)
    if result.failures:
        print(f"SUMMARY\tFAIL\tfailures={result.failures}\twarnings={result.warnings}")
        return 1
    print(f"SUMMARY\tPASS\tfailures=0\twarnings={result.warnings}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
