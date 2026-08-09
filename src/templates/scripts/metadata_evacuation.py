#!/usr/bin/env python3
"""Plan, apply, and verify Juno controller-metadata evacuation candidates."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

PLAN_SCHEMA = "juno_product_metadata_evacuation_plan.v1"
RECEIPT_SCHEMA = "juno_product_metadata_evacuation_receipt.v1"
INVENTORY_SCHEMA = "juno_migration_inventory.v1"
POLICY_SCHEMA = "juno_migration_policy_bundle.v1"
RETIRED_CONFIG_KEYS = ("controllerWorkspace", "lifecycle")


class EvacuationError(RuntimeError):
    pass


def run(argv: list[str], cwd: Path, *, check: bool = True, text: bool = True) -> str | bytes:
    result = subprocess.run(argv, cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=60, check=False, text=text,
                            env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"})
    if check and result.returncode:
        error = result.stderr.strip() if text else result.stderr.decode(errors="replace").strip()
        raise EvacuationError(f"command failed ({' '.join(argv[:3])}): {error}")
    return result.stdout


def git(root: Path, *args: str, check: bool = True) -> str:
    return str(run(["git", "-c", "core.fsmonitor=false", *args], root, check=check)).strip()


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise EvacuationError(f"invalid JSON input: {path}") from exc
    if not isinstance(value, dict):
        raise EvacuationError(f"JSON input must be an object: {path}")
    return value


def sha256(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def bytes_sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def exact_root(path: Path) -> Path:
    resolved = path.resolve()
    discovered = git(resolved, "rev-parse", "--show-toplevel", check=False) if resolved.is_dir() else ""
    if not discovered or Path(discovered).resolve() != resolved:
        raise EvacuationError(f"path is not an exact Git worktree root: {resolved}")
    return resolved


def common_dir(root: Path) -> Path:
    return Path(git(root, "rev-parse", "--path-format=absolute", "--git-common-dir")).resolve()


def atomic_json(output: Path, payload: dict[str, Any]) -> None:
    output = output.resolve()
    if output.exists():
        raise EvacuationError(f"output already exists: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(output.name + f".tmp-{os.getpid()}")
    temporary.write_text(json.dumps(payload, indent=2, sort_keys=True, separators=(",", ": ")) + "\n")
    os.replace(temporary, output)


def path_within(path: str, root: str) -> bool:
    return path == root or path.startswith(root.rstrip("/") + "/")


def tree_entries(root: Path, commit: str) -> list[dict[str, Any]]:
    raw = run(["git", "-c", "core.fsmonitor=false", "ls-tree", "-r", "-z", commit], root, text=False)
    rows = []
    for item in bytes(raw).split(b"\0"):
        if not item:
            continue
        metadata, separator, name = item.partition(b"\t")
        fields = metadata.decode().split()
        if not separator or len(fields) != 3:
            raise EvacuationError("unexpected git ls-tree record")
        rows.append({"path": name.decode(errors="surrogateescape"), "mode": fields[0],
                     "type": fields[1], "object": fields[2]})
    return sorted(rows, key=lambda row: row["path"])


def protected_output(output: Path, roots: list[Path]) -> None:
    resolved = output.resolve()
    for root in roots:
        try:
            resolved.relative_to(root.resolve())
            raise EvacuationError("output must be outside product, controller, candidate, and Git administration roots")
        except ValueError:
            pass


def transformed_config(root: Path, commit: str) -> dict[str, Any] | None:
    raw = run(["git", "show", f"{commit}:.juno_task/config.json"], root, check=False, text=False)
    if not raw:
        return None
    try:
        before = json.loads(bytes(raw))
    except json.JSONDecodeError as exc:
        raise EvacuationError("tracked .juno_task/config.json is not valid JSON") from exc
    if not isinstance(before, dict):
        raise EvacuationError("tracked .juno_task/config.json must be an object")
    after = dict(before)
    removed = [key for key in RETIRED_CONFIG_KEYS if key in after]
    for key in removed:
        del after[key]
    encoded = (json.dumps(after, indent=2, ensure_ascii=False) + "\n").encode()
    return {"path": ".juno_task/config.json", "before_sha256": bytes_sha256(bytes(raw)),
            "after_sha256": bytes_sha256(encoded), "removed_top_level_keys": removed,
            "changed": bool(removed)}


def disposition_map(inventory: dict[str, Any], policy: dict[str, Any]) -> dict[str, str]:
    decisions = policy.get("dispositions")
    rows = inventory.get("required_owner_answers", {}).get("dispositions", [])
    if not isinstance(decisions, dict) or not isinstance(rows, list):
        raise EvacuationError("inventory/policy disposition data is missing")
    result = {}
    for row in rows:
        if isinstance(row, dict) and isinstance(row.get("id"), str) and isinstance(row.get("path"), str):
            value = decisions.get(row["id"])
            if isinstance(value, str):
                result[row["path"]] = value
    return result


def evacuation_plan(args: argparse.Namespace) -> dict[str, Any]:
    inventory_path = args.inventory.resolve(); policy_path = args.policy.resolve()
    inventory = read_json(inventory_path); policy = read_json(policy_path)
    if inventory.get("schema_version") != INVENTORY_SCHEMA or policy.get("schema_version") != POLICY_SCHEMA:
        raise EvacuationError("unsupported inventory or policy schema")
    if policy.get("inventory_sha256") != sha256(inventory_path):
        raise EvacuationError("policy does not bind the exact inventory receipt")
    root = exact_root(args.project)
    frozen = inventory.get("git", {}); policies = policy.get("policies", {})
    task = policies.get("task_workspace", {}); metadata = policies.get("metadata_controller", {})
    target_ref = task.get("target_ref"); expected = frozen.get("selected_product_head")
    if root != Path(str(frozen.get("root"))).resolve():
        raise EvacuationError("project path differs from the inventoried source worktree")
    if common_dir(root) != Path(str(frozen.get("git_common_dir"))).resolve():
        raise EvacuationError("project Git common directory differs from inventory")
    if target_ref != frozen.get("selected_product_ref") or task.get("controller_private_paths") != metadata.get("product_forbidden"):
        raise EvacuationError("generated product/controller ownership policies disagree")
    if not isinstance(expected, str) or git(root, "rev-parse", f"{target_ref}^{{commit}}", check=False) != expected:
        raise EvacuationError("product ref moved since inventory")
    if git(root, "rev-parse", "HEAD") != expected:
        raise EvacuationError("source checkout is not at the exact frozen product head")
    private = task.get("controller_private_paths")
    copied = metadata.get("copied_metadata")
    if not isinstance(private, list) or not private or not all(isinstance(path, str) and path.startswith(".juno_task/") for path in private):
        raise EvacuationError("controller-private roots are invalid")
    if not isinstance(copied, list) or not set(copied).issubset(private):
        raise EvacuationError("copied controller metadata is inconsistent")
    dispositions = disposition_map(inventory, policy)
    missing = sorted(path for path in private if path not in dispositions)
    if missing:
        raise EvacuationError("unclassified controller-private roots: " + ", ".join(missing))
    if any(dispositions[path] == "block" for path in private):
        raise EvacuationError("blocked controller-private disposition refuses evacuation")
    entries = tree_entries(root, expected)
    removals = [row for row in entries if any(path_within(row["path"], private_root) for private_root in private)]
    protected_children = [row["path"] for row in removals if row["mode"] == "160000"]
    for collection in (inventory.get("gitlinks", []), inventory.get("nested_repositories", [])):
        for row in collection if isinstance(collection, list) else []:
            child = row.get("path") if isinstance(row, dict) else None
            if isinstance(child, str) and any(path_within(child, private_root) for private_root in private):
                protected_children.append(child)
    if protected_children:
        raise EvacuationError("controller-private roots cross nested repository/gitlink boundaries: " + ", ".join(sorted(set(protected_children))))
    config = transformed_config(root, expected)
    tree = git(root, "rev-parse", f"{expected}^{{tree}}")
    controller = inventory.get("controller", {})
    controller_path = controller.get("selected_path")
    if not isinstance(controller_path, str) or not controller.get("head") or not controller.get("branch"):
        raise EvacuationError("inventory does not contain an exact rollback controller identity")
    rollback_controller = exact_root(Path(controller_path))
    if (git(rollback_controller, "rev-parse", "HEAD") != controller["head"]
            or git(rollback_controller, "symbolic-ref", "-q", "HEAD", check=False) != controller["branch"]
            or str(common_dir(rollback_controller)) != controller.get("git_common_dir")):
        raise EvacuationError("rollback controller identity moved since inventory")
    if git(rollback_controller, "status", "--porcelain=v1", "--untracked-files=all"):
        raise EvacuationError("rollback controller must be clean when the evacuation plan is frozen")
    fresh_path = policy.get("selected_paths", {}).get("controller")
    if not isinstance(fresh_path, str) or not Path(fresh_path).is_absolute():
        raise EvacuationError("fresh controller destination must be an explicit absolute path")
    if Path(fresh_path).resolve() in (root, common_dir(root), rollback_controller):
        raise EvacuationError("fresh controller destination must be separate from product and rollback controller roots")
    roots = [root, common_dir(root)] + [Path(row["path"]) for row in frozen.get("worktrees", []) if isinstance(row, dict) and row.get("path")]
    if controller.get("selected_path"): roots.append(Path(controller["selected_path"]))
    protected_output(args.output, roots)
    return {
        "schema_version": PLAN_SCHEMA, "operation": "evacuation-plan", "outcome": "planned_no_mutation",
        "mutation_authorized": False, "inventory_sha256": sha256(inventory_path), "policy_sha256": sha256(policy_path),
        "source": {"worktree": str(root), "git_common_dir": str(common_dir(root)), "product_ref": target_ref,
                   "product_head": expected, "product_tree": tree},
        "controller_backup": {"path": controller.get("selected_path"), "branch": controller.get("branch"),
                              "head": controller.get("head"), "git_common_dir": controller.get("git_common_dir")},
        "fresh_controller": {"path": fresh_path,
                             "branch": metadata.get("controller_branch"), "copied_metadata": copied},
        "ownership": {"controller_private_paths": private, "dispositions": {path: dispositions[path] for path in sorted(private)},
                      "unclassified_paths": [], "nested_repository_policy": "protect_exact_child_identity"},
        "changes": {"remove": removals, "config_transform": config, "remove_count": len(removals)},
        "rollback": {"product_ref": target_ref, "product_head": expected, "product_tree": tree,
                     "controller_path": controller.get("selected_path"), "controller_branch": controller.get("branch"),
                     "controller_head": controller.get("head"), "independent_identities": True},
    }


def load_plan(path: Path) -> dict[str, Any]:
    plan = read_json(path)
    if plan.get("schema_version") != PLAN_SCHEMA or plan.get("operation") != "evacuation-plan":
        raise EvacuationError("unsupported evacuation plan")
    return plan


def candidate_guard(plan: dict[str, Any], candidate: Path, output: Path) -> Path:
    root = exact_root(candidate); source = Path(plan["source"]["worktree"]).resolve()
    if root == source:
        raise EvacuationError("refusing to mutate or validate the inventoried source worktree as a candidate")
    if common_dir(root) != Path(plan["source"]["git_common_dir"]).resolve():
        raise EvacuationError("candidate is not linked to the planned product repository")
    listed = {Path(row.split(" ", 1)[1]).resolve() for row in git(root, "worktree", "list", "--porcelain").splitlines() if row.startswith("worktree ")}
    if root not in listed:
        raise EvacuationError("candidate is not a registered linked worktree")
    if git(root, "rev-parse", "HEAD") != plan["source"]["product_head"]:
        raise EvacuationError("candidate HEAD does not equal the planned base")
    branch = git(root, "symbolic-ref", "-q", "HEAD", check=False) or None
    if branch == plan["source"]["product_ref"]:
        raise EvacuationError("candidate must not check out the protected product target ref")
    protected_output(output, [root, source, common_dir(root)])
    return root


def write_transformed_config(root: Path, transform: dict[str, Any] | None) -> None:
    if not transform or not transform.get("changed"):
        return
    path = root / transform["path"]
    if sha256(path) != transform["before_sha256"]:
        raise EvacuationError("candidate config bytes differ from the plan")
    value = read_json(path)
    for key in transform["removed_top_level_keys"]:
        value.pop(key, None)
    encoded = json.dumps(value, indent=2, ensure_ascii=False) + "\n"
    if bytes_sha256(encoded.encode()) != transform["after_sha256"]:
        raise EvacuationError("candidate config transformation is not deterministic")
    temporary = path.with_name(path.name + f".tmp-{os.getpid()}")
    temporary.write_text(encoded); os.replace(temporary, path)


def apply_candidate(args: argparse.Namespace) -> dict[str, Any]:
    if not args.allow_disposable_mutation:
        raise EvacuationError("--allow-disposable-mutation is required")
    plan = load_plan(args.plan.resolve()); root = candidate_guard(plan, args.candidate, args.output)
    if git(root, "status", "--porcelain=v1", "--untracked-files=all"):
        raise EvacuationError("candidate must be clean before evacuation apply")
    private = plan["ownership"]["controller_private_paths"]
    ordinary = git(root, "ls-files", "--others", "--exclude-standard", "-z").split("\0")
    ignored = git(root, "ls-files", "--others", "--ignored", "--exclude-standard", "-z").split("\0")
    evidence = sorted(path for path in ordinary + ignored if path and any(path_within(path, prefix) for prefix in private))
    if evidence:
        raise EvacuationError("candidate contains untracked/ignored evidence under planned removal roots")
    for row in plan["changes"]["remove"]:
        path = root / row["path"]
        if not path.is_symlink() and not path.is_file():
            raise EvacuationError(f"planned tracked path is missing or not a file: {row['path']}")
        if git(root, "hash-object", "--", row["path"]) != row["object"]:
            raise EvacuationError(f"planned tracked bytes changed: {row['path']}")
    transform = plan["changes"].get("config_transform")
    if transform and transform.get("changed") and sha256(root / transform["path"]) != transform["before_sha256"]:
        raise EvacuationError("candidate config bytes differ from the plan")
    for row in plan["changes"]["remove"]:
        path = root / row["path"]
        if path.is_symlink() or path.is_file(): path.unlink()
    write_transformed_config(root, transform)
    return verification_payload(plan, root, "evacuation-apply", sha256(args.plan.resolve()))


def changed_paths(root: Path) -> list[str]:
    raw = run(["git", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--untracked-files=all"], root)
    result = []
    items = iter(str(raw).split("\0"))
    for item in items:
        if not item: continue
        result.append(item[3:])
        if "R" in item[:2] or "C" in item[:2]: next(items, None)
    return sorted(result)


def verification_payload(plan: dict[str, Any], root: Path, operation: str, plan_hash: str) -> dict[str, Any]:
    expected = {row["path"] for row in plan["changes"]["remove"]}
    transform = plan["changes"].get("config_transform")
    if transform and transform.get("changed"): expected.add(transform["path"])
    actual = set(changed_paths(root))
    remaining = sorted(row["path"] for row in plan["changes"]["remove"] if (root / row["path"]).exists())
    unexpected = sorted(actual - expected); missing_changes = sorted(expected - actual)
    config_valid = True
    if transform and transform.get("changed"):
        path = root / transform["path"]
        config_valid = path.is_file() and sha256(path) == transform["after_sha256"]
    gitlinks = [{"path": row["path"], "head": row["object"]} for row in tree_entries(root, "HEAD") if row["mode"] == "160000"]
    current_target = git(root, "rev-parse", f"{plan['source']['product_ref']}^{{commit}}", check=False)
    target_mutated = current_target != plan["source"]["product_head"]
    passed = not remaining and not unexpected and not missing_changes and config_valid and not target_mutated
    return {"schema_version": RECEIPT_SCHEMA, "operation": operation, "outcome": "verified" if passed else "refused",
            "plan_sha256": plan_hash, "candidate": {"path": str(root), "head": git(root, "rev-parse", "HEAD"),
            "branch": git(root, "symbolic-ref", "-q", "HEAD", check=False) or None}, "passed": passed,
            "remaining_removals": remaining, "unexpected_changes": unexpected, "missing_changes": missing_changes,
            "config_transform_valid": config_valid, "gitlinks": gitlinks, "product_ref_mutated": target_mutated,
            "candidate_commit_created": False}


def verify_candidate(args: argparse.Namespace) -> dict[str, Any]:
    plan_path = args.plan.resolve(); plan = load_plan(plan_path)
    root = candidate_guard(plan, args.candidate, args.output)
    payload = verification_payload(plan, root, "evacuation-verify", sha256(plan_path))
    if not payload["passed"]:
        raise EvacuationError("candidate differs from the exact evacuation plan")
    return payload


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__); sub = parser.add_subparsers(dest="command", required=True)
    plan = sub.add_parser("evacuation-plan"); plan.add_argument("--inventory", type=Path, required=True)
    plan.add_argument("--policy", type=Path, required=True); plan.add_argument("--project", type=Path, required=True)
    plan.add_argument("--output", type=Path, required=True)
    apply = sub.add_parser("evacuation-apply"); apply.add_argument("--plan", type=Path, required=True)
    apply.add_argument("--candidate", type=Path, required=True); apply.add_argument("--output", type=Path, required=True)
    apply.add_argument("--allow-disposable-mutation", action="store_true")
    verify = sub.add_parser("evacuation-verify"); verify.add_argument("--plan", type=Path, required=True)
    verify.add_argument("--candidate", type=Path, required=True); verify.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    payload = evacuation_plan(args) if args.command == "evacuation-plan" else apply_candidate(args) if args.command == "evacuation-apply" else verify_candidate(args)
    atomic_json(args.output, payload)
    print(json.dumps({"outcome": payload["outcome"], "output": str(args.output.resolve())}, sort_keys=True))


if __name__ == "__main__":
    try: main()
    except (EvacuationError, OSError, KeyError, TypeError, subprocess.TimeoutExpired) as exc:
        print(f"metadata-evacuation: {exc}", file=sys.stderr); raise SystemExit(2)
