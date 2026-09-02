#!/usr/bin/env python3
"""Python boundary for the canonical immutable fixture-base v1 contract."""
from __future__ import annotations

import hashlib
import json
import os
import platform
import shutil
import stat
import tempfile
import time
from pathlib import Path
from typing import Callable, Mapping, Optional

SCHEMA = "juno.test.fixture.base.v1"
CONTRACT = "task-workspace.v1"
ROOT_ENV = "YYLO_TEST_FIXTURE_BASE_ROOT"
DISABLE_ENV = "YYLO_TEST_DISABLE_FIXTURE_BASE_CACHE"
BOUND_INPUTS = (
    "fixture_schema", "builder_source_sha256", "task_workspace_sha256",
    "decision_core_sha256", "fixture_helper_sha256", "admission_sha256",
    "product_tree", "controller_tree", "fixture_manifest_sha256", "modes_sha256",
    "policy_sha256", "sparse_checkout_sha256", "git_identity", "platform_class",
    "dependency_lock_sha256", "managed_contract_sha256",
)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def seed_key(inputs: Mapping[str, str]) -> str:
    missing = sorted(set(BOUND_INPUTS) - set(inputs))
    unknown = sorted(set(inputs) - set(BOUND_INPUTS))
    if missing or unknown or any(not isinstance(inputs[name], str) or not inputs[name] for name in BOUND_INPUTS):
        raise ValueError(f"fixture identity incomplete missing={missing} unknown={unknown}")
    payload = {"schema": SCHEMA, "contract": CONTRACT,
               "inputs": {name: inputs[name] for name in BOUND_INPUTS}}
    return sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode())


def content_manifest(root: Path) -> list[dict]:
    rows = []
    for path in sorted(root.rglob("*"), key=lambda item: item.as_posix()):
        relative = path.relative_to(root).as_posix()
        entry = path.lstat()
        if path.is_symlink():
            rows.append({"path": relative, "kind": "symlink", "target": os.readlink(path)})
        elif path.is_dir():
            rows.append({"path": relative, "kind": "directory", "mode": stat.S_IMODE(entry.st_mode)})
        elif path.is_file():
            rows.append({"path": relative, "kind": "file", "mode": stat.S_IMODE(entry.st_mode),
                         "sha256": sha256(path.read_bytes())})
    return rows


def manifest_digest(root: Path) -> str:
    return sha256(json.dumps(content_manifest(root), sort_keys=True, separators=(",", ":")).encode())


def make_owner_writable(root: Path) -> None:
    if root.is_symlink() or not root.is_dir():
        raise RuntimeError(f"refusing non-directory fixture root: {root}")
    for path in sorted(root.rglob("*"), reverse=True):
        if not path.is_symlink():
            path.chmod(path.stat().st_mode | stat.S_IWUSR)
    root.chmod(root.stat().st_mode | stat.S_IWUSR)


def seal(root: Path) -> None:
    for path in sorted(root.rglob("*"), reverse=True):
        if not path.is_symlink():
            path.chmod(path.stat().st_mode & ~0o222)
    root.chmod(root.stat().st_mode & ~0o222)


class Seed:
    def __init__(self, root: Path, key: str, hit: bool, invalidation: Optional[str] = None):
        self.root, self.key, self.hit, self.invalidation = root, key, hit, invalidation


def _remove_owned_tree(root: Path) -> None:
    repairs = 0
    while root.exists():
        try:
            shutil.rmtree(root)
            return
        except PermissionError as error:
            candidate = Path(error.filename or "")
            if (repairs >= 32 or not candidate.exists() or candidate.is_symlink()
                    or os.path.commonpath((str(root), str(candidate.resolve()))) != str(root)):
                raise
            mode = candidate.stat().st_mode | stat.S_IWUSR
            if candidate.is_dir():
                mode |= stat.S_IXUSR
            candidate.chmod(mode)
            repairs += 1


class Instance:
    def __init__(self, root: Path, owned_parent: Path, identity: tuple[int, int]):
        self.root, self._parent, self._identity = root, owned_parent, identity

    def release(self) -> None:
        try: entry = self.root.lstat()
        except FileNotFoundError: return
        parent = self._parent.resolve()
        if (self.root.is_symlink() or not self.root.is_dir()
                or (entry.st_dev, entry.st_ino) != self._identity
                or self.root.resolve().parent != parent):
            raise RuntimeError(f"refusing to delete foreign or aliased fixture root: {self.root}")
        # Instances are writable when cloned. Avoid a second full-tree walk on
        # every test; repair only a genuine permission obstruction introduced
        # by a test while retaining shutil's symlink-safe traversal.
        _remove_owned_tree(self.root)


def default_root() -> Path:
    return Path(os.environ.get(ROOT_ENV, Path(tempfile.gettempdir()).resolve() / "yylo-fixture-bases"))


def ensure_seed(inputs: Mapping[str, str], builder: Callable[[Path], None], *, cache_root: Optional[Path] = None) -> Seed:
    key = seed_key(inputs)
    bases = (cache_root or default_root()).resolve()
    bases.mkdir(parents=True, exist_ok=True)
    target = bases / key

    def verify() -> None:
        value = json.loads((target / "yylo-fixture-base.json").read_text())
        if value.get("schema_version") != SCHEMA or value.get("contract") != CONTRACT or value.get("key") != key:
            raise RuntimeError("identity")
        if value.get("content_sha256") != manifest_digest(target / "topology"):
            raise RuntimeError("corrupt")

    try:
        verify(); return Seed(target, key, True)
    except Exception as exc:
        invalidation = type(exc).__name__ if target.exists() else None
    claim = bases / f".{key}.claim"
    descriptor = None
    deadline = time.monotonic() + 60
    while descriptor is None:
        try: descriptor = os.open(claim, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            if time.monotonic() >= deadline: raise RuntimeError("fixture seed claim timeout")
            time.sleep(0.02)
            try:
                verify(); return Seed(target, key, True)
            except Exception: pass
    os.close(descriptor)
    staging = Path(tempfile.mkdtemp(prefix=f".{key}.staging-", dir=bases))
    try:
        try:
            verify(); return Seed(target, key, True)
        except Exception: pass
        topology = staging / "topology"; topology.mkdir()
        builder(topology)
        # Modes are part of the content contract, so compute the digest only
        # after the topology has reached its published read-only state.
        seal(topology)
        value = {"schema_version": SCHEMA, "contract": CONTRACT, "key": key,
                 "immutable": True, "inputs": dict(inputs),
                 "content_sha256": manifest_digest(topology)}
        (staging / "yylo-fixture-base.json").write_text(json.dumps(value, sort_keys=True) + "\n")
        seal(staging)
        if target.exists():
            quarantine = bases / f"{key}.corrupt-{time.time_ns()}"
            make_owner_writable(target); target.rename(quarantine); seal(quarantine)
        staging.rename(target)
        verify()
        return Seed(target, key, False, invalidation)
    finally:
        claim.unlink(missing_ok=True)
        if staging.exists():
            make_owner_writable(staging); shutil.rmtree(staging)


def find_seed(bound_inputs: Mapping[str, str], *, cache_root: Optional[Path] = None) -> Optional[Seed]:
    """Find an exact verified published seed matching immutable static inputs."""
    bases = (cache_root or default_root()).resolve()
    if not bases.is_dir(): return None
    for candidate in sorted(bases.iterdir(), key=lambda path: path.name, reverse=True):
        try:
            value = json.loads((candidate / "yylo-fixture-base.json").read_text())
            inputs = value.get("inputs")
            if (value.get("schema_version") != SCHEMA or value.get("contract") != CONTRACT
                    or not isinstance(inputs, dict)
                    or any(inputs.get(name) != expected for name, expected in bound_inputs.items())
                    or value.get("content_sha256") != manifest_digest(candidate / "topology")):
                continue
            return Seed(candidate, str(value["key"]), True)
        except (OSError, ValueError, TypeError, KeyError):
            continue
    return None


def create_instance(seed: Seed, *, parent: Optional[Path] = None) -> Instance:
    owned_parent = (parent or Path(tempfile.gettempdir()).resolve() / "yylo-fixture-overlays").resolve()
    owned_parent.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix="task-workspace-", dir=owned_parent)).resolve()
    shutil.copytree(seed.root / "topology", root, dirs_exist_ok=True, symlinks=True)
    make_owner_writable(root)
    entry = root.lstat()
    return Instance(root, owned_parent, (entry.st_dev, entry.st_ino))
