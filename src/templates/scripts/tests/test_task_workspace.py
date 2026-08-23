#!/usr/bin/env python3
"""Real-Git contract tests for the small Bolt task-worktree interface."""
from __future__ import annotations

import base64
import contextlib
import fcntl
import hashlib
import io
import json
import os
import subprocess
import shutil
import sys
import stat
import tempfile
import time
import unittest
import uuid
from unittest import mock
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Optional

SCRIPT = Path(__file__).resolve().parents[1] / "task_workspace.py"

# Minimal workflow runner used by hydration-gate fixtures: lint passes and the
# run stage writes a passing manifest to the requested --out-dir.
FIXTURE_HYDRATION_RUNNER = """#!/usr/bin/env python3
import json, pathlib, sys
if len(sys.argv) > 1 and sys.argv[1] == 'lint':
    print('Workflow lint / OK: no issues found')
    raise SystemExit(0)
out = pathlib.Path(sys.argv[sys.argv.index('--out-dir') + 1])
out.mkdir(parents=True, exist_ok=True)
(out / 'manifest.json').write_text(json.dumps({'outcome': 'passed'}) + chr(10))
"""

# Installing variant: also materializes an exact-lock dependency tree
# (node_modules/left-pad, npm sentinel, and the .yylo-package-lock.sha256 lock
# stamp) so the managed hydration gate's dependency-tree verification can be
# exercised end to end, including healing reruns.
FIXTURE_INSTALLING_HYDRATION_RUNNER = """#!/usr/bin/env python3
import hashlib, json, pathlib, sys
root = pathlib.Path(sys.argv[sys.argv.index('--project-root') + 1])
package = root / 'src'
if len(sys.argv) > 1 and sys.argv[1] == 'lint':
    print('Workflow lint / OK: no issues found')
    raise SystemExit(0)
out = pathlib.Path(sys.argv[sys.argv.index('--out-dir') + 1])
out.mkdir(parents=True, exist_ok=True)
node_modules = package / 'node_modules'
dep = node_modules / 'left-pad'
dep.mkdir(parents=True, exist_ok=True)
(dep / 'package.json').write_text(json.dumps(
    {'name': 'left-pad', 'version': '1.3.0'}) + chr(10))
(node_modules / '.package-lock.json').write_text(json.dumps(
    {'name': 'fixture', 'version': '1.0.0', 'lockfileVersion': 3,
     'packages': {'node_modules/left-pad': {'version': '1.3.0',
                                            'resolved': 'left-pad',
                                            'integrity': 'sha512-fixture'}}}) + chr(10))
lock = (package / 'package-lock.json').read_bytes()
(node_modules / '.yylo-package-lock.sha256').write_text(
    hashlib.sha256(lock).hexdigest() + chr(10))
(out / 'manifest.json').write_text(json.dumps(
    {'outcome': 'passed', 'status': 'success', 'failed_steps': []}) + chr(10))
"""
sys.path.insert(0, str(SCRIPT.parent))
import task_workspace as task_runtime  # noqa: E402
import target_runtime_provenance as provenance_runtime  # noqa: E402
try:
    _fixture = task_runtime.load_package_bound_test_fixture(__file__, "real_git_fixture.py")
except task_runtime.TaskWorkspaceError as exc:
    print(f"task workspace test setup: {exc}", file=sys.stderr)
    raise SystemExit(2)
assert_juno_admission_fixture = _fixture.assert_juno_admission_fixture
install_juno_admission_fixture = _fixture.install_juno_admission_fixture
PACKAGE_ROOT = Path(_fixture.__file__).resolve().parents[4]
PUBLIC_YY = PACKAGE_ROOT / "dist/bin/yylo.sh"


DEFAULT_RESOURCE_LOCK_PATH = Path(tempfile.gettempdir()).resolve() / "yylo-real-git-managed-install.lock"
_RESOURCE_LOCK_TOKEN: Optional[str] = None
_RESOURCE_LOCK_WORKLOAD = f"Python real-Git task workspace suite: {Path(__file__).resolve()}"


def _configured_lock_path(value: Optional[str] = None) -> Path:
    candidate = (value if value is not None else os.environ.get("JUNO_TEST_RESOURCE_LOCK_PATH", "")).strip()
    if not candidate:
        return DEFAULT_RESOURCE_LOCK_PATH
    # Shared lexical contract: one absolute spelling, no trailing/doubled
    # separators and no dot segments. Do not let a path library normalize first.
    drive, tail = os.path.splitdrive(candidate)
    root = os.sep if tail.startswith(os.sep) else ""
    components = tail[len(root):].split(os.sep)
    if (not os.path.isabs(candidate) or candidate != drive + root + os.sep.join(components)
            or any(part in ("", ".", "..") for part in components)):
        raise RuntimeError(
            f"[test-resource-lock] lock path must be one normalized absolute path: {candidate!r}"
        )
    return Path(candidate)


RESOURCE_LOCK_PATH = _configured_lock_path()


def _assert_safe_path(pathname: Path, *, final_may_be_missing: bool = True) -> None:
    parts = pathname.parts
    cursor = Path(parts[0])
    for index, part in enumerate(parts[1:], 1):
        cursor /= part
        try:
            stat = cursor.lstat()
        except FileNotFoundError:
            if index != len(parts) - 1 or not final_may_be_missing:
                raise RuntimeError(f"[test-resource-lock] path parent must already exist: {cursor}")
            continue
        if cursor.is_symlink():
            raise RuntimeError(f"[test-resource-lock] symlinked lock path component is forbidden: {cursor}")
        if index < len(parts) - 1 and not cursor.is_dir():
            raise RuntimeError(f"[test-resource-lock] lock path parent is not a directory: {cursor}")
        if index == len(parts) - 1 and not cursor.is_file():
            raise RuntimeError(f"[test-resource-lock] lock protocol path must be a file: {cursor}")


def _process_birth_identity(pid: object) -> Optional[str]:
    """Return a sub-second kernel process identity, or None (never a rounded timestamp)."""
    if not isinstance(pid, int) or pid <= 0:
        return None
    if sys.platform.startswith("linux"):
        try:
            # /proc stat field 22 is the kernel start tick. Parse after the final
            # ')' because comm may contain spaces and parentheses.
            fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
            return f"linux-start-ticks:{fields[19]}"
        except (OSError, IndexError):
            return None
    if sys.platform == "darwin":
        try:
            import ctypes
            class ProcBSDInfo(ctypes.Structure):
                _fields_ = [
                    ("flags", ctypes.c_uint32), ("status", ctypes.c_uint32),
                    ("xstatus", ctypes.c_uint32), ("pid", ctypes.c_uint32),
                    ("ppid", ctypes.c_uint32), ("uid", ctypes.c_uint32),
                    ("gid", ctypes.c_uint32), ("ruid", ctypes.c_uint32),
                    ("rgid", ctypes.c_uint32), ("svuid", ctypes.c_uint32),
                    ("svgid", ctypes.c_uint32), ("rfu_1", ctypes.c_uint32),
                    ("comm", ctypes.c_char * 16), ("name", ctypes.c_char * 32),
                    ("nfiles", ctypes.c_uint32), ("pgid", ctypes.c_uint32),
                    ("pjobc", ctypes.c_uint32), ("e_tdev", ctypes.c_uint32),
                    ("e_tpgid", ctypes.c_uint32), ("nice", ctypes.c_int32),
                    ("start_tvsec", ctypes.c_uint64), ("start_tvusec", ctypes.c_uint64),
                ]
            library = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
            info = ProcBSDInfo()
            size = library.proc_pidinfo(pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info))
            if size != ctypes.sizeof(info):
                return None
            return f"darwin-start-time:{info.start_tvsec}:{info.start_tvusec}"
        except (OSError, AttributeError, ValueError):
            return None
    return None


def _pid_provably_absent(pid: object) -> bool:
    try:
        os.kill(pid, 0)
        return False
    except ProcessLookupError:
        return True
    except (PermissionError, OSError, TypeError):
        return False


def _read_lock_owner(lock_path: Path = RESOURCE_LOCK_PATH) -> Optional[dict]:
    try:
        stat = lock_path.lstat()
        if lock_path.is_symlink() or not lock_path.is_file():
            return None
        value = json.loads(lock_path.read_text())
        if not isinstance(value, dict) or not isinstance(value.get("token"), str):
            return None
        value["_inode"] = [stat.st_dev, stat.st_ino]
        return value
    except (OSError, ValueError):
        return None


def _owner_is_live(owner: dict) -> bool:
    observed = _process_birth_identity(owner.get("pid"))
    if observed is not None:
        return observed == owner.get("processBirthId")
    # Precise identity unavailable: only a provably absent PID is stale.
    return not _pid_provably_absent(owner.get("pid"))


def _owner_diagnostics(owner: Optional[dict]) -> str:
    if not owner:
        return "owner=<invalid-or-unavailable>"
    return (
        f"owner_pid={owner.get('pid')} owner_birth={owner.get('processBirthId')!r} "
        f"owner_inode={owner.get('_inode')!r} owner_workload={owner.get('workload')!r} "
        f"owner_process={owner.get('process')!r} owner_cwd={owner.get('cwd')!r} "
        f"owner_started_at={owner.get('startedAt')}"
    )


def _load_diagnostics() -> str:
    try:
        load = ",".join(f"{value:.2f}" for value in os.getloadavg())
    except (AttributeError, OSError):
        load = "unavailable"
    return f"waiter_pid={os.getpid()} loadavg={load} cpus={os.cpu_count()}"


def _protocol_guard_path(lock_path: Path) -> Path:
    return lock_path.with_name(f".{lock_path.name}.protocol")


@contextlib.contextmanager
def _protocol_guard(lock_path: Path, opened_hook=None):
    import fcntl
    _assert_safe_path(lock_path)
    guard = _protocol_guard_path(lock_path)
    flags = os.O_RDWR | os.O_CREAT
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW

    descriptor: Optional[int] = None
    while descriptor is None:
        _assert_safe_path(guard)
        candidate = os.open(guard, flags, 0o600)
        try:
            opened = os.fstat(candidate)
            named = guard.lstat()
            if (not stat.S_ISREG(opened.st_mode) or not stat.S_ISREG(named.st_mode)
                    or (opened.st_dev, opened.st_ino) != (named.st_dev, named.st_ino)):
                raise RuntimeError("[test-resource-lock] protocol guard identity changed before lock")
            if opened_hook is not None:
                opened_hook()
            fcntl.flock(candidate, fcntl.LOCK_EX)
            # A waiter may have opened the old inode before another process
            # atomically replaced the pathname. Revalidate immediately after
            # LOCK_EX and enter the CAS domain only when the locked descriptor
            # is still the exact regular, non-symlink pathname target.
            try:
                locked = os.fstat(candidate)
                current = guard.lstat()
            except FileNotFoundError:
                current = None
            if (current is None or not stat.S_ISREG(locked.st_mode)
                    or not stat.S_ISREG(current.st_mode)
                    or (locked.st_dev, locked.st_ino) != (current.st_dev, current.st_ino)):
                fcntl.flock(candidate, fcntl.LOCK_UN)
                os.close(candidate)
                continue
            descriptor = candidate
        except Exception:
            if descriptor is None:
                try: os.close(candidate)
                except OSError: pass
            raise
    try:
        yield
    finally:
        fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)


def _protocol_guard_probe(lock_path: Path, opened: Path, entered: Path, release: Path) -> None:
    def announce_opened() -> None:
        opened.write_text("opened\n")
    with _protocol_guard(lock_path, announce_opened):
        entered.write_text("entered\n")
        deadline = time.monotonic() + 10
        while not release.exists():
            if time.monotonic() >= deadline:
                raise RuntimeError("[test-resource-lock] guard probe release timed out")
            time.sleep(0.01)


def _publish_owner_under_guard(lock_path: Path, owner: dict) -> None:
    temporary = lock_path.parent / f".{lock_path.name}.owner-{os.getpid()}-{owner['token']}"
    descriptor: Optional[int] = None
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        payload = (json.dumps(owner, indent=2) + "\n").encode()
        with os.fdopen(descriptor, "wb", closefd=True) as handle:
            descriptor = None
            handle.write(payload); handle.flush(); os.fsync(handle.fileno())
        os.replace(temporary, lock_path)
    finally:
        if descriptor is not None:
            os.close(descriptor)
        try: temporary.unlink()
        except FileNotFoundError: pass


def _protocol_operation(lock_path: Path, action: str, payload: dict) -> dict:
    """One CAS domain shared by Python and Node via an advisory kernel lock."""
    target = _configured_lock_path(str(lock_path))
    with _protocol_guard(target):
        current = _read_lock_owner(target)
        if action == "acquire":
            if not payload.get("processBirthId"):
                payload["processBirthId"] = _process_birth_identity(payload.get("pid"))
            if not payload.get("processBirthId"):
                raise RuntimeError("[test-resource-lock] precise process birth identity unavailable; refusing unsafe acquisition")
            if current is None and target.exists():
                return {"outcome": "blocked", "owner": None}
            recovered = None
            if current and not _owner_is_live(current):
                # Exact token+inode proof is made while the protocol mutex blocks
                # every compliant publisher/recoverer. Re-read immediately before
                # unlink; no successor can publish inside this CAS section.
                confirmed = _read_lock_owner(target)
                if (confirmed and confirmed.get("token") == current.get("token")
                        and confirmed.get("_inode") == current.get("_inode")):
                    target.unlink()
                    recovered = current
                    current = None
            if current is None:
                _publish_owner_under_guard(target, payload)
                return {"outcome": "acquired", "owner": payload, "recovered": recovered}
            return {"outcome": "blocked", "owner": current}
        if action == "release":
            if not current:
                return {"outcome": "absent"}
            expected_inode = payload.get("inode")
            if (current.get("token") == payload.get("token")
                    and (expected_inode is None or current.get("_inode") == expected_inode)):
                target.unlink()
                return {"outcome": "released"}
            return {"outcome": "not-owner", "owner": current}
        if action == "inspect":
            return {"outcome": "present" if current else "absent", "owner": current}
        raise RuntimeError(f"unknown resource-lock operation: {action}")


def _acquire_resource_lock(
    workload: str, lock_path: Optional[Path] = None, timeout_seconds: float = 300,
    poll_seconds: float = 0.05,
) -> tuple[str, int]:
    target = _configured_lock_path(str(lock_path) if lock_path is not None else None)
    token = uuid.uuid4().hex
    birth = _process_birth_identity(os.getpid())
    if not birth:
        raise RuntimeError("[test-resource-lock] precise process birth identity unavailable; refusing unsafe acquisition")
    owner = {
        "pid": os.getpid(), "processBirthId": birth, "token": token, "workload": workload,
        "process": " ".join(sys.argv), "cwd": os.getcwd(),
        "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    started = time.monotonic(); next_diagnostic = 1.0
    while True:
        result = _protocol_operation(target, "acquire", owner)
        if result["outcome"] == "acquired":
            waited_ms = int((time.monotonic() - started) * 1000)
            recovered = result.get("recovered")
            if recovered:
                print(f"[test-resource-lock] recovered stale lock={target} {_owner_diagnostics(recovered)} {_load_diagnostics()}", file=sys.stderr)
            if waited_ms > 0:
                print(f"[test-resource-lock] acquired workload={workload!r} waited_ms={waited_ms} lock={target} {_load_diagnostics()}", file=sys.stderr)
            return token, waited_ms
        current = result.get("owner")
        waited = time.monotonic() - started
        if waited >= timeout_seconds:
            raise RuntimeError(f"[test-resource-lock] acquisition timed out workload={workload!r} waited_ms={int(waited*1000)} lock={target} {_owner_diagnostics(current)} {_load_diagnostics()}")
        if waited >= next_diagnostic:
            print(f"[test-resource-lock] waiting workload={workload!r} waited_ms={int(waited*1000)} lock={target} {_owner_diagnostics(current)} {_load_diagnostics()}", file=sys.stderr)
            next_diagnostic += 5
        time.sleep(poll_seconds)


def _release_resource_lock(lock_path: Path, token: str, inode: Optional[list[int]] = None) -> bool:
    return _protocol_operation(lock_path, "release", {"token": token, "inode": inode})["outcome"] in ("released", "absent")


def setUpModule() -> None:
    global _RESOURCE_LOCK_TOKEN
    _RESOURCE_LOCK_TOKEN, _ = _acquire_resource_lock(_RESOURCE_LOCK_WORKLOAD, RESOURCE_LOCK_PATH)


def tearDownModule() -> None:
    global _RESOURCE_LOCK_TOKEN
    if _RESOURCE_LOCK_TOKEN:
        _release_resource_lock(RESOURCE_LOCK_PATH, _RESOURCE_LOCK_TOKEN)
        _RESOURCE_LOCK_TOKEN = None


RUNTIME_TEMPLATE_PARITY = (
    (".juno_task/scripts/workflow_runner.sh", "juno-code/src/templates/scripts/workflow_runner.sh"),
    (".juno_task/scripts/risk_policy.py", "juno-code/src/templates/scripts/risk_policy.py"),
    (".juno_task/scripts/controller_registration.py", "juno-code/src/templates/scripts/controller_registration.py"),
    (".juno_task/scripts/metadata_controller.py", "juno-code/src/templates/scripts/metadata_controller.py"),
    (".juno_task/scripts/tests/test_controller_registration.py", "juno-code/src/templates/scripts/tests/test_controller_registration.py"),
    (".juno_task/scripts/tests/test_metadata_controller.py", "juno-code/src/templates/scripts/tests/test_metadata_controller.py"),
)


def run(argv: list[str], cwd: Path, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(argv, cwd=cwd, text=True, capture_output=True)
    if check and result.returncode:
        raise AssertionError(result.stderr or result.stdout)
    return result


def git(root: Path, *args: str) -> str:
    return run(["git", "-C", str(root), *args], root).stdout.strip()


class SemVerValidationTests(unittest.TestCase):
    def test_accepts_stable_prerelease_build_and_combined_versions(self) -> None:
        accepted = {
            "stable": ("0.0.0", "2.1.3", "10.20.30"),
            "prerelease": ("2.1.3-rc", "2.1.3-rc.0.6", "1.0.0-01a"),
            "build": ("2.1.3+build", "2.1.3+001", "1.0.0+linux.x86-64"),
            "prerelease_and_build": ("2.1.3-rc.0.6+build.001",),
        }
        for version_class, versions in accepted.items():
            for version in versions:
                with self.subTest(version_class=version_class, version=version):
                    self.assertTrue(task_runtime.is_valid_semver(version))

    def test_rejects_malformed_versions(self) -> None:
        rejected = {
            "leading_zero": ("01.2.3", "1.02.3", "1.2.03", "1.2.3-01", "1.2.3-alpha.01"),
            "empty_identifier": ("1.2.3-", "1.2.3+", "1.2.3-alpha..1", "1.2.3+build..1"),
            "invalid_character": ("v1.2.3", "1.2.3_rc", "1.2.3+build_1", "١.٢.٣"),
            "malformed_core": ("", "1", "1.2", "1.2.3.4", "1.2.3+one+two"),
        }
        for failure_class, versions in rejected.items():
            for version in versions:
                with self.subTest(failure_class=failure_class, version=version):
                    self.assertFalse(task_runtime.is_valid_semver(version))

    def test_validation_is_exact_string_only_without_trimming_or_coercion(self) -> None:
        self.assertTrue(task_runtime.is_valid_semver("1.2.3-RC+Build.001"))
        for value in (" 1.2.3", "1.2.3 ", None, 10203, {}, [], b"1.2.3"):
            with self.subTest(value=value):
                self.assertFalse(task_runtime.is_valid_semver(value))

    def test_precedence_follows_semver_without_build_metadata_authority(self) -> None:
        ordered = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta",
                   "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11",
                   "1.0.0-rc.1", "1.0.0", "2.0.0"]
        for older, newer in zip(ordered, ordered[1:]):
            self.assertTrue(task_runtime.semver_precedes(older, newer))
            self.assertFalse(task_runtime.semver_precedes(newer, older))
        self.assertFalse(task_runtime.semver_precedes("1.0.0+one", "1.0.0+two"))


class ValidationProfilesRoundTripTests(unittest.TestCase):
    """Normalization must stay idempotent: load -> dump -> load must not fail.

    A config that authors no validation_profiles must not gain an explicit
    empty list whose own re-validation the strict schema rejects.
    """

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.controller = Path(self.temporary.name).resolve() / "controller"
        (self.controller / ".juno_task/config").mkdir(parents=True)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def write_config(self, value: object) -> None:
        (self.controller / ".juno_task/config/task-workspace.json").write_text(
            json.dumps(value) + "\n")

    def base_config(self) -> dict[str, object]:
        return {
            "schema_version": "juno_task_workspace_config.v1",
            "repository": ".",
            "target_ref": "refs/heads/product",
            "workspace_root": str(self.controller / "workspaces"),
            "branch_prefix": "refs/heads/task-",
            "allowed_paths": ["src"],
            "controller_private_paths": [".juno_task/state"],
            "focused_validation": [{"id": "focused", "cwd": "src",
                                    "timeout_seconds": 5, "max_output_bytes": 1024,
                                    "argv": [sys.executable, "-c", "pass"]}],
            "full_suite_validation": {"id": "full-suite", "cwd": "src",
                                       "timeout_seconds": 10, "max_output_bytes": 4096,
                                       "argv": [sys.executable, "-c", "pass"]},
        }

    def test_absent_profiles_stay_absent_across_renormalization(self) -> None:
        self.write_config(self.base_config())
        first = task_runtime.load_config(self.controller)
        self.assertNotIn("validation_profiles", first)
        self.write_config(first)
        second = task_runtime.load_config(self.controller)
        self.assertNotIn("validation_profiles", second)
        self.assertEqual(first, second)

    def test_authored_profiles_survive_renormalization(self) -> None:
        config = self.base_config()
        config["validation_profiles"] = [{
            "id": "package-local", "path_roots": ["src"],
            "commands": [{"id": "package-suite", "cwd": "src",
                          "timeout_seconds": 60, "max_output_bytes": 2048,
                          "argv": [sys.executable, "-c", "pass"]}],
        }]
        self.write_config(config)
        first = task_runtime.load_config(self.controller)
        self.assertEqual(
            [profile["id"] for profile in first["validation_profiles"]],
            ["package-local"])
        self.write_config(first)
        self.assertEqual(task_runtime.load_config(self.controller), first)

    def test_authored_empty_profiles_are_still_rejected(self) -> None:
        config = self.base_config()
        config["validation_profiles"] = []
        self.write_config(config)
        with self.assertRaises(task_runtime.TaskWorkspaceError):
            task_runtime.load_config(self.controller)


class TaskWorkspaceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        # Use the physical temp root so exact-path tests are not aliases through
        # macOS's ordinary /var -> /private/var compatibility symlink.
        self.root = Path(self.temporary.name).resolve()
        self.repository = self.root / "repo"
        self.controller = self.root / "controller"
        self.workspaces = self.root / "workspaces"
        self.repository.mkdir()
        git(self.repository, "init", "-b", "product")
        git(self.repository, "config", "user.email", "test@example.com")
        git(self.repository, "config", "user.name", "Test")
        (self.repository / "src").mkdir()
        (self.repository / "src/base.txt").write_text("base\n")
        (self.repository / "optional").mkdir()
        (self.repository / "optional/base.txt").write_text("optional\n")
        runtime = self.repository / task_runtime.RUNTIME_PATH
        runtime.parent.mkdir(parents=True)
        runtime.write_bytes(SCRIPT.read_bytes())
        managed_source = self.repository / "juno-code/src/templates/scripts/task_workspace.py"
        managed_source.parent.mkdir(parents=True)
        managed_source.write_bytes(SCRIPT.read_bytes())
        generated_declaration = self.repository / task_runtime.GENERATED_OUTPUT_DECLARATION
        generated_declaration.parent.mkdir(parents=True)
        generated_declaration.write_text(json.dumps({
            "schema_version": task_runtime.GENERATED_OUTPUT_SCHEMA,
            "source": "juno-code/unadmitted-canonical.txt",
            "destinations": [".agents/unadmitted-output.txt"],
        }) + "\n")
        managed_declaration = self.repository / task_runtime.MANAGED_OUTPUT_DECLARATION
        managed_declaration.parent.mkdir(parents=True, exist_ok=True)
        managed_declaration.write_text(json.dumps({
            "schemaVersion": 1, "admissionOutputs": [], "assets": [],
        }) + "\n")
        package = self.repository / "juno-code/package.json"
        package.write_text(json.dumps({"name": "@yylo/cli", "version": "9.0.0"}) + "\n")
        unadmitted_source = self.repository / "juno-code/unadmitted-canonical.txt"
        unadmitted_output = self.repository / ".agents/unadmitted-output.txt"
        unadmitted_source.parent.mkdir(parents=True, exist_ok=True)
        unadmitted_output.parent.mkdir(parents=True, exist_ok=True)
        unadmitted_source.write_text("unadmitted base\n")
        unadmitted_output.write_text("unadmitted base\n")
        git(self.repository, "add", ".")
        git(self.repository, "commit", "-m", "product base")
        self.base = git(self.repository, "rev-parse", "HEAD")
        git(self.repository, "branch", "controller")
        run(["git", "-C", str(self.repository), "worktree", "add", str(self.controller), "controller"], self.repository)
        # The controller branch is metadata-only and unrelated product paths are removed.
        git(self.controller, "rm", "-r", "src", "optional")
        self.write_policy()
        for task_id in ("X", "Y", "Z"):
            task = self.controller / ".juno_task/tasks" / task_id[:2].lower() / f"{task_id}.md"
            task.parent.mkdir(parents=True, exist_ok=True)
            task.write_text(f"---\nid: {task_id}\nstatus: todo\n---\n")
        # Convert the linked branch into the registered migrated sparse
        # metadata-controller class required by target-runtime recovery.
        git(self.controller, "rm", "-r", "--ignore-unmatch", "juno-code", ".agents",
            ".juno_task/scripts")
        metadata_template = SCRIPT.parents[1] / "config/metadata-controller.json"
        metadata = json.loads(metadata_template.read_text())
        metadata["controller_branch"] = "refs/heads/controller"
        metadata["product_ref"] = "refs/heads/product"
        (self.controller / ".juno_task/config/metadata-controller.json").write_text(
            json.dumps(metadata, indent=2) + "\n")
        (self.controller / ".juno_task/config.json").write_text(json.dumps({
            "controllerWorkspace": {"mode": "metadata-only",
                                    "policy": ".juno_task/config/metadata-controller.json"},
        }) + "\n")
        config_templates = SCRIPT.parents[1] / "config"
        for name in ("integration-workspace.json", "risk-policy.json"):
            (self.controller / ".juno_task/config" / name).write_bytes(
                (config_templates / name).read_bytes())
        (self.controller / ".gitignore").write_text(
            "/.juno_task/runtime/\n/.juno_task/scripts/\n/AGENTS.md\n/CLAUDE.md\n"
            "/.agents/\n/.claude/\n/.pi/\n")
        git(self.controller, "add", ".")
        git(self.controller, "commit", "-m", "registered migrated sparse metadata controller")
        git(self.repository, "config", "extensions.worktreeConfig", "true")
        git(self.controller, "config", "--worktree", "juno.workspace.role", "controller")
        git(self.controller, "config", "--local", "juno.controller.path", str(self.controller))
        git(self.controller, "config", "--local", "juno.controller.branch", "controller")
        git(self.controller, "config", "--worktree", "core.sparseCheckout", "true")
        git(self.controller, "config", "--worktree", "core.sparseCheckoutCone", "false")
        sparse_file = Path(git(self.controller, "rev-parse", "--path-format=absolute",
                               "--git-path", "info/sparse-checkout"))
        sparse_file.parent.mkdir(parents=True, exist_ok=True)
        sparse_file.write_text("/.gitignore\n/.juno_task/\n")
        git(self.controller, "read-tree", "-mu", "HEAD")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def write_policy(self, *, validation_ok: bool = True, validation_code: Optional[str] = None,
                     timeout_seconds: int = 5, max_output_bytes: int = 1024,
                     extra_args: Optional[list[str]] = None) -> None:
        config = self.controller / ".juno_task/config/task-workspace.json"
        config.parent.mkdir(parents=True, exist_ok=True)
        code = validation_code or ("import sys; sys.exit(0)" if validation_ok else "import sys; sys.exit(7)")
        config.write_text(json.dumps({
            "schema_version": "juno_task_workspace_config.v1",
            "repository": ".",
            "target_ref": "refs/heads/product",
            "workspace_root": str(self.workspaces),
            "branch_prefix": "refs/heads/task-",
            "allowed_paths": ["src"],
            "selectable_paths": ["optional"],
            "controller_private_paths": [".juno_task/tasks", ".juno_task/state", ".juno_task/specs", ".juno_task/ledger"],
            "focused_validation": [{"id": "focused", "cwd": "src",
                                    "timeout_seconds": timeout_seconds, "max_output_bytes": max_output_bytes,
                                    "argv": [sys.executable, "-c", code, *(extra_args or [])]}],
            "full_suite_validation": {"id": "full-suite", "cwd": "src",
                                       "timeout_seconds": 10, "max_output_bytes": 4096,
                                       "argv": [sys.executable, "-c", "pass"]},
        }, indent=2) + "\n")
        risk_policy = self.controller / ".juno_task/config/risk-policy.json"
        if not risk_policy.exists():
            risk_policy.write_bytes(
                (SCRIPT.parent.parent / "config/risk-policy.json").read_bytes()
            )

    def install_task_run_assets(self) -> None:
        templates = Path(__file__).resolve().parents[2]
        if not (templates / "workflows/yy-task-run.yaml").is_file():
            templates = Path(__file__).resolve().parents[3] / "juno-code/src/templates"
        paths = [
            ("workflows/yy-task-run.yaml", ".juno_task/workflows/yy-task-run.yaml"),
            ("prompts/lifecycle/task-implementation.md",
             ".juno_task/prompts/lifecycle/task-implementation.md"),
            ("prompts/lifecycle/task-test-repair.md",
             ".juno_task/prompts/lifecycle/task-test-repair.md"),
        ]
        for source, destination in paths:
            target = self.controller / destination
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((templates / source).read_bytes())
        git(self.controller, "add", *[destination for _, destination in paths])

    def command(self, operation: str, task_id: str, check: bool = True,
                extra: Optional[list[str]] = None) -> subprocess.CompletedProcess[str]:
        return run(["python3", str(SCRIPT), operation, "--task", task_id,
                    "--controller", str(self.controller), *(extra or [])], self.controller, check)

    def payload(self, operation: str, task_id: str) -> dict:
        return json.loads(self.command(operation, task_id).stdout)

    def commit_task(self, task_id: str, relative: str = "src/feature.txt") -> str:
        worktree = self.workspaces / task_id
        target = worktree / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(f"{task_id}\n")
        git(worktree, "add", relative)
        git(worktree, "commit", "-m", f"feature {task_id}")
        return git(worktree, "rev-parse", "HEAD")

    def advance_target(self) -> str:
        (self.repository / "src/target.txt").write_text("advanced\n")
        git(self.repository, "add", "src/target.txt")
        git(self.repository, "commit", "-m", "advance target")
        return git(self.repository, "rev-parse", "HEAD")

    def remove_runtime_for_consumer(self) -> None:
        git(self.repository, "rm", task_runtime.RUNTIME_PATH,
            "juno-code/src/templates/scripts/task_workspace.py", "juno-code/package.json")
        git(self.repository, "commit", "-m", "consumer target lacks Juno source and task runtime")

    def install_stale_consumer_runtime(self, version: str = "2.1.2") -> bytes:
        stale = b"#!/usr/bin/env python3\n# exact older consumer runtime\n"
        runtime = self.repository / task_runtime.RUNTIME_PATH
        runtime.write_bytes(stale)
        git(self.repository, "rm", "juno-code/src/templates/scripts/task_workspace.py",
            "juno-code/package.json")
        stale_hash = hashlib.sha256(stale).hexdigest()
        inventory = self.repository / task_runtime.MANAGED_INVENTORY_PATH
        inventory.write_text(json.dumps({
            "schemaVersion": 1, "packageName": "@yylo/cli", "packageVersion": version,
            "assets": {task_runtime.RUNTIME_PATH: {
                "type": "script", "templateVersion": version,
                "sourceSha256": stale_hash, "installedSha256": stale_hash,
            }},
        }) + "\n")
        git(self.repository, "add", task_runtime.RUNTIME_PATH,
            task_runtime.MANAGED_INVENTORY_PATH)
        git(self.repository, "commit", "-m", "exact older consumer runtime generation")
        return stale

    def install_legacy_consumer_runtime(self, version: str = "2.1.2",
                                        output_shape: str = "historical") -> dict[str, Path | bytes]:
        legacy = b"#!/usr/bin/env python3\n# exact immutable legacy consumer runtime\n"
        runtime = self.repository / task_runtime.RUNTIME_PATH
        runtime.write_bytes(legacy)
        git(self.repository, "rm", "juno-code/src/templates/scripts/task_workspace.py",
            "juno-code/package.json")
        inventory = self.repository / task_runtime.MANAGED_INVENTORY_PATH
        if inventory.exists():
            git(self.repository, "rm", task_runtime.MANAGED_INVENTORY_PATH)
        git(self.repository, "add", task_runtime.RUNTIME_PATH)
        git(self.repository, "commit", "-m", "legacy consumer runtime without managed inventory")

        package_root = self.root / "installed-runtimes" / version / "node_modules/yylo"
        executable = package_root / "dist/bin/cli.mjs"
        executable.parent.mkdir(parents=True)
        if output_shape == "historical":
            stdout = f"{version}\n"
            stderr = (
                f"\n🎯 YYLO v{version} - TypeScript CLI\n"
                "   Node.js v22.22.3 on darwin\n"
                f"   Working directory: {executable.parent.resolve()}\n\n"
            )
        elif output_shape == "release":
            stdout, stderr = f"yylo {version}\n", ""
        elif output_shape == "machine":
            stdout, stderr = f"{version}\n", ""
        else:
            raise ValueError(f"unknown legacy version output shape: {output_shape}")
        executable.write_text(
            "#!/usr/bin/env python3\nimport sys\n"
            f"sys.stdout.write({stdout!r})\nsys.stderr.write({stderr!r})\n"
        )
        executable.chmod(0o755)
        template = package_root / "dist/templates/scripts/task_workspace.py"
        template.parent.mkdir(parents=True)
        template.write_bytes(legacy)
        (package_root / "package.json").write_text(json.dumps({
            "name": "@yylo/cli", "version": version,
        }) + "\n")
        identity_path = self.controller / ".juno_task/runtime/identity.json"
        identity_path.parent.mkdir(parents=True, exist_ok=True)
        identity_path.write_text(json.dumps({
            "package": "@yylo/cli", "version": version,
            "executable": str(executable.resolve()),
            "executable_sha256": hashlib.sha256(executable.read_bytes()).hexdigest(),
            "source": "installed-release", "tracked": False,
        }) + "\n")
        git(self.controller, "config", "--worktree", "juno.controller.runtimeVersion", version)
        git(self.controller, "config", "--worktree", "juno.controller.runtimeExecutable",
            str(executable.resolve()))
        return {"legacy": legacy, "executable": executable, "template": template,
                "identity": identity_path, "package_root": package_root}

    def set_legacy_version_output(self, fixture: dict[str, Path | bytes],
                                  stdout: str, stderr: str) -> None:
        executable = Path(fixture["executable"])
        executable.write_text(
            "#!/usr/bin/env python3\nimport sys\n"
            f"sys.stdout.write({stdout!r})\nsys.stderr.write({stderr!r})\n"
        )
        executable.chmod(0o755)
        identity_path = Path(fixture["identity"])
        identity = json.loads(identity_path.read_text())
        identity["executable_sha256"] = hashlib.sha256(executable.read_bytes()).hexdigest()
        identity_path.write_text(json.dumps(identity) + "\n")

    def write_task_scope(self, task_id: str, *, owner: Optional[str] = None,
                         children: Optional[list[str]] = None, baseline: bool = False,
                         selectable: Optional[list[str]] = None,
                         required: Optional[list[str]] = None,
                         generated: Optional[list[str]] = None,
                         lifecycle_status: str = "todo") -> Path:
        _path, body = task_runtime.task_manifest(self.controller, task_id)
        target = task_runtime.task_scope_path(self.controller, task_id)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps({
            "schema_version": task_runtime.TASK_SCOPE_SCHEMA, "task_id": task_id,
            "task_revision_sha256": hashlib.sha256(body).hexdigest(),
            "lifecycle_status": lifecycle_status,
            "umbrella_relations": {"owner": owner, "children": children or []},
            "scope": {"baseline": baseline,
                      "selectable_paths": sorted(selectable or []),
                      "required_paths": sorted(required or []),
                      "generated_paths": sorted(generated or [])},
        }, sort_keys=True, indent=2) + "\n")
        return target

    def umbrella_fixture(self) -> Path:
        required = {"Y": "child/one.txt", "Z": "child/two.txt"}
        task_runtime.task_file(self.controller, "X").write_text(
            "---\nid: X\nstatus: todo\n---\nOrdered tracking children\n[task_id]Y Z[/task_id]\n"
        )
        for child_id, relative in required.items():
            target = self.repository / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(f"{child_id} base\n")
            task = task_runtime.task_file(self.controller, child_id)
            task.write_text(f"---\nid: {child_id}\nstatus: todo\n---\nExact required path: {relative}\n")
        self.write_task_scope("X", children=["Y", "Z"], baseline=True)
        self.write_task_scope("Y", owner="X", required=[required["Y"]])
        self.write_task_scope("Z", owner="X", required=[required["Z"]])
        git(self.repository, "add", "child")
        git(self.repository, "commit", "-m", "add umbrella child fixtures")
        self.base = git(self.repository, "rev-parse", "HEAD")
        declaration = self.root / "umbrella.json"
        declaration.write_text(json.dumps({
            "schema_version": task_runtime.UMBRELLA_INPUT_SCHEMA,
            "execution_mode": task_runtime.UMBRELLA_EXECUTION_MODE,
            "children": ["Y", "Z"],
        }, indent=2) + "\n")
        return declaration

    def test_umbrella_start_freezes_exact_ordered_child_union_before_git_mutation(self) -> None:
        declaration = self.umbrella_fixture()
        started = task_runtime.start(self.controller, "X", umbrella_input=declaration)
        admission = started["creation_receipt"]["umbrella_admission"]
        self.assertEqual(admission["ordered_child_ids"], ["Y", "Z"])
        self.assertEqual([row["required_paths"] for row in admission["child_bindings"]],
                         [["child/one.txt"], ["child/two.txt"]])
        self.assertEqual(admission["union_paths_sha256"],
                         task_runtime.stable_sha256(admission["union_paths"]))
        self.assertTrue(all(path in started["creation_receipt"]["allowed_paths"]
                            for path in ("child/one.txt", "child/two.txt")))
        self.assertFalse((self.workspaces / "Y").exists())
        self.assertFalse((self.workspaces / "Z").exists())
        self.assertIsNone(task_runtime.optional_ref_sha(self.repository, "refs/heads/task-Y"))
        status = task_runtime.status(self.controller, "X")
        self.assertEqual(status["umbrella_admission_status"]["authority"], "historical_creation")
        self.assertEqual(status["umbrella_admission_status"]["child_revision_drift"], [])

    def test_umbrella_admission_allows_lifecycle_and_response_progress_but_not_requirement_drift(self) -> None:
        declaration = self.umbrella_fixture()
        git(self.controller, "add", ".juno_task/tasks", ".juno_task/task-scopes")
        git(self.controller, "commit", "-m", "freeze umbrella requirements")
        task_runtime.start(self.controller, "X", umbrella_input=declaration)
        for task_id in ("X", "Y", "Z"):
            task = task_runtime.task_file(self.controller, task_id)
            task.write_text(task.read_text().replace("status: todo", "status: done")
                            + "\n<!-- juno:response:start -->\nvalidated\n<!-- juno:response:end -->\n")
        git(self.controller, "add", ".juno_task/tasks")
        git(self.controller, "commit", "-m", "record umbrella completion evidence")
        status = task_runtime.status(self.controller, "X")
        self.assertEqual(status["umbrella_admission_status"]["child_revision_drift"], [])

        child = task_runtime.task_file(self.controller, "Y")
        child.write_text(child.read_text().replace("Exact required path: child/one.txt",
                                                   "Changed authored requirement"))
        git(self.controller, "add", ".juno_task/tasks")
        git(self.controller, "commit", "-m", "drift authored requirement")
        drift = task_runtime.status(self.controller, "X")["umbrella_admission_status"]["child_revision_drift"]
        self.assertIn({"task_id": "Y", "reason": "canonical_child_unavailable"}, drift)

    def test_authoritative_scope_distinguishes_baseline_only_and_selectable_children(self) -> None:
        declaration = self.umbrella_fixture()
        self.write_task_scope("Y", owner="X", selectable=["optional"])
        self.write_task_scope("Z", owner="X", baseline=True)
        started = task_runtime.start(self.controller, "X", umbrella_input=declaration)
        bindings = {row["task_id"]: row for row in started["creation_receipt"]["umbrella_admission"]["child_bindings"]}
        self.assertEqual(bindings["Y"]["required_paths"], ["optional"])
        self.assertFalse(bindings["Y"]["canonical_scope"]["baseline"])
        self.assertEqual(bindings["Z"]["required_paths"], [])
        self.assertTrue(bindings["Z"]["canonical_scope"]["baseline"])
        self.assertIn("optional", started["creation_receipt"]["allowed_paths"])

    def test_umbrella_child_scope_includes_exact_declared_generated_output(self) -> None:
        declaration = self.umbrella_fixture()
        source = "juno-code/src/templates/scripts/child.py"
        destination = ".juno_task/scripts/child.py"
        for relative in (source, destination):
            target = self.repository / relative; target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("paired\n")
        manifest = self.repository / task_runtime.MANAGED_OUTPUT_DECLARATION
        value = json.loads(manifest.read_text())
        value["admissionOutputs"].append({"source": "scripts/child.py", "destination": destination})
        manifest.write_text(json.dumps(value) + "\n")
        task_runtime.task_file(self.controller, "Y").write_text(
            f"---\nid: Y\nstatus: todo\n---\nChange generated output {destination}\n"
        )
        self.write_task_scope("Y", owner="X", generated=[destination])
        git(self.repository, "add", source, destination, task_runtime.MANAGED_OUTPUT_DECLARATION)
        git(self.repository, "commit", "-m", "child generated binding")
        self.base = git(self.repository, "rev-parse", "HEAD")
        started = task_runtime.start(self.controller, "X", umbrella_input=declaration)
        admission = started["creation_receipt"]["umbrella_admission"]
        self.assertIn(destination, admission["union_paths"])
        self.assertIn(source, admission["union_paths"])
        self.assertNotIn("juno-code", admission["union_paths"])
        self.assertNotIn(".juno_task/scripts", admission["union_paths"])
        self.assertEqual(admission["generated_output_bindings"]["Y"], [{
            "source": source, "destination": destination, "kind": "managed",
        }])

    def test_real_git_7kamsq_ytk4y1_scope_is_canonically_admitted(self) -> None:
        umbrella, first, second = "Et3fkc", "7KaMsQ", "ytk4Y1"
        exact = ".juno_task/scripts/tests/test_workflow_runner_resume_contract.py"
        target = self.repository / exact; target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("resume contract\n")
        other = self.repository / "juno-code/src/cli/commands/task.ts"
        other.parent.mkdir(parents=True, exist_ok=True); other.write_text("task cli\n")
        excluded = self.repository / "excluded/history-only.txt"
        excluded.parent.mkdir(parents=True, exist_ok=True); excluded.write_text("excluded\n")
        git(self.repository, "add", exact, "juno-code/src/cli/commands/task.ts", "excluded/history-only.txt")
        git(self.repository, "commit", "-m", "actual umbrella scope fixture")
        self.base = git(self.repository, "rev-parse", "HEAD")
        for task_id, body in ((umbrella, "Ordered tracking children fixed before start."),
                              (first, "Clarify baseline versus selectable yy task paths.\n"
                                      "Exclusions/history: excluded/history-only.txt"),
                              (second, "Remove stale pre-Bolt local-integration unit expectations.")):
            path = task_runtime.task_file(self.controller, task_id); path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(f"---\nid: {task_id}\nstatus: todo\n---\n{body}\n")
        self.write_task_scope(umbrella, children=[first, second], baseline=True)
        self.write_task_scope(first, owner=umbrella, baseline=True)
        self.write_task_scope(second, owner=umbrella, required=[exact])
        declaration = self.root / "actual-umbrella.json"
        declaration.write_text(json.dumps({"schema_version": task_runtime.UMBRELLA_INPUT_SCHEMA,
            "execution_mode": task_runtime.UMBRELLA_EXECUTION_MODE,
            "children": [first, second]}) + "\n")
        started = task_runtime.start(self.controller, umbrella, umbrella_input=declaration)
        self.assertIn(exact, started["creation_receipt"]["allowed_paths"])
        self.assertNotIn("excluded/history-only.txt", started["creation_receipt"]["allowed_paths"])
        binding = next(row for row in started["creation_receipt"]["umbrella_admission"]["child_bindings"]
                       if row["task_id"] == second)
        self.assertEqual(binding["required_paths"], [exact])
        self.assertFalse((self.workspaces / second).exists())

    def test_umbrella_start_refuses_unproven_child_path_and_owned_child_without_artifacts(self) -> None:
        declaration = self.umbrella_fixture()
        task_runtime.task_scope_path(self.controller, "Z").unlink()
        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError, "invalid canonical child scope"):
            task_runtime.start(self.controller, "X", umbrella_input=declaration)
        self.assertFalse((self.workspaces / "X").exists())
        self.assertIsNone(task_runtime.optional_ref_sha(self.repository, "refs/heads/task-X"))

        self.write_task_scope("Z", owner="X", required=["child/two.txt"])
        declaration = self.umbrella_fixture_after_existing_files()
        task_runtime.start(self.controller, "Y")
        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError, "child Y is already owned"):
            task_runtime.start(self.controller, "X", umbrella_input=declaration)
        self.assertFalse((self.workspaces / "X").exists())

    def umbrella_fixture_after_existing_files(self) -> Path:
        declaration = self.root / "umbrella-owned.json"
        declaration.write_text(json.dumps({
            "schema_version": task_runtime.UMBRELLA_INPUT_SCHEMA,
            "execution_mode": task_runtime.UMBRELLA_EXECUTION_MODE,
            "children": ["Y", "Z"],
        }) + "\n")
        return declaration

    def recovery_authorization(self, plan_path: Path, declaration: Path) -> Path:
        issued = task_runtime.issue_umbrella_recovery_authorization(
            self.controller, "X", plan_path, declaration)
        return Path(issued["path"])

    def test_umbrella_reservations_block_child_start_and_duplicate_owner(self) -> None:
        declaration = self.umbrella_fixture()
        task_runtime.start(self.controller, "X", umbrella_input=declaration)
        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError, "tracking-only under umbrella X"):
            task_runtime.start(self.controller, "Y")
        task_runtime.task_file(self.controller, "X2").parent.mkdir(parents=True, exist_ok=True)
        task_runtime.task_file(self.controller, "X2").write_text(
            "---\nid: X2\nstatus: todo\n---\n[task_id]Y Z[/task_id]\n"
        )
        duplicate = self.root / "duplicate.json"
        duplicate.write_text(json.dumps({"schema_version": task_runtime.UMBRELLA_INPUT_SCHEMA,
            "execution_mode": task_runtime.UMBRELLA_EXECUTION_MODE, "children": ["Y", "Z"]}) + "\n")
        self.write_task_scope("X2", children=["Y", "Z"], baseline=True)
        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError, "already owned by X"):
            task_runtime.start(self.controller, "X2", umbrella_input=duplicate)
        self.assertFalse((self.workspaces / "Y").exists())
        self.assertFalse((self.workspaces / "X2").exists())

    def test_mutation_lock_serializes_umbrella_and_ordinary_child_start_race(self) -> None:
        declaration = self.umbrella_fixture()

        def attempt(task_id: str, umbrella: Optional[Path]) -> tuple[str, bool]:
            try:
                task_runtime.start(self.controller, task_id, umbrella_input=umbrella)
                return task_id, True
            except task_runtime.TaskWorkspaceError:
                return task_id, False

        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = dict(pool.map(lambda args: attempt(*args), [
                ("X", declaration), ("Y", None),
            ]))
        self.assertEqual(sum(outcomes.values()), 1, outcomes)
        state = task_runtime.read_state(self.controller)
        owners = task_runtime.child_reservations(state)
        if outcomes["Y"]:
            self.assertNotIn("Y", owners)
        else:
            self.assertEqual(owners.get("Y"), "X")
            self.assertEqual(owners.get("Z"), "X")
        self.assertLessEqual(len([path for path in self.workspaces.iterdir()]), 1)

    def test_flat_umbrella_rejects_direct_child_with_nested_children_before_mutation(self) -> None:
        declaration = self.umbrella_fixture()
        nested = "W"
        path = task_runtime.task_file(self.controller, nested); path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("---\nid: W\nstatus: backlog\n---\nnested tracking task\n")
        self.write_task_scope(nested, owner="Z", baseline=True, lifecycle_status="backlog")
        self.write_task_scope("Z", owner="X", children=[nested], required=["child/two.txt"])
        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError, "must not declare nested children: W"):
            task_runtime.start(self.controller, "X", umbrella_input=declaration)
        self.assertFalse((self.workspaces / "X").exists())
        self.assertNotIn("X", task_runtime.read_state(self.controller)["tasks"])

    def test_tracking_child_lifecycle_allows_only_backlog_and_todo(self) -> None:
        self.umbrella_fixture()
        child = task_runtime.task_file(self.controller, "Y")
        for lifecycle in sorted(task_runtime.PRESTART_TRACKING_STATUSES):
            with self.subTest(allowed=lifecycle):
                child.write_text(f"---\nid: Y\nstatus: {lifecycle}\n---\npre-start\n")
                self.write_task_scope("Y", owner="X", required=["child/one.txt"],
                                      lifecycle_status=lifecycle)
                paths, _evidence, _frozen = task_runtime.canonical_child_scope(
                    self.controller, self.repository, self.base, "Y", child.read_bytes(),
                    task_runtime.load_config(self.controller), "X")
                self.assertEqual(paths, ["child/one.txt"])
        for lifecycle in ("in_progress", "working", "queued", "review", "done", "mystery"):
            with self.subTest(rejected=lifecycle):
                child.write_text(f"---\nid: Y\nstatus: {lifecycle}\n---\nnot pre-start\n")
                self.write_task_scope("Y", owner="X", required=["child/one.txt"],
                                      lifecycle_status=lifecycle)
                with self.assertRaisesRegex(task_runtime.TaskWorkspaceError,
                                            "not an unowned pre-start tracking state"):
                    task_runtime.canonical_child_scope(
                        self.controller, self.repository, self.base, "Y", child.read_bytes(),
                        task_runtime.load_config(self.controller), "X")
        self.assertFalse((self.workspaces / "X").exists())

    def test_terminal_contradictory_and_indirect_cycle_children_refuse_before_mutation(self) -> None:
        declaration = self.umbrella_fixture()
        z = task_runtime.task_file(self.controller, "Z")
        z.write_text("---\nid: Z\nstatus: done\n---\nterminal\n")
        self.write_task_scope("Z", owner="X", required=["child/two.txt"], lifecycle_status="done")
        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError, "terminal"):
            task_runtime.start(self.controller, "X", umbrella_input=declaration)
        z.write_text("---\nid: Z\nstatus: todo\n---\ncycle\n")
        self.write_task_scope("Z", owner="X", children=["X"], required=["child/two.txt"])
        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError, "indirect umbrella cycle"):
            task_runtime.start(self.controller, "X", umbrella_input=declaration)
        self.assertFalse((self.workspaces / "X").exists())

    def test_recovery_refuses_merge_parent_edge_escape_then_revert(self) -> None:
        declaration = self.umbrella_fixture()
        task_runtime.start(self.controller, "X")
        worktree = self.workspaces / "X"
        self.commit_task("X")
        task_branch = git(worktree, "symbolic-ref", "--short", "HEAD")
        git(worktree, "checkout", "-b", "escaped-side", self.base)
        (worktree / "src/side.txt").write_text("allowed side\n")
        git(worktree, "add", "src/side.txt"); git(worktree, "commit", "-m", "allowed side")
        git(worktree, "checkout", task_branch)
        git(worktree, "merge", "--no-ff", "--no-commit", "escaped-side")
        (worktree / "merge-escaped.txt").write_text("introduced only by merge resolution\n")
        git(worktree, "add", "merge-escaped.txt"); git(worktree, "commit", "-m", "ordinary merge adds escape")
        git(worktree, "rm", "merge-escaped.txt"); git(worktree, "commit", "-m", "revert merge escape")
        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError, "commit history escaped"):
            task_runtime.build_umbrella_recovery_plan(self.controller, "X", declaration)

    def test_recovery_refuses_escaped_then_reverted_history(self) -> None:
        declaration = self.umbrella_fixture()
        task_runtime.start(self.controller, "X")
        worktree = self.workspaces / "X"
        (worktree / "escaped.txt").write_text("escaped\n")
        git(worktree, "add", "escaped.txt"); git(worktree, "commit", "-m", "escaped")
        git(worktree, "rm", "escaped.txt"); git(worktree, "commit", "-m", "revert escaped")
        self.commit_task("X")
        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError, "commit history escaped"):
            task_runtime.build_umbrella_recovery_plan(self.controller, "X", declaration)

    def _contract_body(self, task_id: str, *, owner_decision: bool = False) -> None:
        decisions = ("\n## Unresolved decisions\n\n- The owner must authorize the release scope before implementation.\n"
                     if owner_decision else "")
        task_runtime.task_file(self.controller, task_id).write_text(
            f"---\nid: {task_id}\nstatus: todo\nlast_modified: '2026-08-20T00:00:00Z'\n---\n"
            f"\n<!-- juno:body:start -->\n\n## Goal\n\nShip the feature.\n\n"
            f"## Acceptance\n\n- Focused tests pass.\n- Full suite passes.\n"
            f"{decisions}\n<!-- juno:body:end -->\n")

    def test_contract_binds_requirements_base_and_reviewer_checklist(self) -> None:
        self._contract_body("X")
        task_runtime.start(self.controller, "X")
        contract = task_runtime.preimplementation_contract(self.controller, "X")
        self.assertEqual(contract["schema_version"],
                         task_runtime.PREIMPLEMENTATION_CONTRACT_SCHEMA)
        self.assertEqual(contract["status"], "ready")
        self.assertEqual(contract["version"], 1)
        binding = contract["binding"]
        self.assertEqual(binding["task_manifest_sha256"],
                         hashlib.sha256(
                             task_runtime.task_file(self.controller, "X").read_bytes()
                         ).hexdigest())
        self.assertEqual(binding["base_sha"], task_runtime.ref_sha(self.repository, "refs/heads/product"))
        checklist = contract["reviewer_checklist"]
        self.assertTrue(any("Focused tests pass" in item for item in checklist))
        self.assertTrue(contract["contract_path"].endswith("v1.json"))
        self.assertTrue(Path(contract["contract_path"]).is_file())

    def test_contract_refuses_handoff_while_owner_decisions_open(self) -> None:
        self._contract_body("X", owner_decision=True)
        task_runtime.start(self.controller, "X")
        contract = task_runtime.preimplementation_contract(self.controller, "X")
        self.assertEqual(contract["status"], "blocked_handoff")
        self.assertEqual(len(contract["owner_decisions"]), 1)
        self.assertIn("owner must authorize", contract["owner_decisions"][0])

    def test_contract_supersedes_without_rewriting_the_predecessor(self) -> None:
        self._contract_body("X")
        task_runtime.start(self.controller, "X")
        first = task_runtime.preimplementation_contract(self.controller, "X")
        first_path = Path(first["contract_path"])
        first_bytes = first_path.read_bytes()
        self._contract_body("X")
        second = task_runtime.preimplementation_contract(self.controller, "X")
        self.assertEqual(second["version"], 2)
        self.assertEqual(second["predecessor"]["path"], str(first_path))
        self.assertEqual(second["predecessor"]["sha256"],
                         hashlib.sha256(first_bytes).hexdigest())
        self.assertEqual(first_path.read_bytes(), first_bytes,
                         "superseding must never rewrite predecessor evidence")
        active = task_runtime.active_preimplementation_contract(self.controller, "X")
        assert active is not None
        self.assertEqual(active["version"], 2)

    def test_contract_parity_pairs_follow_runtime_template_twins(self) -> None:
        self._contract_body("X")
        task_runtime.start(self.controller, "X")
        with task_runtime.state_lock(self.controller):
            state = task_runtime.read_state(self.controller)
            state["tasks"]["X"]["changed_paths"] = [
                ".juno_task/scripts/merge_queue.py",
                "juno-code/src/templates/scripts/merge_queue.py",
                "src/feature.txt",
            ]
            task_runtime.write_state(self.controller, state)
        contract = task_runtime.preimplementation_contract(self.controller, "X")
        pairs = {json.dumps(pair, sort_keys=True) for pair in contract["parity_pairs"]}
        self.assertIn(json.dumps(
            {"runtime": ".juno_task/scripts/merge_queue.py",
             "template": "juno-code/src/templates/scripts/merge_queue.py"}, sort_keys=True), pairs)
        self.assertEqual(len(contract["parity_pairs"]), 1)
        self.assertTrue(any("Parity:" in item for item in contract["reviewer_checklist"]))

    def test_handoff_is_deterministic_bounded_and_byte_stable(self) -> None:
        task_runtime.start(self.controller, "X")
        first = task_runtime.run_handoff(self.controller, "X")
        second = task_runtime.run_handoff(self.controller, "X")
        self.assertEqual(first["schema_version"], task_runtime.HANDOFF_SCHEMA)
        self.assertEqual(first["state"], "WORKING")
        self.assertEqual(first["next_command"], "yy task preflight X")
        self.assertLessEqual(len(first["handoff_text"].encode()),
                             task_runtime.HANDOFF_MAX_BYTES)
        markdown = Path(first["handoff_paths"][1])
        before = markdown.read_bytes()
        task_runtime.run_handoff(self.controller, "X")
        self.assertEqual(markdown.read_bytes(), before,
                         "handoff must be byte-stable without state changes")
        self.assertIn("[x]", first["handoff_text"])
        self.assertIn("[>]", first["handoff_text"])
        self.assertIn("cost/duration: not available", first["handoff_text"])

    def test_handoff_fails_closed_on_conflicting_evidence(self) -> None:
        task_runtime.start(self.controller, "X")
        with task_runtime.state_lock(self.controller):
            state = task_runtime.read_state(self.controller)
            state["tasks"]["X"]["state"] = "AWAITING_RISK"
            state["tasks"]["X"]["queue_attempt"] = {"candidate_sha": None,
                                                    "risk": {"status": "AWAITING_RISK"}}
            task_runtime.write_state(self.controller, state)
        handoff = task_runtime.run_handoff(self.controller, "X")
        self.assertTrue(handoff["conflicts"])
        self.assertEqual(handoff["next_command"], "yy integration runtime-doctor")

    def test_handoff_maps_lifecycle_states_to_next_commands(self) -> None:
        task_runtime.start(self.controller, "X")
        cases = {"QUEUED": "yy merge next",
                 "AWAITING_RISK": "yy merge review X",
                 "REVIEW_FINDINGS": "repair findings in the task worktree, then yy merge reopen X",
                 "RISK_EVIDENCE_READY": "yy merge next X",
                 "MERGED": "none: task integrated; archive the Kanban task"}
        for queue_state, command in cases.items():
            with task_runtime.state_lock(self.controller):
                state = task_runtime.read_state(self.controller)
                if queue_state in {"AWAITING_RISK", "RISK_EVIDENCE_READY", "REVIEWING"}:
                    state["tasks"]["X"]["queue_attempt"] = {
                        "candidate_sha": "a" * 40,
                        "risk": {"status": queue_state,
                                 "review_progress": {"full_suite_admission": {
                                     "receipts": [{"receipt_path": "/tmp/r.json",
                                                   "receipt_sha256": "0" * 64}]}}}}
                elif queue_state == "MERGED":
                    state["tasks"]["X"]["queue_attempt"] = {"outcome": "MERGED",
                                                            "candidate_sha": "a" * 40}
                    state["tasks"]["X"]["outcome"] = "MERGED"
                else:
                    state["tasks"]["X"]["queue_attempt"] = {"risk": {"status": queue_state}}
                state["tasks"]["X"]["state"] = queue_state
                task_runtime.write_state(self.controller, state)
            handoff = task_runtime.run_handoff(self.controller, "X")
            self.assertEqual(handoff["next_command"], command, queue_state)

    def test_recovery_plan_audit_requires_kanban_routing_policy(self) -> None:
        self.payload("start", "X")
        with mock.patch.dict(os.environ, {
            "JUNO_CONTROL_INVOCATION_ROOT": str(self.controller),
            "JUNO_CONTROL_INVOCATION_ROLE": "controller",
            "JUNO_CONTROL_EFFECTIVE_ROOT": str(self.controller),
            "JUNO_CONTROL_OPERATION": "kanban",
        }, clear=False):
            receipt = task_runtime.record_control_audit(
                self.controller, "task", "recovery-plan", "X")
        self.assertEqual(json.loads(Path(receipt["path"]).read_text())["policy_operation"], "kanban")
        with mock.patch.dict(os.environ, {
            "JUNO_CONTROL_INVOCATION_ROOT": str(self.controller),
            "JUNO_CONTROL_INVOCATION_ROLE": "controller",
            "JUNO_CONTROL_EFFECTIVE_ROOT": str(self.controller),
            "JUNO_CONTROL_OPERATION": "orchestration",
        }, clear=False):
            with self.assertRaisesRegex(task_runtime.TaskWorkspaceError, "expected kanban"):
                task_runtime.record_control_audit(self.controller, "task", "recovery-plan", "X")

    def test_clean_working_umbrella_recovery_preserves_predecessor_and_is_idempotent(self) -> None:
        declaration = self.umbrella_fixture()
        started = task_runtime.start(self.controller, "X")
        predecessor = started["creation_receipt"]
        predecessor_sha = started["workspace_identity"]["create_receipt_sha256"]
        tip = self.commit_task("X")
        plan = task_runtime.build_umbrella_recovery_plan(self.controller, "X", declaration)
        self.assertEqual(plan["current_tip"], tip)
        self.assertEqual(plan["predecessor_receipt_sha256"], predecessor_sha)
        self.assertEqual(plan["newly_admitted_paths"], ["child/one.txt", "child/two.txt"])
        plan_path = self.root / "reviewed-plan.json"
        plan_path.write_text(json.dumps(plan, sort_keys=True, separators=(",", ":")) + "\n")
        authorization = self.recovery_authorization(plan_path, declaration)
        applied = task_runtime.apply_umbrella_recovery(
            self.controller, "X", plan_path, declaration, authorization)
        self.assertEqual(applied["outcome"], "applied")
        self.assertEqual(applied["creation_receipt"], predecessor)
        self.assertEqual(applied["workspace_identity"]["create_receipt_sha256"], predecessor_sha)
        self.assertEqual(git(self.workspaces / "X", "rev-parse", "HEAD"), tip)
        repeated = task_runtime.apply_umbrella_recovery(
            self.controller, "X", plan_path, declaration, authorization)
        self.assertEqual(repeated["outcome"], "already_applied")
        status = task_runtime.status(self.controller, "X")
        self.assertEqual(status["umbrella_admission_status"]["authority"], "authorized_superseding")
        self.assertEqual(status["creation_receipt"], predecessor)
        self.assertEqual(status["admission_supersessions"][0]["predecessor_receipt_sha256"], predecessor_sha)

    def test_umbrella_recovery_refuses_dirty_stale_revision_and_unauthorized_apply(self) -> None:
        declaration = self.umbrella_fixture()
        task_runtime.start(self.controller, "X")
        self.commit_task("X")
        dirty = self.workspaces / "X/src/dirty.txt"
        dirty.write_text("dirty\n")
        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError, "clean branch/worktree"):
            task_runtime.build_umbrella_recovery_plan(self.controller, "X", declaration)
        dirty.unlink()
        plan = task_runtime.build_umbrella_recovery_plan(self.controller, "X", declaration)
        plan_path = self.root / "stale-plan.json"
        plan_path.write_text(json.dumps(plan) + "\n")
        fake = self.controller / ".juno_task/receipts/task-admission-authorizations/fake.json"
        fake.parent.mkdir(parents=True, exist_ok=True)
        fake.write_text(json.dumps({"schema_version": task_runtime.UMBRELLA_AUTHORIZATION_SCHEMA,
            "authorization_id": "self-issued", "task_id": "X",
            "action": "supersede_umbrella_admission",
            "plan_sha256": task_runtime.stable_sha256(plan),
            "plan_file_sha256": hashlib.sha256(plan_path.read_bytes()).hexdigest(),
            "predecessor_receipt_sha256": plan["predecessor_receipt_sha256"]}) + "\n")
        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError, "trusted controller ledger"):
            task_runtime.apply_umbrella_recovery(
                self.controller, "X", plan_path, declaration, fake)
        authorization = self.recovery_authorization(plan_path, declaration)
        original_state = task_runtime.read_state(self.controller)
        child = task_runtime.task_file(self.controller, "Z")
        child.write_text(child.read_text() + "revision drift\n")
        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError, "stale"):
            task_runtime.apply_umbrella_recovery(
                self.controller, "X", plan_path, declaration, authorization)
        self.assertEqual(task_runtime.read_state(self.controller), original_state)
        self.assertEqual(git(self.workspaces / "X", "rev-parse", "HEAD"), plan["current_tip"])

    def install_declared_output_fixtures(self, *, omit: Optional[str] = None) -> dict[str, list[str] | str]:
        generated_source = "juno-code/canonical/implement.md"
        generated_destinations = [
            "juno-code/generated/implement.md",
            ".agents/skills/ralph-loop/references/implement.md",
            ".claude/skills/ralph-loop/references/implement.md",
            ".pi/skills/ralph-loop/references/implement.md",
        ]
        managed = {
            "juno-code/src/templates/scripts/migration_inventory.py":
                ".juno_task/scripts/migration_inventory.py",
            "juno-code/src/templates/scripts/controller_workspace.py":
                ".juno_task/scripts/controller_workspace.py",
            "juno-code/src/templates/scripts/controller_checkpoint.py":
                ".juno_task/scripts/controller_checkpoint.py",
        }
        declaration = self.repository / task_runtime.GENERATED_OUTPUT_DECLARATION
        declaration.write_text(json.dumps({
            "schema_version": task_runtime.GENERATED_OUTPUT_SCHEMA,
            "source": generated_source, "destinations": generated_destinations,
        }) + "\n")
        manifest = self.repository / task_runtime.MANAGED_OUTPUT_DECLARATION
        ordinary_source = "juno-code/src/templates/config/metadata-controller.json"
        ordinary_destination = ".juno_task/config/metadata-controller.json"
        manifest.write_text(json.dumps({
            "schemaVersion": 1,
            "assets": [{"source": "config/metadata-controller.json",
                        "destination": ordinary_destination, "installClass": "project", "type": "config"}],
            "admissionOutputs": [
                {"source": "scripts/controller_workspace.py", "destination": managed[
                    "juno-code/src/templates/scripts/controller_workspace.py"]},
                {"source": "scripts/migration_inventory.py", "destination": managed[
                    "juno-code/src/templates/scripts/migration_inventory.py"]},
                {"source": "scripts/controller_checkpoint.py", "destination": managed[
                    "juno-code/src/templates/scripts/controller_checkpoint.py"]},
            ],
        }) + "\n")
        files = [generated_source, *generated_destinations, *managed.keys(), *managed.values(),
                 ordinary_source, ordinary_destination]
        for relative in files:
            if relative == omit:
                continue
            target = self.repository / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("ordinary installed customization\n" if relative == ordinary_destination
                              else "contract base\n")
        git(self.repository, "add", ".")
        git(self.repository, "commit", "-m", "declare generated output fixtures")
        self.base = git(self.repository, "rev-parse", "HEAD")
        policy_path = self.controller / ".juno_task/config/task-workspace.json"
        policy = json.loads(policy_path.read_text())
        policy["allowed_paths"].extend(["juno-code", ".juno_task/config"])
        policy_path.write_text(json.dumps(policy, indent=2) + "\n")
        return {"source": generated_source, "destinations": generated_destinations,
                "managed_sources": list(managed), "managed_destinations": list(managed.values()),
                "ordinary_source": ordinary_source, "ordinary_destination": ordinary_destination}

    def test_resolves_relative_submodule_urls_for_scp_style_ssh_remotes(self) -> None:
        self.assertEqual(task_runtime._resolved_submodule_url(
            "git@github.com:org/root.git", "../child.git"),
            "git@github.com:org/child.git")
        self.assertEqual(task_runtime._resolved_submodule_url(
            "git@github.com:org/root.git", "./nested.git"),
            "git@github.com:org/root.git/nested.git")
        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError, "escapes SSH remote namespace"):
            task_runtime._resolved_submodule_url("git@github.com:root.git", "../../child.git")

    def test_non_juno_product_without_declaration_surface_starts_and_finishes(self) -> None:
        git(self.repository, "rm", task_runtime.GENERATED_OUTPUT_DECLARATION,
            task_runtime.MANAGED_OUTPUT_DECLARATION,
            "juno-code/unadmitted-canonical.txt", ".agents/unadmitted-output.txt")
        git(self.repository, "commit", "-m", "non-Juno product surface")
        self.base = git(self.repository, "rev-parse", "HEAD")

        started = self.payload("start", "X")
        self.assertEqual(started["creation_receipt"]["generated_output_admission"], {
            "schema_version": "juno_task_generated_output_admission.v2",
            "declarations": {}, "bindings": [],
            "scope": "product_has_no_juno_generated_output_surface",
        })
        worktree = self.workspaces / "X"
        (worktree / "src/base.txt").write_text("non-Juno change\n")
        git(worktree, "add", "src/base.txt")
        git(worktree, "commit", "-m", "ordinary product change")
        self.assertEqual(self.payload("finish", "X")["state"], "QUEUED")

    def test_partial_generated_declaration_surface_refuses_before_worktree(self) -> None:
        git(self.repository, "rm", task_runtime.MANAGED_OUTPUT_DECLARATION)
        git(self.repository, "commit", "-m", "partial Juno declaration surface")
        failed = self.command("start", "X", False)
        self.assertEqual(failed.returncode, 2)
        self.assertIn("generated-output declaration surface is partial", failed.stderr)
        self.assertIn(task_runtime.MANAGED_OUTPUT_DECLARATION, failed.stderr)
        self.assertFalse((self.workspaces / "X").exists())
    def test_authoritative_juno_fixture_missing_asset_has_one_setup_diagnostic(self) -> None:
        declaration = self.repository / task_runtime.GENERATED_OUTPUT_DECLARATION
        declaration.unlink()
        with self.assertRaisesRegex(
                AssertionError,
                "real-Git Juno fixture missing authoritative admission assets: "
                "juno-code/scripts/implementation-contract.json"):
            assert_juno_admission_fixture(self.repository)

    def test_declared_generator_and_managed_outputs_are_hash_bound_and_queue_at_byte_parity(self) -> None:
        fixtures = self.install_declared_output_fixtures()
        started = self.payload("start", "X")
        admission = started["creation_receipt"]["generated_output_admission"]
        self.assertEqual(admission["declarations"], {
            task_runtime.GENERATED_OUTPUT_DECLARATION: hashlib.sha256(
                (self.repository / task_runtime.GENERATED_OUTPUT_DECLARATION).read_bytes()).hexdigest(),
            task_runtime.MANAGED_OUTPUT_DECLARATION: hashlib.sha256(
                (self.repository / task_runtime.MANAGED_OUTPUT_DECLARATION).read_bytes()).hexdigest(),
        })
        exact_outputs = [*fixtures["destinations"], *fixtures["managed_destinations"]]
        admitted = started["creation_receipt"]["allowed_paths"]
        self.assertTrue(all(task_runtime.path_within(path, admitted) for path in exact_outputs))
        self.assertTrue(all(path in admitted for path in exact_outputs if path.startswith(".")))
        self.assertTrue(all(len(row["base_source_sha256"]) == 64 for row in admission["bindings"]))
        binding_pairs = {(row["source"], row["destination"]) for row in admission["bindings"]}
        self.assertTrue(all((source, destination) in binding_pairs for source, destination in zip(
            fixtures["managed_sources"], fixtures["managed_destinations"])))
        self.assertNotIn((fixtures["ordinary_source"], fixtures["ordinary_destination"]), binding_pairs)
        worktree = self.workspaces / "X"
        changed = [fixtures["source"], *fixtures["destinations"],
                   *fixtures["managed_sources"], *fixtures["managed_destinations"]]
        for relative in changed:
            (worktree / relative).write_text("contract updated\n")
        git(worktree, "add", *changed)
        git(worktree, "commit", "-m", "update declared outputs at parity")
        queued = self.payload("finish", "X")
        self.assertEqual(queued["state"], "QUEUED")
        self.assertEqual(queued["changed_paths"], sorted(changed))

    def test_divergent_ordinary_managed_asset_is_not_parity_bound(self) -> None:
        fixtures = self.install_declared_output_fixtures()
        started = self.payload("start", "X")
        bindings = started["creation_receipt"]["generated_output_admission"]["bindings"]
        self.assertNotIn(fixtures["ordinary_destination"],
                         [row["destination"] for row in bindings])
        worktree = self.workspaces / "X"
        destination = fixtures["ordinary_destination"]
        (worktree / destination).write_text(
            json.dumps({"independent_controller_config": True}, indent=4) + "\n")
        git(worktree, "add", destination)
        git(worktree, "commit", "-m", "update controller config independently")
        queued = self.payload("finish", "X")
        self.assertEqual(queued["changed_paths"], [destination])

    def test_controller_checkpoint_is_exactly_bound_without_admitting_scripts_root(self) -> None:
        fixtures = self.install_declared_output_fixtures()
        started = self.payload("start", "X")
        checkpoint_source = "juno-code/src/templates/scripts/controller_checkpoint.py"
        checkpoint_destination = ".juno_task/scripts/controller_checkpoint.py"
        admitted = started["creation_receipt"]["allowed_paths"]
        bindings = started["creation_receipt"]["generated_output_admission"]["bindings"]
        self.assertIn(checkpoint_destination, admitted)
        self.assertNotIn(".juno_task/scripts", admitted)
        self.assertIn((checkpoint_source, checkpoint_destination), {
            (row["source"], row["destination"]) for row in bindings
        })
        undeclared = ".juno_task/scripts/controller_checkpoint_extra.py"
        self.assertFalse(task_runtime.path_within(undeclared, admitted))
        self.commit_task("X", undeclared)
        failed = self.command("finish", "X", False)
        self.assertEqual(failed.returncode, 2)
        self.assertIn(f"disallowed paths: {undeclared}", failed.stderr)

    def test_all_managed_script_pairs_enforce_byte_parity(self) -> None:
        fixtures = self.install_declared_output_fixtures()
        for task_id, source, destination in zip(
                ("X", "Y", "Z"), fixtures["managed_sources"], fixtures["managed_destinations"]):
            with self.subTest(destination=destination):
                self.payload("start", task_id)
                worktree = self.workspaces / task_id
                (worktree / source).write_text("source changed without runtime counterpart\n")
                git(worktree, "add", source)
                git(worktree, "commit", "-m", "omit managed runtime counterpart")
                failed = self.command("finish", task_id, False)
                self.assertEqual(failed.returncode, 2)
                self.assertIn("generated-output byte parity failed", failed.stderr)
                self.assertIn(destination, failed.stderr)

    def test_changed_canonical_source_without_generated_outputs_refuses_finish(self) -> None:
        fixtures = self.install_declared_output_fixtures()
        self.payload("start", "X")
        worktree = self.workspaces / "X"
        source = fixtures["source"]
        (worktree / source).write_text("canonical changed without generation\n")
        git(worktree, "add", source)
        git(worktree, "commit", "-m", "omit generated outputs")
        failed = self.command("finish", "X", False)
        self.assertEqual(failed.returncode, 2)
        self.assertIn("generated-output byte parity failed", failed.stderr)
        self.assertIn(".agents/skills/ralph-loop/references/implement.md", failed.stderr)

    def test_malformed_managed_admission_pair_refuses_start(self) -> None:
        self.install_declared_output_fixtures()
        manifest = self.repository / task_runtime.MANAGED_OUTPUT_DECLARATION
        value = json.loads(manifest.read_text())
        value["admissionOutputs"][0]["unexpected"] = True
        manifest.write_text(json.dumps(value) + "\n")
        git(self.repository, "add", task_runtime.MANAGED_OUTPUT_DECLARATION)
        git(self.repository, "commit", "-m", "malformed admission pair")
        failed = self.command("start", "X", False)
        self.assertEqual(failed.returncode, 2)
        self.assertIn("invalid generated-output declaration", failed.stderr)

    def test_duplicate_managed_admission_pair_refuses_start(self) -> None:
        self.install_declared_output_fixtures()
        manifest = self.repository / task_runtime.MANAGED_OUTPUT_DECLARATION
        value = json.loads(manifest.read_text())
        value["admissionOutputs"].append(dict(value["admissionOutputs"][0]))
        manifest.write_text(json.dumps(value) + "\n")
        git(self.repository, "add", task_runtime.MANAGED_OUTPUT_DECLARATION)
        git(self.repository, "commit", "-m", "duplicate admission pair")
        failed = self.command("start", "X", False)
        self.assertEqual(failed.returncode, 2)
        self.assertIn("duplicate generated-output pair", failed.stderr)

    def test_conflicting_managed_admission_destination_refuses_start(self) -> None:
        self.install_declared_output_fixtures()
        manifest = self.repository / task_runtime.MANAGED_OUTPUT_DECLARATION
        value = json.loads(manifest.read_text())
        value["admissionOutputs"].append({
            "source": "scripts/migration_inventory.py",
            "destination": ".juno_task/scripts/controller_workspace.py",
        })
        manifest.write_text(json.dumps(value) + "\n")
        git(self.repository, "add", task_runtime.MANAGED_OUTPUT_DECLARATION)
        git(self.repository, "commit", "-m", "conflicting admission pair")
        failed = self.command("start", "X", False)
        self.assertEqual(failed.returncode, 2)
        self.assertIn("conflicting generated-output destination", failed.stderr)

    def test_declared_output_omission_is_caught_at_start_with_exact_path(self) -> None:
        missing = ".pi/skills/ralph-loop/references/implement.md"
        self.install_declared_output_fixtures(omit=missing)
        failed = self.command("start", "X", False)
        self.assertEqual(failed.returncode, 2)
        self.assertIn("declared generated outputs are missing at task start", failed.stderr)
        self.assertIn(missing, failed.stderr)
        self.assertFalse((self.workspaces / "X").exists())

    def test_unrelated_dot_directory_change_is_not_admitted_by_declared_outputs(self) -> None:
        self.install_declared_output_fixtures()
        self.payload("start", "X")
        self.commit_task("X", ".agents/skills/unrelated/SKILL.md")
        failed = self.command("finish", "X", False)
        self.assertEqual(failed.returncode, 2)
        self.assertIn("disallowed paths: .agents/skills/unrelated/SKILL.md", failed.stderr)

    def test_new_declaration_only_admits_fresh_tasks_and_keeps_old_receipt_frozen(self) -> None:
        self.install_declared_output_fixtures()
        started = self.payload("start", "X")
        frozen_receipt = started["creation_receipt"]
        frozen_digest = started["workspace_identity"]["create_receipt_sha256"]

        source = "juno-code/src/templates/extensions/pi/new-extension.ts"
        destination = ".pi/extensions/new-extension.ts"
        manifest = self.repository / task_runtime.MANAGED_OUTPUT_DECLARATION
        value = json.loads(manifest.read_text())
        value["admissionOutputs"].append({
            "source": "extensions/pi/new-extension.ts", "destination": destination,
        })
        manifest.write_text(json.dumps(value) + "\n")
        for relative in (source, destination):
            target = self.repository / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("new extension\n")
        git(self.repository, "add", task_runtime.MANAGED_OUTPUT_DECLARATION, source, destination)
        git(self.repository, "commit", "-m", "declare a later generated output")

        old_status = self.payload("status", "X")
        self.assertEqual(old_status["creation_receipt"], frozen_receipt)
        self.assertEqual(old_status["workspace_identity"]["create_receipt_sha256"], frozen_digest)
        self.assertFalse(task_runtime.path_within(
            destination, old_status["creation_receipt"]["allowed_paths"]))

        fresh = self.payload("start", "Y")
        self.assertTrue(task_runtime.path_within(
            destination, fresh["creation_receipt"]["allowed_paths"]))
        self.assertIn((source, destination), {
            (row["source"], row["destination"])
            for row in fresh["creation_receipt"]["generated_output_admission"]["bindings"]
        })
        self.assertNotEqual(
            fresh["creation_receipt"]["generated_output_admission"]["declarations"]
                [task_runtime.MANAGED_OUTPUT_DECLARATION],
            frozen_receipt["generated_output_admission"]["declarations"]
                [task_runtime.MANAGED_OUTPUT_DECLARATION],
        )

        self.commit_task("X", destination)
        failed = self.command("finish", "X", False)
        self.assertEqual(failed.returncode, 2)
        self.assertIn(f"disallowed paths: {destination}", failed.stderr)

    def test_unchanged_generated_contracts_do_not_expand_finish_requirements(self) -> None:
        self.install_declared_output_fixtures()
        self.payload("start", "X")
        self.commit_task("X")
        queued = self.payload("finish", "X")
        self.assertEqual(queued["changed_paths"], ["src/feature.txt"])

    def test_concurrent_tasks_share_frozen_base_without_controller_data(self) -> None:
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(self.payload, "start", task_id) for task_id in ("X", "Y")]
            x, y = [future.result() for future in futures]
        self.assertEqual(x["base_sha"], self.base)
        self.assertEqual(y["base_sha"], self.base)
        self.assertNotEqual(x["branch_ref"], y["branch_ref"])
        self.assertNotEqual(x["worktree"], y["worktree"])
        for task_id in ("X", "Y"):
            worktree = self.workspaces / task_id
            self.assertTrue((worktree / task_runtime.RUNTIME_PATH).is_file())
            self.assertFalse((worktree / ".juno_task/tasks").exists())
            self.assertEqual(git(worktree, "config", "--worktree", "--get", "juno.workspace.role"), "task")
            self.assertEqual(git(worktree, "config", "--worktree", "--get", "juno.workspace.roleBase"), self.base)
            self.assertEqual(git(worktree, "config", "--worktree", "--get", "juno.workspace.taskId"), task_id)
            for key in ("manifestIdentity", "createReceiptSha256", "expectedPathsSha256",
                        "materializationSha256"):
                self.assertRegex(git(worktree, "config", "--worktree", "--get", f"juno.workspace.{key}"), r"^[0-9a-f]{64}$")
            status = self.payload("status", task_id)
            self.assertEqual(status["routing"], {
                "invocation_root": str(self.controller.resolve()), "invocation_role": "controller",
                "effective_root": str(self.controller.resolve()),
            })
            receipt_bytes = json.dumps(status["creation_receipt"], sort_keys=True,
                                       separators=(",", ":")).encode()
            self.assertEqual(hashlib.sha256(receipt_bytes).hexdigest(),
                             status["workspace_identity"]["create_receipt_sha256"])
            self.assertEqual(status["creation_receipt"]["materialization"], {
                "mode": "full", "sparse_checkout": False,
                "materialized_allowed_paths": ["src"],
            })

    def test_sparse_controller_starts_a_full_task_checkout(self) -> None:
        git(self.repository, "config", "extensions.worktreeConfig", "true")
        git(self.controller, "sparse-checkout", "init", "--no-cone")
        git(self.controller, "sparse-checkout", "set", "--no-cone", "/.juno_task/")
        self.assertEqual(git(self.controller, "config", "--worktree", "--bool", "--get",
                             "core.sparseCheckout"), "true")

        started = self.payload("start", "X")
        worktree = self.workspaces / "X"
        self.assertEqual(started["base_sha"], self.base)
        self.assertTrue((worktree / "src/base.txt").is_file())
        self.assertNotEqual(git(worktree, "config", "--worktree", "--bool", "--get",
                                "core.sparseCheckout"), "true")
        self.assertFalse(any(line.startswith("S ")
                             for line in git(worktree, "ls-files", "-t").splitlines()))
        self.assertEqual(git(worktree, "status", "--porcelain=v1", "--untracked-files=all"), "")
        self.assertEqual(started["creation_receipt"]["materialization"]["mode"], "full")

    def test_start_freezes_explicit_policy_admitted_paths(self) -> None:
        started = task_runtime.start(self.controller, "X", ["optional"])
        self.assertEqual(started["creation_receipt"]["requested_paths"], ["optional"])
        self.assertEqual(started["creation_receipt"]["allowed_paths"], ["src", "optional"])
        self.assertEqual(started["creation_receipt"]["selected_entries"]["optional"]["type"], "tree")
        self.assertTrue((self.workspaces / "X" / "optional/base.txt").is_file())
        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError, "differ from the frozen"):
            task_runtime.start(self.controller, "X", [])

    def test_exact_runtime_parity_paths_queue_with_their_package_templates(self) -> None:
        policy_path = self.controller / ".juno_task/config/task-workspace.json"
        policy = json.loads(policy_path.read_text())
        runtime_paths = [runtime for runtime, _ in RUNTIME_TEMPLATE_PARITY]
        policy["allowed_paths"].extend([*runtime_paths, "juno-code"])
        policy_path.write_text(json.dumps(policy, indent=2) + "\n")

        for runtime, template in RUNTIME_TEMPLATE_PARITY:
            for relative in (runtime, template):
                target = self.repository / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(f"base {relative}\n")
        git(self.repository, "add", ".juno_task/scripts", "juno-code")
        git(self.repository, "commit", "-m", "add guarded parity fixtures")
        self.base = git(self.repository, "rev-parse", "HEAD")

        started = self.payload("start", "X")
        self.assertNotIn(".juno_task/scripts", started["creation_receipt"]["allowed_paths"])
        self.assertTrue(set(runtime_paths).issubset(started["creation_receipt"]["allowed_paths"]))
        worktree = self.workspaces / "X"
        changed = []
        for runtime, template in RUNTIME_TEMPLATE_PARITY:
            for relative in (runtime, template):
                (worktree / relative).write_text("paired update\n")
                changed.append(relative)
        git(worktree, "add", *changed)
        git(worktree, "commit", "-m", "update runtime template parity")

        queued = self.payload("finish", "X")
        self.assertEqual(queued["state"], "QUEUED")
        self.assertEqual(queued["changed_paths"], sorted(changed))

    def test_unadmitted_required_path_refuses_before_creation(self) -> None:
        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError, "not admitted by policy"):
            task_runtime.start(self.controller, "X", ["unknown"])
        self.assertFalse((self.workspaces / "X").exists())
        self.assertNotEqual(run(["git", "-C", str(self.repository), "show-ref", "--verify",
                                 "--quiet", "refs/heads/task-X"], self.repository, False).returncode, 0)
        self.assertNotIn("X", task_runtime.read_state(self.controller)["tasks"])

    def test_selected_gitlink_is_initialized_at_the_exact_target_object(self) -> None:
        child = self.root / "child"
        child.mkdir()
        git(child, "init", "-b", "main")
        git(child, "config", "user.email", "test@example.com")
        git(child, "config", "user.name", "Test")
        (child / "child.txt").write_text("child\n")
        git(child, "add", "child.txt")
        git(child, "commit", "-m", "child base")
        child_sha = git(child, "rev-parse", "HEAD")
        run(["git", "-c", "protocol.file.allow=always", "-C", str(self.repository),
             "submodule", "add", str(child), "nested"], self.repository)
        git(self.repository, "commit", "-am", "add nested product root")
        self.base = git(self.repository, "rev-parse", "HEAD")
        policy_path = self.controller / ".juno_task/config/task-workspace.json"
        policy = json.loads(policy_path.read_text())
        policy["selectable_paths"].append("nested")
        policy_path.write_text(json.dumps(policy, indent=2) + "\n")

        with mock.patch.dict(os.environ, {"GIT_ALLOW_PROTOCOL": "file"}, clear=False):
            started = task_runtime.start(self.controller, "X", ["nested"])
        nested = self.workspaces / "X" / "nested"
        self.assertEqual(git(nested, "rev-parse", "HEAD"), child_sha)
        self.assertEqual(started["creation_receipt"]["selected_entries"]["nested"], {
            "mode": "160000", "type": "commit", "object": child_sha,
        })

    def test_unavailable_selected_gitlink_leaves_no_task_artifacts(self) -> None:
        child = self.root / "child-missing"
        child.mkdir()
        git(child, "init", "-b", "main")
        git(child, "config", "user.email", "test@example.com")
        git(child, "config", "user.name", "Test")
        (child / "child.txt").write_text("child\n")
        git(child, "add", "child.txt")
        git(child, "commit", "-m", "child base")
        run(["git", "-c", "protocol.file.allow=always", "-C", str(self.repository),
             "submodule", "add", str(child), "missing-nested"], self.repository)
        unavailable = "f" * 40
        run(["git", "-C", str(self.repository), "update-index", "--cacheinfo",
             f"160000,{unavailable},missing-nested"], self.repository)
        git(self.repository, "commit", "-m", "record unavailable nested object")
        self.base = git(self.repository, "rev-parse", "HEAD")
        policy_path = self.controller / ".juno_task/config/task-workspace.json"
        policy = json.loads(policy_path.read_text())
        policy["selectable_paths"].append("missing-nested")
        policy_path.write_text(json.dumps(policy, indent=2) + "\n")

        with mock.patch.dict(os.environ, {"GIT_ALLOW_PROTOCOL": "file"}, clear=False):
            with self.assertRaises(task_runtime.TaskWorkspaceError):
                task_runtime.start(self.controller, "X", ["missing-nested"])
        self.assertFalse((self.workspaces / "X").exists())
        self.assertNotEqual(run(["git", "-C", str(self.repository), "show-ref", "--verify",
                                 "--quiet", "refs/heads/task-X"], self.repository, False).returncode, 0)
        self.assertNotIn("X", task_runtime.read_state(self.controller)["tasks"])

    def test_checkpoint_and_runtime_bootstrap_agree_on_historical_reference_bound_nested_specs(self) -> None:
        artifact_dir = (self.controller / ".juno_task/specs/backend/artifacts"
                        / "ENDPOINT_PHASE_MAGIC_W2_E2E_post_deploy")
        artifact_dir.mkdir(parents=True)
        report = artifact_dir / "observation_20260816T000348Z.md"
        aggregate = artifact_dir / "observation_20260816T000348Z.aggregate.json"
        relative_report = report.relative_to(self.controller).as_posix()
        report.write_text("Aggregate evidence: `observation_20260816T000348Z.aggregate.json`.\n")
        aggregate.write_text('{"count": 98}\n')
        task = self.controller / ".juno_task/tasks/x/X.md"
        task.write_text(task.read_text() + f"Artifact: `{relative_report}`.\n")
        git(self.controller, "add", relative_report, aggregate.relative_to(self.controller).as_posix(),
            ".juno_task/tasks/x/X.md")
        git(self.controller, "commit", "-m", "checkpoint receipt-bound endpoint evidence")

        checkpoint = SCRIPT.with_name("controller_checkpoint.py")
        checkpoint_result = run([sys.executable, str(checkpoint), "--root", str(self.controller),
                                 "plan", "--json"], self.controller, False)
        self.assertEqual(checkpoint_result.returncode, 0, checkpoint_result.stderr)
        self.assertEqual(json.loads(checkpoint_result.stdout)["selected"], [])

        self.remove_runtime_for_consumer()
        package_hash = hashlib.sha256(SCRIPT.read_bytes()).hexdigest()
        plan = task_runtime.runtime_bootstrap(self.controller, "2.1.3", package_hash, None)
        controller_class = plan["controller_identity"]["controller_class"]
        self.assertEqual(controller_class["checks"],
                         ["branch_exact", "product_absent", "role", "tracked_boundary"])
        self.assertEqual(
            [item["path"] for item in controller_class["historical_tracked_attributions"]],
            sorted([relative_report, aggregate.relative_to(self.controller).as_posix()]))
        self.assertTrue(all(item["attribution_commit"] == git(self.controller, "rev-parse", "HEAD")
                            for item in controller_class["historical_tracked_attributions"]))

    def test_runtime_bootstrap_reports_every_nested_policy_refusal(self) -> None:
        for name in ("one.json", "two.md"):
            path = self.controller / ".juno_task/specs/backend/artifacts/unattributed" / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("unattributed\n")
        git(self.controller, "add", ".juno_task/specs/backend/artifacts/unattributed")
        git(self.controller, "commit", "-m", "legacy inconsistent nested evidence")
        self.remove_runtime_for_consumer()
        with self.assertRaises(task_runtime.TaskWorkspaceError) as raised:
            task_runtime.runtime_bootstrap(
                self.controller, "2.1.3", hashlib.sha256(SCRIPT.read_bytes()).hexdigest(), None)
        message = str(raised.exception)
        for name in ("one.json", "two.md"):
            self.assertIn(f".juno_task/specs/backend/artifacts/unattributed/{name}", message)
        self.assertIn("tracked_top_level_files:.juno_task/specs:direct_children_only", message)

    def test_sparse_metadata_controller_runtime_bootstrap_plan_apply_and_full_task_start(self) -> None:
        self.assertEqual(git(self.controller, "config", "--bool", "core.sparseCheckout"), "true")
        self.remove_runtime_for_consumer()
        package_hash = hashlib.sha256(SCRIPT.read_bytes()).hexdigest()
        before = git(self.repository, "rev-parse", "refs/heads/product")

        plan = task_runtime.runtime_bootstrap(self.controller, "2.1.3", package_hash, None)
        self.assertEqual(git(self.repository, "rev-parse", "refs/heads/product"), before)
        self.assertEqual(plan["target"]["ref"], "refs/heads/product")
        self.assertEqual(plan["target"]["sha"], before)
        self.assertEqual(plan["prior"]["state"], "absent")
        self.assertEqual(plan["proposed"]["sha256"], package_hash)
        # A controller-local scripts refresh does not mutate the package-bound plan.
        controller_runtime = self.controller / task_runtime.RUNTIME_PATH
        controller_runtime.parent.mkdir(parents=True, exist_ok=True)
        controller_runtime.write_bytes(SCRIPT.read_bytes())

        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError, "package"):
            task_runtime.runtime_bootstrap(self.controller, "9.9.9", package_hash,
                                           Path(plan["receipt"]["path"]))
        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError, "identity mismatch|bytes/hash"):
            task_runtime.runtime_bootstrap(self.controller, "2.1.3", "f" * 64,
                                           Path(plan["receipt"]["path"]))
        applied = task_runtime.runtime_bootstrap(
            self.controller, "2.1.3", package_hash, Path(plan["receipt"]["path"]))
        self.assertEqual(applied["previous_sha"], before)
        self.assertEqual(applied["target_holder"]["path"], str(self.repository.resolve()))
        self.assertEqual(git(self.repository, "rev-parse", "HEAD"), applied["commit_sha"])
        self.assertEqual(git(self.repository, "status", "--porcelain=v1"), "")
        self.assertTrue((self.repository / task_runtime.RUNTIME_PATH).is_file())
        self.assertEqual(git(self.repository, "show", f"refs/heads/product:{task_runtime.RUNTIME_PATH}"),
                         SCRIPT.read_text().rstrip())
        inventory = json.loads(
            (self.repository / task_runtime.MANAGED_INVENTORY_PATH).read_text())
        self.assertEqual(inventory["packageVersion"], "2.1.3")
        self.assertEqual(
            inventory["assets"][task_runtime.RUNTIME_PATH]["installedSha256"], package_hash)
        next_prior = task_runtime._runtime_prior_state(
            self.controller, self.repository, applied["commit_sha"],
            b"next package runtime\n", "2.1.4")
        self.assertEqual(next_prior["package_version"], "2.1.3")
        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError, "already been applied"):
            task_runtime.runtime_bootstrap(self.controller, "2.1.3", package_hash,
                                           Path(plan["receipt"]["path"]))

        started = self.payload("start", "X")
        self.assertEqual(started["outcome"], "started")
        self.assertEqual(started["creation_receipt"]["runtime_generation"]["target_sha256"],
                         package_hash)
        self.assertEqual(git(self.workspaces / "X", "status", "--porcelain=v1"), "")
        self.assertNotEqual(git(self.workspaces / "X", "config", "--worktree", "--bool",
                                "--get", "core.sparseCheckout"), "true")

    def test_absent_runtime_bootstrap_preserves_valid_unrelated_inventory_entries(self) -> None:
        self.remove_runtime_for_consumer()
        stale_hash = hashlib.sha256(b"prior runtime\n").hexdigest()
        unrelated = {
            "type": "config", "templateVersion": "2.1.1",
            "sourceSha256": "a" * 64, "installedSha256": "b" * 64,
        }
        inventory = self.repository / task_runtime.MANAGED_INVENTORY_PATH
        inventory.parent.mkdir(parents=True, exist_ok=True)
        inventory.write_text(json.dumps({
            "schemaVersion": 1, "packageName": "@yylo/cli", "packageVersion": "2.1.2",
            "assets": {
                task_runtime.RUNTIME_PATH: {
                    "type": "script", "templateVersion": "2.1.2",
                    "sourceSha256": stale_hash, "installedSha256": stale_hash,
                },
                ".juno_task/config/unrelated.json": unrelated,
            },
        }) + "\n")
        git(self.repository, "add", task_runtime.MANAGED_INVENTORY_PATH)
        git(self.repository, "commit", "-m", "absent runtime with valid managed inventory")

        package_hash = hashlib.sha256(SCRIPT.read_bytes()).hexdigest()
        plan = task_runtime.runtime_bootstrap(self.controller, "2.1.3", package_hash, None)
        applied = task_runtime.runtime_bootstrap(
            self.controller, "2.1.3", package_hash, Path(plan["receipt"]["path"]))

        recovered = json.loads((self.repository / task_runtime.MANAGED_INVENTORY_PATH).read_text())
        self.assertEqual(git(self.repository, "rev-parse", "HEAD"), applied["commit_sha"])
        self.assertEqual(recovered["packageVersion"], "2.1.3")
        self.assertEqual(recovered["assets"][".juno_task/config/unrelated.json"], unrelated)
        self.assertEqual(
            recovered["assets"][task_runtime.RUNTIME_PATH]["templateVersion"], "2.1.3")

    def test_absent_runtime_bootstrap_refuses_malformed_unrelated_inventory_entry(self) -> None:
        self.remove_runtime_for_consumer()
        inventory = self.repository / task_runtime.MANAGED_INVENTORY_PATH
        inventory.parent.mkdir(parents=True, exist_ok=True)
        inventory.write_text(json.dumps({
            "schemaVersion": 1, "packageName": "@yylo/cli", "packageVersion": "2.1.2",
            "assets": {"unrelated": {"type": "script"}},
        }) + "\n")
        git(self.repository, "add", task_runtime.MANAGED_INVENTORY_PATH)
        git(self.repository, "commit", "-m", "absent runtime with malformed managed entry")

        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError,
                                    "missing runtime lacks an exact non-newer managed-inventory"):
            task_runtime.runtime_bootstrap(
                self.controller, "2.1.3", hashlib.sha256(SCRIPT.read_bytes()).hexdigest(), None)
        self.assertFalse((self.controller / task_runtime.RUNTIME_BOOTSTRAP_ROOT).exists())

    def test_runtime_bootstrap_advances_existing_inventory_to_coherent_rc_generation(self) -> None:
        stale = self.install_stale_consumer_runtime("2.1.3-rc.0.11")
        package_hash = hashlib.sha256(SCRIPT.read_bytes()).hexdigest()
        before = git(self.repository, "rev-parse", "HEAD")

        refused = self.command("start", "X", check=False)
        self.assertEqual(refused.returncode, 2)
        self.assertIn("stale or absent from the consumer target", refused.stderr)
        self.assertIn("yy task runtime-bootstrap --dry-run", refused.stderr)
        plan = task_runtime.runtime_bootstrap(
            self.controller, "2.1.3-rc.0.12", package_hash, None)
        self.assertEqual(git(self.repository, "rev-parse", "HEAD"), before)
        self.assertEqual(base64.b64decode(plan["prior"]["bytes_base64"]), stale)
        self.assertEqual(plan["prior"]["package_version"], "2.1.3-rc.0.11")
        self.assertEqual(plan["prior"]["classification"],
                         "exact_managed_inventory_consumer_generation")
        self.assertRegex(plan["prior"]["inventory_sha256"], r"^[0-9a-f]{64}$")

        applied = task_runtime.runtime_bootstrap(
            self.controller, "2.1.3-rc.0.12", package_hash,
            Path(plan["receipt"]["path"]))
        self.assertEqual(git(self.repository, "rev-parse", "HEAD"), applied["commit_sha"])
        self.assertEqual((self.repository / task_runtime.RUNTIME_PATH).read_bytes(),
                         SCRIPT.read_bytes())
        inventory = json.loads(
            (self.repository / task_runtime.MANAGED_INVENTORY_PATH).read_text())
        runtime_entry = inventory["assets"][task_runtime.RUNTIME_PATH]
        self.assertEqual(inventory["packageVersion"], "2.1.3-rc.0.12")
        self.assertEqual(runtime_entry, {
            "type": "script", "templateVersion": "2.1.3-rc.0.12",
            "sourceSha256": package_hash, "installedSha256": package_hash,
        })
        self.assertEqual(sorted(git(
            self.repository, "diff-tree", "--no-commit-id", "--name-only", "-r",
            applied["commit_sha"]).splitlines()),
            sorted([task_runtime.RUNTIME_PATH, task_runtime.MANAGED_INVENTORY_PATH]))
        next_prior = task_runtime._runtime_prior_state(
            self.controller, self.repository, applied["commit_sha"],
            b"next package runtime\n", "2.1.3")
        self.assertEqual(next_prior["package_version"], "2.1.3-rc.0.12")
        self.assertEqual(next_prior["sha256"], package_hash)
        self.assertEqual(git(self.repository, "status", "--porcelain=v1"), "")
        self.assertEqual(self.payload("start", "X")["outcome"], "started")

    def test_stale_then_absent_runtime_allows_later_recovery(self) -> None:
        self.install_stale_consumer_runtime()
        package_hash = hashlib.sha256(SCRIPT.read_bytes()).hexdigest()
        first_plan = task_runtime.runtime_bootstrap(self.controller, "2.1.3", package_hash, None)
        task_runtime.runtime_bootstrap(
            self.controller, "2.1.3", package_hash, Path(first_plan["receipt"]["path"]))
        git(self.repository, "rm", task_runtime.RUNTIME_PATH)
        git(self.repository, "commit", "-m", "delete previously recovered runtime")

        second_plan = task_runtime.runtime_bootstrap(self.controller, "2.1.4", package_hash, None)
        self.assertEqual(second_plan["prior"]["state"], "absent")
        second = task_runtime.runtime_bootstrap(
            self.controller, "2.1.4", package_hash, Path(second_plan["receipt"]["path"]))

        inventory = json.loads(
            (self.repository / task_runtime.MANAGED_INVENTORY_PATH).read_text())
        self.assertEqual(git(self.repository, "rev-parse", "HEAD"), second["commit_sha"])
        self.assertEqual(inventory["packageVersion"], "2.1.4")
        self.assertEqual(
            inventory["assets"][task_runtime.RUNTIME_PATH]["templateVersion"], "2.1.4")
        self.assertEqual((self.repository / task_runtime.RUNTIME_PATH).read_bytes(),
                         SCRIPT.read_bytes())

    def test_runtime_bootstrap_refuses_malformed_unrelated_inventory_entry(self) -> None:
        self.install_stale_consumer_runtime()
        inventory = self.repository / task_runtime.MANAGED_INVENTORY_PATH
        payload = json.loads(inventory.read_text())
        payload["assets"]["unrelated"] = {"type": "script"}
        inventory.write_text(json.dumps(payload) + "\n")
        git(self.repository, "add", task_runtime.MANAGED_INVENTORY_PATH)
        git(self.repository, "commit", "-m", "malformed unrelated managed entry")
        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError,
                                    "lacks exact managed-inventory provenance"):
            task_runtime.runtime_bootstrap(
                self.controller, "2.1.3", hashlib.sha256(SCRIPT.read_bytes()).hexdigest(), None)

    def test_runtime_bootstrap_refuses_non_older_consumer_inventory_generation(self) -> None:
        self.install_stale_consumer_runtime("2.1.3")
        package_hash = hashlib.sha256(SCRIPT.read_bytes()).hexdigest()
        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError,
                                    "generation is not older"):
            task_runtime.runtime_bootstrap(self.controller, "2.1.3", package_hash, None)
        self.assertFalse((self.controller / task_runtime.RUNTIME_BOOTSTRAP_ROOT).exists())

    def test_runtime_bootstrap_refuses_missing_runtime_in_source_repository(self) -> None:
        git(self.repository, "rm", task_runtime.RUNTIME_PATH)
        git(self.repository, "commit", "-m", "source target lacks task runtime")
        before = git(self.repository, "rev-parse", "HEAD^{tree}")
        package_hash = hashlib.sha256(SCRIPT.read_bytes()).hexdigest()

        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError,
                                    "update package template/runtime/inventory atomically"):
            task_runtime.runtime_bootstrap(self.controller, "2.1.3", package_hash, None)

        self.assertEqual(git(self.repository, "rev-parse", "HEAD^{tree}"), before)
        self.assertFalse((self.repository / task_runtime.RUNTIME_PATH).exists())
        self.assertEqual(
            (self.repository / "juno-code/src/templates/scripts/task_workspace.py").read_bytes(),
            SCRIPT.read_bytes())
        self.assertFalse((self.controller / task_runtime.RUNTIME_BOOTSTRAP_ROOT).exists())
        self.assertEqual(git(self.repository, "status", "--porcelain=v1"), "")

    def test_missing_newer_source_runtime_directs_matching_controller_generation(self) -> None:
        git(self.repository, "rm", task_runtime.RUNTIME_PATH)
        package = self.repository / "juno-code/package.json"
        package.write_text(json.dumps({"name": "@yylo/cli", "version": "2.1.4"}) + "\n")
        source = self.repository / "juno-code/src/templates/scripts/task_workspace.py"
        source.write_bytes(b"#!/usr/bin/env python3\n# newer source template\n")
        git(self.repository, "add", "juno-code/package.json",
            "juno-code/src/templates/scripts/task_workspace.py")
        git(self.repository, "commit", "-m", "newer source generation missing runtime")
        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError,
                                    "upgrade or rebind the controller package/runtime"):
            task_runtime.runtime_bootstrap(
                self.controller, "2.1.3", hashlib.sha256(SCRIPT.read_bytes()).hexdigest(), None)
        self.assertFalse((self.controller / task_runtime.RUNTIME_BOOTSTRAP_ROOT).exists())

    def test_runtime_bootstrap_refuses_exact_stale_source_generation_without_mutation(self) -> None:
        stale = b"#!/usr/bin/env python3\n# exact older package runtime\n"
        runtime = self.repository / task_runtime.RUNTIME_PATH
        runtime.write_bytes(stale)
        source = self.repository / "juno-code/src/templates/scripts/task_workspace.py"
        source.write_bytes(stale)
        inventory = self.repository / task_runtime.MANAGED_INVENTORY_PATH
        inventory.parent.mkdir(parents=True, exist_ok=True)
        package = self.repository / "juno-code/package.json"
        package.write_text(json.dumps({"name": "@yylo/cli", "version": "2.1.2"}) + "\n")
        stale_hash = hashlib.sha256(stale).hexdigest()
        inventory.write_text(json.dumps({
            "schemaVersion": 1, "packageName": "@yylo/cli", "packageVersion": "2.1.2",
            "assets": {task_runtime.RUNTIME_PATH: {
                "type": "script", "templateVersion": "2.1.2",
                "sourceSha256": stale_hash, "installedSha256": stale_hash,
            }},
        }) + "\n")
        git(self.repository, "add", task_runtime.RUNTIME_PATH,
            "juno-code/src/templates/scripts/task_workspace.py", "juno-code/package.json",
            task_runtime.MANAGED_INVENTORY_PATH)
        git(self.repository, "commit", "-m", "exact stale source runtime generation")
        before = git(self.repository, "rev-parse", "HEAD^{tree}")
        package_hash = hashlib.sha256(SCRIPT.read_bytes()).hexdigest()

        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError,
                                    "update package template/runtime/inventory atomically"):
            task_runtime.runtime_bootstrap(self.controller, "2.1.3", package_hash, None)

        self.assertEqual(git(self.repository, "rev-parse", "HEAD^{tree}"), before)
        self.assertEqual(runtime.read_bytes(), stale)
        self.assertEqual(source.read_bytes(), stale)
        self.assertEqual(hashlib.sha256(runtime.read_bytes()).hexdigest(), stale_hash)
        self.assertEqual(json.loads(inventory.read_text())["assets"][task_runtime.RUNTIME_PATH], {
            "type": "script", "templateVersion": "2.1.2",
            "sourceSha256": stale_hash, "installedSha256": stale_hash,
        })
        self.assertEqual(git(self.repository, "status", "--porcelain=v1"), "")
        self.assertFalse((self.controller / task_runtime.RUNTIME_BOOTSTRAP_ROOT).exists())

    def test_newer_coherent_source_generation_directs_controller_runtime_upgrade(self) -> None:
        newer = b"#!/usr/bin/env python3\n# coherent newer source runtime\n"
        runtime = self.repository / task_runtime.RUNTIME_PATH
        source = self.repository / "juno-code/src/templates/scripts/task_workspace.py"
        package = self.repository / "juno-code/package.json"
        inventory = self.repository / task_runtime.MANAGED_INVENTORY_PATH
        runtime.write_bytes(newer)
        source.write_bytes(newer)
        package.write_text(json.dumps({"name": "@yylo/cli", "version": "2.1.4"}) + "\n")
        newer_hash = hashlib.sha256(newer).hexdigest()
        inventory.parent.mkdir(parents=True, exist_ok=True)
        inventory.write_text(json.dumps({
            "schemaVersion": 1, "packageName": "@yylo/cli", "packageVersion": "2.1.4",
            "assets": {task_runtime.RUNTIME_PATH: {
                "type": "script", "templateVersion": "2.1.4",
                "sourceSha256": newer_hash, "installedSha256": newer_hash,
            }},
        }) + "\n")
        git(self.repository, "add", task_runtime.RUNTIME_PATH,
            "juno-code/src/templates/scripts/task_workspace.py", "juno-code/package.json",
            task_runtime.MANAGED_INVENTORY_PATH)
        git(self.repository, "commit", "-m", "coherent newer source generation")

        refused = self.command("start", "X", check=False)
        self.assertIn("controller package/runtime matching that target", refused.stderr)
        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError,
                                    "upgrade or rebind the controller package/runtime"):
            task_runtime.runtime_bootstrap(
                self.controller, "2.1.3", hashlib.sha256(SCRIPT.read_bytes()).hexdigest(), None)
        self.assertFalse((self.controller / task_runtime.RUNTIME_BOOTSTRAP_ROOT).exists())

    def test_runtime_bootstrap_rejects_self_asserted_inventory_customization(self) -> None:
        customized = b"#!/usr/bin/env python3\n# operator customization\n"
        runtime = self.repository / task_runtime.RUNTIME_PATH
        runtime.write_bytes(customized)
        claimed = hashlib.sha256(customized).hexdigest()
        inventory = self.repository / task_runtime.MANAGED_INVENTORY_PATH
        inventory.parent.mkdir(parents=True, exist_ok=True)
        inventory.write_text(json.dumps({
            "schemaVersion": 1, "packageName": "@yylo/cli", "packageVersion": "2.1.2",
            "assets": {task_runtime.RUNTIME_PATH: {
                "type": "script", "templateVersion": "2.1.2",
                "sourceSha256": claimed, "installedSha256": claimed,
            }},
        }) + "\n")
        git(self.repository, "add", task_runtime.RUNTIME_PATH, task_runtime.MANAGED_INVENTORY_PATH)
        git(self.repository, "commit", "-m", "self-assert customized runtime inventory")
        package_hash = hashlib.sha256(SCRIPT.read_bytes()).hexdigest()
        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError,
                                    "template/runtime identity is inconsistent"):
            task_runtime.runtime_bootstrap(self.controller, "2.1.3", package_hash, None)

    def test_runtime_bootstrap_rejects_redigested_noncanonical_inventory_receipt(self) -> None:
        self.install_stale_consumer_runtime()
        package_hash = hashlib.sha256(SCRIPT.read_bytes()).hexdigest()
        plan = task_runtime.runtime_bootstrap(self.controller, "2.1.3", package_hash, None)
        receipt = Path(plan["receipt"]["path"])
        payload = json.loads(receipt.read_text())
        payload["proposed"]["inventory"] = None
        raw = (json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n").encode()
        digest = hashlib.sha256(raw).hexdigest()
        forged = receipt.with_name(f"{digest}-plan.json")
        forged.write_bytes(raw)
        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError,
                                    "not derived from bound prior/package bytes"):
            task_runtime.runtime_bootstrap(self.controller, "2.1.3", package_hash, forged)

    def test_runtime_bootstrap_rejects_malformed_nested_prior_receipt(self) -> None:
        self.install_stale_consumer_runtime()
        package_hash = hashlib.sha256(SCRIPT.read_bytes()).hexdigest()
        plan = task_runtime.runtime_bootstrap(self.controller, "2.1.3", package_hash, None)
        receipt = Path(plan["receipt"]["path"])
        payload = json.loads(receipt.read_text())
        payload["prior"] = None
        raw = (json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n").encode()
        digest = hashlib.sha256(raw).hexdigest()
        forged = receipt.with_name(f"{digest}-plan.json")
        forged.write_bytes(raw)
        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError,
                                    "receipt/controller/package identity mismatch"):
            task_runtime.runtime_bootstrap(self.controller, "2.1.3", package_hash, forged)

    def test_runtime_bootstrap_rejects_malformed_nested_target_receipt(self) -> None:
        self.install_stale_consumer_runtime()
        package_hash = hashlib.sha256(SCRIPT.read_bytes()).hexdigest()
        plan = task_runtime.runtime_bootstrap(self.controller, "2.1.3", package_hash, None)
        receipt = Path(plan["receipt"]["path"])
        payload = json.loads(receipt.read_text())
        payload["target"] = None
        raw = (json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n").encode()
        digest = hashlib.sha256(raw).hexdigest()
        forged = receipt.with_name(f"{digest}-plan.json")
        forged.write_bytes(raw)
        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError,
                                    "receipt/controller/package identity mismatch"):
            task_runtime.runtime_bootstrap(self.controller, "2.1.3", package_hash, forged)

    def test_runtime_bootstrap_recovers_post_cas_completion_record_failure(self) -> None:
        self.remove_runtime_for_consumer()
        package_hash = hashlib.sha256(SCRIPT.read_bytes()).hexdigest()
        plan = task_runtime.runtime_bootstrap(self.controller, "2.1.3", package_hash, None)
        receipt = Path(plan["receipt"]["path"])
        original_write = task_runtime._write_runtime_bootstrap_record
        injected = {"failed": False}

        def fail_completion(path: Path, payload: dict):
            if path.name.endswith("-completion-durable.json") and not injected["failed"]:
                injected["failed"] = True
                raise OSError("injected completion fsync failure")
            return original_write(path, payload)

        with mock.patch.object(task_runtime, "_write_runtime_bootstrap_record",
                               side_effect=fail_completion):
            with self.assertRaisesRegex(task_runtime.TaskWorkspaceError,
                                        "target CAS completed.*rerun"):
                task_runtime.runtime_bootstrap(
                    self.controller, "2.1.3", package_hash, receipt)
        advanced = git(self.repository, "rev-parse", "refs/heads/product")
        self.assertNotEqual(advanced, plan["target"]["sha"])
        record_root = self.controller / task_runtime.RUNTIME_BOOTSTRAP_ROOT
        self.assertTrue((record_root / f'{plan["receipt"]["sha256"]}-apply-intent.json').is_file())
        self.assertTrue((record_root / f'{plan["receipt"]["sha256"]}-applied.json').is_file())
        self.assertFalse((record_root / f'{plan["receipt"]["sha256"]}-completion-durable.json').exists())

        recovered = task_runtime.runtime_bootstrap(
            self.controller, "2.1.3", package_hash, receipt)
        self.assertEqual(recovered["commit_sha"], advanced)
        self.assertEqual(recovered["outcome"], "completed")
        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError, "already been applied"):
            task_runtime.runtime_bootstrap(self.controller, "2.1.3", package_hash, receipt)

    def test_runtime_bootstrap_recovers_prepared_holder_after_cas_interruption(self) -> None:
        self.remove_runtime_for_consumer()
        package_hash = hashlib.sha256(SCRIPT.read_bytes()).hexdigest()
        plan = task_runtime.runtime_bootstrap(self.controller, "2.1.3", package_hash, None)
        receipt = Path(plan["receipt"]["path"])
        original_run = task_runtime.run
        injected = {"failed": False}

        def interrupt_cas_after_prepare(argv: list[str], cwd: Path, *, check: bool = True):
            if (len(argv) >= 7 and argv[-4] == "update-ref"
                    and argv[-3] == "refs/heads/product" and not injected["failed"]):
                # Reproduce interruption after exact index/worktree preparation
                # but before expected-old-SHA CAS advances the ref.
                injected["failed"] = True
                return subprocess.CompletedProcess(argv, 75, "",
                                                   "injected pre-CAS interruption")
            return original_run(argv, cwd, check=check)

        with mock.patch.object(task_runtime, "run", side_effect=interrupt_cas_after_prepare):
            with self.assertRaisesRegex(task_runtime.TaskWorkspaceError,
                                        "CAS advancement failed"):
                task_runtime.runtime_bootstrap(
                    self.controller, "2.1.3", package_hash, receipt)
        self.assertEqual(git(self.repository, "rev-parse", "refs/heads/product"),
                         plan["target"]["sha"])
        self.assertEqual(git(self.repository, "rev-parse", "HEAD"), plan["target"]["sha"])
        self.assertEqual(git(self.repository, "status", "--porcelain=v1").splitlines(),
                         [f"A  {task_runtime.MANAGED_INVENTORY_PATH}",
                          f"A  {task_runtime.RUNTIME_PATH}"])

        recovered = task_runtime.runtime_bootstrap(
            self.controller, "2.1.3", package_hash, receipt)
        self.assertNotEqual(recovered["commit_sha"], plan["target"]["sha"])
        self.assertEqual(git(self.repository, "rev-parse", "HEAD"), recovered["commit_sha"])
        self.assertEqual(git(self.repository, "status", "--porcelain=v1"), "")

    def test_runtime_bootstrap_gives_exact_recovery_for_partial_two_path_preparation(self) -> None:
        self.install_stale_consumer_runtime()
        package_hash = hashlib.sha256(SCRIPT.read_bytes()).hexdigest()
        plan = task_runtime.runtime_bootstrap(self.controller, "2.1.3", package_hash, None)
        proposed_inventory = base64.b64decode(
            plan["proposed"]["inventory"]["bytes_base64"], validate=True)
        (self.repository / task_runtime.MANAGED_INVENTORY_PATH).write_bytes(proposed_inventory)
        self.assertEqual(
            run(["git", "-C", str(self.repository), "status", "--porcelain=v1"],
                self.repository).stdout.rstrip("\n"),
            f" M {task_runtime.MANAGED_INVENTORY_PATH}")
        self.assertEqual(
            base64.b64decode(plan["prior"]["inventory_bytes_base64"], validate=True),
            subprocess.run(
                ["git", "-C", str(self.repository), "show",
                 f":{task_runtime.MANAGED_INVENTORY_PATH}"],
                stdout=subprocess.PIPE, check=True).stdout)

        self.assertTrue(task_runtime._holder_dirt_matches_interrupted_runtime_sync(
            self.repository, plan["prior"], SCRIPT.read_bytes(), proposed_inventory))
        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError,
                                    "exact package-created partial state.*git restore"):
            task_runtime._prepare_target_holder_for_cas(
                self.repository, "refs/heads/product", plan["target"]["sha"],
                "f" * 40, plan["prior"], SCRIPT.read_bytes(), proposed_inventory)
        self.assertEqual((self.repository / task_runtime.RUNTIME_PATH).read_bytes(),
                         base64.b64decode(plan["prior"]["bytes_base64"], validate=True))
        self.assertEqual((self.repository / task_runtime.MANAGED_INVENTORY_PATH).read_bytes(),
                         proposed_inventory)

    def test_runtime_bootstrap_recovers_target_holder_index_lock_without_hidden_mutation(self) -> None:
        self.remove_runtime_for_consumer()
        package_hash = hashlib.sha256(SCRIPT.read_bytes()).hexdigest()
        plan = task_runtime.runtime_bootstrap(self.controller, "2.1.3", package_hash, None)
        receipt = Path(plan["receipt"]["path"])
        before = git(self.repository, "rev-parse", "HEAD")
        index_lock = Path(git(self.repository, "rev-parse", "--path-format=absolute",
                              "--git-path", "index.lock"))
        index_lock.write_text("held\n")
        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError,
                                    "index is locked.*before target CAS"):
            task_runtime.runtime_bootstrap(self.controller, "2.1.3", package_hash, receipt)
        self.assertEqual(git(self.repository, "rev-parse", "HEAD"), before)
        self.assertEqual(git(self.repository, "status", "--porcelain=v1"), "")
        index_lock.unlink()
        recovered = task_runtime.runtime_bootstrap(
            self.controller, "2.1.3", package_hash, receipt)
        self.assertEqual(git(self.repository, "rev-parse", "HEAD"), recovered["commit_sha"])
        self.assertEqual(git(self.repository, "status", "--porcelain=v1"), "")

    def test_runtime_bootstrap_refuses_missing_runtime_with_divergent_juno_source(self) -> None:
        git(self.repository, "rm", task_runtime.RUNTIME_PATH)
        source = self.repository / "juno-code/src/templates/scripts/task_workspace.py"
        source.write_text("# divergent source customization\n")
        git(self.repository, "add", str(source.relative_to(self.repository)))
        git(self.repository, "commit", "-m", "missing runtime with divergent source")
        package_hash = hashlib.sha256(SCRIPT.read_bytes()).hexdigest()
        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError,
                                    "upgrade or rebind the controller package/runtime"):
            task_runtime.runtime_bootstrap(self.controller, "2.1.3", package_hash, None)

    def test_runtime_bootstrap_does_not_classify_staged_deletion_as_interruption(self) -> None:
        prior = (self.repository / task_runtime.RUNTIME_PATH).read_bytes()
        git(self.repository, "rm", task_runtime.RUNTIME_PATH)
        state = {"bytes_base64": base64.b64encode(prior).decode()}
        self.assertFalse(task_runtime._holder_dirt_matches_interrupted_runtime_sync(
            self.repository, state, SCRIPT.read_bytes()))

    def test_runtime_bootstrap_recovers_its_deterministic_guard_after_interruption(self) -> None:
        self.remove_runtime_for_consumer()
        package_hash = hashlib.sha256(SCRIPT.read_bytes()).hexdigest()
        plan = task_runtime.runtime_bootstrap(self.controller, "2.1.3", package_hash, None)
        receipt = Path(plan["receipt"]["path"])
        git(self.repository, "checkout", "--detach")
        original_run = task_runtime.run

        def strand_guard(argv: list[str], cwd: Path, *, check: bool = True):
            if len(argv) >= 7 and argv[-4] == "update-ref":
                return subprocess.CompletedProcess(argv, 75, "", "injected CAS interruption")
            if len(argv) >= 6 and argv[-2] == "remove":
                return subprocess.CompletedProcess(argv, 75, "", "injected process-death residue")
            return original_run(argv, cwd, check=check)

        with mock.patch.object(task_runtime, "run", side_effect=strand_guard):
            with self.assertRaisesRegex(task_runtime.TaskWorkspaceError,
                                        "CAS advancement failed"):
                task_runtime.runtime_bootstrap(
                    self.controller, "2.1.3", package_hash, receipt)
        digest = plan["receipt"]["sha256"]
        guard = (Path(task_runtime.load_config(self.controller)["workspace_root"]) /
                 f".yy-task-runtime-bootstrap-guard-{digest}").resolve()
        self.assertTrue(guard.is_dir())

        recovered = task_runtime.runtime_bootstrap(
            self.controller, "2.1.3", package_hash, receipt)
        self.assertEqual(git(self.repository, "rev-parse", "refs/heads/product"),
                         recovered["commit_sha"])
        self.assertFalse(guard.exists())

    def test_runtime_bootstrap_guard_refuses_holder_appearance_through_completion(self) -> None:
        self.remove_runtime_for_consumer()
        package_hash = hashlib.sha256(SCRIPT.read_bytes()).hexdigest()
        plan = task_runtime.runtime_bootstrap(self.controller, "2.1.3", package_hash, None)
        receipt = Path(plan["receipt"]["path"])
        git(self.repository, "checkout", "--detach")
        appeared = self.root / "appeared-target-holder"
        original_run = task_runtime.run
        injected = {"done": False, "returncode": None}

        def attempt_holder_before_cas(argv: list[str], cwd: Path, *, check: bool = True):
            if (len(argv) >= 7 and argv[-4] == "update-ref"
                    and argv[-3] == "refs/heads/product" and not injected["done"]):
                attempt = original_run(
                    ["git", "-C", str(self.repository), "worktree", "add",
                     str(appeared), "product"], self.repository, check=False)
                injected.update(done=True, returncode=attempt.returncode)
            return original_run(argv, cwd, check=check)

        with mock.patch.object(task_runtime, "run", side_effect=attempt_holder_before_cas):
            applied = task_runtime.runtime_bootstrap(
                self.controller, "2.1.3", package_hash, receipt)
        self.assertTrue(injected["done"])
        self.assertNotEqual(injected["returncode"], 0)
        self.assertFalse(appeared.exists())
        self.assertNotEqual(applied["commit_sha"], plan["target"]["sha"])
        record_root = self.controller / task_runtime.RUNTIME_BOOTSTRAP_ROOT
        self.assertTrue((record_root / f'{plan["receipt"]["sha256"]}-applied.json').is_file())
        self.assertEqual(task_runtime._target_ref_holders(
            self.repository, "refs/heads/product"), [])

    def test_runtime_bootstrap_preserves_destination_dirt_racing_holder_preparation(self) -> None:
        self.remove_runtime_for_consumer()
        package_hash = hashlib.sha256(SCRIPT.read_bytes()).hexdigest()
        plan = task_runtime.runtime_bootstrap(self.controller, "2.1.3", package_hash, None)
        receipt = Path(plan["receipt"]["path"])
        before = git(self.repository, "rev-parse", "HEAD")
        original_run = task_runtime.run
        injected = {"done": False}
        dirt = b"CONCURRENT USER DIRT\n"

        def inject_before_non_destructive_read_tree(
                argv: list[str], cwd: Path, *, check: bool = True):
            if (len(argv) >= 7 and argv[-3:-1] == ["-m", "-u"]
                    and not injected["done"]):
                destination = self.repository / task_runtime.RUNTIME_PATH
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(dirt)
                injected["done"] = True
            return original_run(argv, cwd, check=check)

        with mock.patch.object(task_runtime, "run",
                               side_effect=inject_before_non_destructive_read_tree):
            with self.assertRaisesRegex(task_runtime.TaskWorkspaceError,
                                        "synchronization was interrupted before CAS"):
                task_runtime.runtime_bootstrap(
                    self.controller, "2.1.3", package_hash, receipt)
        self.assertEqual(git(self.repository, "rev-parse", "HEAD"), before)
        self.assertEqual((self.repository / task_runtime.RUNTIME_PATH).read_bytes(), dirt)

    def test_runtime_bootstrap_refuses_holder_dirt_racing_final_pre_cas_revalidation(self) -> None:
        self.remove_runtime_for_consumer()
        package_hash = hashlib.sha256(SCRIPT.read_bytes()).hexdigest()
        plan = task_runtime.runtime_bootstrap(self.controller, "2.1.3", package_hash, None)
        receipt = Path(plan["receipt"]["path"])
        before = git(self.repository, "rev-parse", "HEAD")
        original_holders = task_runtime._target_ref_holders
        calls = {"count": 0}

        def race_dirt(repository: Path, target_ref: str):
            calls["count"] += 1
            holders = original_holders(repository, target_ref)
            if calls["count"] == 2:
                (self.repository / "raced-unrelated.txt").write_text("preserve me\n")
            return holders

        with mock.patch.object(task_runtime, "_target_ref_holders",
                               side_effect=race_dirt):
            with self.assertRaisesRegex(task_runtime.TaskWorkspaceError,
                                        "holder became dirty before synchronization|holder raced before target CAS"):
                task_runtime.runtime_bootstrap(
                    self.controller, "2.1.3", package_hash, receipt)
        self.assertEqual(git(self.repository, "rev-parse", "HEAD"), before)
        self.assertEqual((self.repository / "raced-unrelated.txt").read_text(), "preserve me\n")

    def test_runtime_bootstrap_contends_on_merge_queue_target_lock(self) -> None:
        self.remove_runtime_for_consumer()
        package_hash = hashlib.sha256(SCRIPT.read_bytes()).hexdigest()
        plan = task_runtime.runtime_bootstrap(self.controller, "2.1.3", package_hash, None)
        receipt = Path(plan["receipt"]["path"])
        before = git(self.repository, "rev-parse", "HEAD")
        common = Path(git(self.repository, "rev-parse", "--path-format=absolute",
                          "--git-common-dir")).resolve()
        key = hashlib.sha256(f"{common}\0refs/heads/product".encode()).hexdigest()
        lock_path = common / "juno-locks/merge-queue" / f"{key}.lock"
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        with lock_path.open("a+b") as handle:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(task_runtime.TaskWorkspaceError,
                                        "another worker owns.*target-ref queue"):
                task_runtime.runtime_bootstrap(
                    self.controller, "2.1.3", package_hash, receipt)
        self.assertEqual(git(self.repository, "rev-parse", "HEAD"), before)
        self.assertEqual(git(self.repository, "status", "--porcelain=v1"), "")

    def test_runtime_bootstrap_refuses_dirty_or_multiple_target_holders_without_mutation(self) -> None:
        self.remove_runtime_for_consumer()
        package_hash = hashlib.sha256(SCRIPT.read_bytes()).hexdigest()
        plan = task_runtime.runtime_bootstrap(self.controller, "2.1.3", package_hash, None)
        receipt = Path(plan["receipt"]["path"])
        before = git(self.repository, "rev-parse", "HEAD")

        dirty = self.repository / "holder-dirty.tmp"
        dirty.write_text("dirty\n")
        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError, "dirty"):
            task_runtime.runtime_bootstrap(self.controller, "2.1.3", package_hash, receipt)
        self.assertEqual(git(self.repository, "rev-parse", "HEAD"), before)
        dirty.unlink()
        self.assertEqual(git(self.repository, "status", "--porcelain=v1"), "")

        duplicate = self.root / "duplicate-target-holder"
        run(["git", "-C", str(self.repository), "worktree", "add", "--force", "--force",
             str(duplicate), "product"], self.repository)
        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError, "multiple checked-out holders"):
            task_runtime.runtime_bootstrap(self.controller, "2.1.3", package_hash, receipt)
        self.assertEqual(git(self.repository, "rev-parse", "HEAD"), before)
        self.assertEqual(git(duplicate, "rev-parse", "HEAD"), before)
        self.assertEqual(git(self.repository, "status", "--porcelain=v1"), "")
        self.assertEqual(git(duplicate, "status", "--porcelain=v1"), "")

        git(self.repository, "switch", "--detach")
        git(self.repository, "worktree", "lock", str(duplicate))
        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError, "holder is locked"):
            task_runtime.runtime_bootstrap(self.controller, "2.1.3", package_hash, receipt)
        self.assertEqual(git(self.repository, "rev-parse", "refs/heads/product"), before)
        self.assertEqual(git(duplicate, "rev-parse", "HEAD"), before)
        self.assertEqual(git(duplicate, "status", "--porcelain=v1"), "")

    def test_runtime_bootstrap_refuses_invalid_policy_registration_or_role(self) -> None:
        package_hash = hashlib.sha256(SCRIPT.read_bytes()).hexdigest()
        policy_path = self.controller / ".juno_task/config/metadata-controller.json"
        original_policy = policy_path.read_bytes()
        policy = json.loads(original_policy)
        policy["unexpected"] = True
        policy_path.write_text(json.dumps(policy) + "\n")
        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError,
                                    "valid metadata-controller policy"):
            task_runtime.runtime_bootstrap(self.controller, "2.1.3", package_hash, None)
        policy_path.write_bytes(original_policy)

        git(self.controller, "config", "--local", "--unset-all", "juno.controller.path")
        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError,
                                    "controller registration"):
            task_runtime.runtime_bootstrap(self.controller, "2.1.3", package_hash, None)
        git(self.controller, "config", "--local", "juno.controller.path", str(self.controller))

        git(self.controller, "config", "--worktree", "juno.workspace.role", "task")
        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError,
                                    "registration|workspace role|registered metadata-only"):
            task_runtime.runtime_bootstrap(self.controller, "2.1.3", package_hash, None)
        git(self.controller, "config", "--worktree", "juno.workspace.role", "controller")

    def test_orphan_metadata_only_controller_runtime_bootstrap_without_sparse_checkout(self) -> None:
        git(self.controller, "sparse-checkout", "disable")
        tree = git(self.controller, "rev-parse", "HEAD^{tree}")
        previous = git(self.controller, "rev-parse", "HEAD")
        orphan = run(["git", "-C", str(self.controller), "commit-tree", tree,
                      "-m", "orphan metadata-only controller"], self.controller).stdout.strip()
        run(["git", "-C", str(self.controller), "update-ref", "refs/heads/controller",
             orphan, previous], self.controller)
        git(self.controller, "reset", "--hard", orphan)
        self.assertNotEqual(
            run(["git", "-C", str(self.controller), "config", "--bool",
                 "core.sparseCheckout"], self.controller, False).stdout.strip(), "true")
        self.assertEqual(git(self.controller, "rev-list", "--parents", "-n", "1", "HEAD"), orphan)

        self.remove_runtime_for_consumer()
        package_hash = hashlib.sha256(SCRIPT.read_bytes()).hexdigest()
        plan = task_runtime.runtime_bootstrap(self.controller, "2.1.3", package_hash, None)
        self.assertEqual(plan["controller_identity"]["controller_class"]["controller_branch"],
                         "refs/heads/controller")
        self.assertEqual(plan["controller_identity"]["controller_class"]["checks"],
                         ["branch_exact", "product_absent", "role", "tracked_boundary"])

    def test_consumer_runtime_provenance_plan_apply_unblocks_start_and_preserves_controller_dirt(self) -> None:
        package_root = self.root / "installed/node_modules/yylo"
        executable = package_root / "dist/bin/cli.mjs"
        package_runtime = package_root / "dist/templates/scripts/task_workspace.py"
        manifest = package_root / "dist/templates/managed-assets.json"
        for path in (executable, package_runtime, manifest):
            path.parent.mkdir(parents=True, exist_ok=True)
        executable.write_bytes(b"exact installed yy executable\n")
        package_runtime.write_bytes(SCRIPT.read_bytes())
        manifest.write_text(json.dumps({"schemaVersion": 1, "assets": [{
            "source": "scripts/task_workspace.py",
            "destination": task_runtime.RUNTIME_PATH,
            "installClass": "script", "type": "script",
        }]}) + "\n")
        (package_root / "package.json").write_text(json.dumps({
            "name": "@yylo/cli", "version": "2.1.2",
        }) + "\n")
        identity = self.controller / task_runtime.IDENTITY_PATH if hasattr(
            task_runtime, "IDENTITY_PATH") else self.controller / ".juno_task/runtime/identity.json"
        identity.parent.mkdir(parents=True, exist_ok=True)
        identity.write_text(json.dumps({
            "package": "@yylo/cli", "version": "2.1.2",
            "executable": str(executable),
            "executable_sha256": hashlib.sha256(executable.read_bytes()).hexdigest(),
            "source": "installed-release", "tracked": False,
        }) + "\n")
        git(self.repository, "rm", "juno-code/src/templates/scripts/task_workspace.py",
            "juno-code/package.json")
        git(self.repository, "commit", "-m", "legacy consumer runtime without provenance")
        before = git(self.repository, "rev-parse", "refs/heads/product")

        exclude = Path(git(self.controller, "rev-parse", "--path-format=absolute",
                           "--git-path", "info/exclude"))
        with exclude.open("a") as handle:
            handle.write("\n.juno_task/.version_check_cache\n.juno_task/managed-assets.json\n"
                         ".juno_task/runtime/managed-controller/generation.json\n")
        unrelated = self.controller / ".juno_task/.version_check_cache"
        unrelated.write_bytes(b"preserve unrelated controller dirt exactly\n")
        unrelated_hash = hashlib.sha256(unrelated.read_bytes()).hexdigest()

        refused = self.command("start", "X", check=False)
        self.assertEqual(refused.returncode, 2)
        self.assertIn("yy migrate target-runtime-provenance plan --controller", refused.stderr)
        self.assertFalse((self.workspaces / "X").exists())

        plan_path = self.root / "provenance-plan.json"
        plan = provenance_runtime.plan_command(self.controller, plan_path)
        self.assertEqual(git(self.repository, "rev-parse", "refs/heads/product"), before)
        self.assertEqual(plan["repository"]["common_dir"], str(Path(git(
            self.repository, "rev-parse", "--path-format=absolute", "--git-common-dir")).resolve()))
        self.assertEqual(plan["target"]["tree"], git(self.repository, "rev-parse", f"{before}^{{tree}}"))
        self.assertEqual(plan["package"]["version"], "2.1.2")
        self.assertEqual(plan["prior"]["inventory"]["classification"], "missing")
        self.assertFalse(plan["managed_runtime"]["inventory"]["present"])
        self.assertFalse(plan["managed_runtime"]["generation"]["present"])
        self.assertRegex(plan["task_policy"]["sha256"], r"^[0-9a-f]{64}$")
        self.assertEqual(hashlib.sha256(unrelated.read_bytes()).hexdigest(), unrelated_hash)

        tampered = self.root / "tampered-plan.json"
        tampered.write_bytes(plan_path.read_bytes() + b" ")
        with self.assertRaisesRegex(provenance_runtime.ProvenanceError, "stale or tampered"):
            provenance_runtime.apply_command(tampered, self.root / "tampered-apply.json")
        self.assertEqual(git(self.repository, "rev-parse", "refs/heads/product"), before)

        dirty = self.repository / "unrelated-target-owner-dirt.tmp"
        dirty.write_text("preserve me\n")
        with self.assertRaisesRegex(provenance_runtime.ProvenanceError, "dirty or ambiguous"):
            provenance_runtime.apply_command(plan_path, self.root / "dirty-apply.json")
        self.assertEqual(dirty.read_text(), "preserve me\n")
        dirty.unlink()

        identity_bytes = identity.read_bytes()
        identity_value = json.loads(identity_bytes)
        identity_value["executable_sha256"] = "f" * 64
        identity.write_text(json.dumps(identity_value) + "\n")
        with self.assertRaisesRegex(provenance_runtime.ProvenanceError,
                                    "installed yylo executable"):
            provenance_runtime.apply_command(plan_path, self.root / "identity-apply.json")
        identity.write_bytes(identity_bytes)

        controller_inventory = self.controller / task_runtime.MANAGED_INVENTORY_PATH
        controller_inventory.write_text(json.dumps({
            "schemaVersion": 1, "packageName": "@yylo/cli", "packageVersion": "9.9.9",
            "assets": {},
        }) + "\n")
        with self.assertRaisesRegex(provenance_runtime.ProvenanceError,
                                    "managed inventory mismatches"):
            provenance_runtime.apply_command(plan_path, self.root / "inventory-apply.json")
        controller_inventory.unlink()

        generation = self.controller / provenance_runtime.GENERATION_PATH
        generation.parent.mkdir(parents=True, exist_ok=True)
        generation.write_text(json.dumps({
            "schema_version": "juno_managed_controller_runtime.v1",
            "package_version": "9.9.9", "scripts": {}, "target_sha": "a" * 40,
        }) + "\n")
        with self.assertRaisesRegex(provenance_runtime.ProvenanceError,
                                    "generation mismatches"):
            provenance_runtime.apply_command(plan_path, self.root / "generation-apply.json")
        generation.unlink()

        manifest_bytes = manifest.read_bytes()
        manifest_value = json.loads(manifest_bytes)
        manifest_value["assets"].append(dict(manifest_value["assets"][0]))
        manifest.write_text(json.dumps(manifest_value) + "\n")
        with self.assertRaisesRegex(provenance_runtime.ProvenanceError, "ambiguous"):
            provenance_runtime.apply_command(plan_path, self.root / "ambiguous-apply.json")
        manifest.write_bytes(manifest_bytes)

        lock_path = self.controller / ".juno_task/runtime/task-workspace.lock"
        with lock_path.open("a+b") as lock_handle:
            fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(provenance_runtime.ProvenanceError, "concurrent"):
                provenance_runtime.apply_command(plan_path, self.root / "concurrent-apply.json")

        moved = git(self.repository, "rev-parse", f"{before}^")
        run(["git", "-C", str(self.repository), "update-ref", "refs/heads/product", moved, before],
            self.repository)
        with self.assertRaisesRegex(provenance_runtime.ProvenanceError, "moved"):
            provenance_runtime.apply_command(plan_path, self.root / "moved-apply.json")
        run(["git", "-C", str(self.repository), "update-ref", "refs/heads/product", before, moved],
            self.repository)

        git(self.controller, "config", "--worktree", "juno.workspace.role", "task")
        with self.assertRaisesRegex(Exception, "role|registration|metadata-only"):
            provenance_runtime.plan_command(self.controller, self.root / "wrong-role-plan.json")
        git(self.controller, "config", "--worktree", "juno.workspace.role", "controller")
        self.assertEqual(git(self.repository, "rev-parse", "refs/heads/product"), before)
        self.assertEqual(hashlib.sha256(unrelated.read_bytes()).hexdigest(), unrelated_hash)

        git(self.repository, "switch", "--detach")
        applied = provenance_runtime.apply_command(plan_path, self.root / "provenance-apply.json")
        self.assertEqual(applied["changed_paths"], [task_runtime.MANAGED_INVENTORY_PATH])
        self.assertEqual(git(self.repository, "diff-tree", "--no-commit-id", "--name-only",
                             "-r", applied["commit_sha"]), task_runtime.MANAGED_INVENTORY_PATH)
        self.assertEqual(hashlib.sha256(unrelated.read_bytes()).hexdigest(), unrelated_hash)
        started = self.payload("start", "X")
        self.assertEqual(started["outcome"], "started")
        self.assertTrue(started["creation_receipt"]["runtime_generation"]
                        ["managed_inventory_provenance"])

        idempotent = provenance_runtime.apply_command(
            plan_path, self.root / "provenance-apply-idempotent.json")
        self.assertEqual(idempotent["outcome"], "already_applied")
        self.assertEqual(idempotent["commit_sha"], applied["commit_sha"])
        self.assertEqual(hashlib.sha256(unrelated.read_bytes()).hexdigest(), unrelated_hash)
    def test_runtime_bootstrap_recovers_exact_registered_legacy_consumer_runtime(self) -> None:
        fixture = self.install_legacy_consumer_runtime()
        package_hash = hashlib.sha256(SCRIPT.read_bytes()).hexdigest()
        plan = task_runtime.runtime_bootstrap(
            self.controller, "2.1.3-rc.0.10", package_hash, None)
        self.assertEqual(
            plan["prior"]["classification"],
            "exact_registered_legacy_installed_consumer_generation")
        self.assertEqual(plan["prior"]["package_version"], "2.1.2")
        self.assertEqual(plan["prior"]["legacy_runtime"]["executable"],
                         str(Path(fixture["executable"]).resolve()))
        self.assertEqual(plan["prior"]["legacy_runtime"]["template_sha256"],
                         hashlib.sha256(fixture["legacy"]).hexdigest())
        applied = task_runtime.runtime_bootstrap(
            self.controller, "2.1.3-rc.0.10", package_hash,
            Path(plan["receipt"]["path"]))
        self.assertEqual(applied["outcome"], "completed")
        self.assertEqual((self.repository / task_runtime.RUNTIME_PATH).read_bytes(),
                         SCRIPT.read_bytes())
        self.assertTrue(Path(fixture["identity"]).is_file())

    def test_runtime_bootstrap_retains_exact_prefixed_legacy_version_output(self) -> None:
        self.install_legacy_consumer_runtime(output_shape="release")
        package_hash = hashlib.sha256(SCRIPT.read_bytes()).hexdigest()
        plan = task_runtime.runtime_bootstrap(
            self.controller, "2.1.3-rc.0.10", package_hash, None)
        self.assertEqual(plan["prior"]["package_version"], "2.1.2")

    def test_runtime_bootstrap_accepts_current_bare_machine_version_output(self) -> None:
        self.install_legacy_consumer_runtime(output_shape="machine")
        package_hash = hashlib.sha256(SCRIPT.read_bytes()).hexdigest()
        plan = task_runtime.runtime_bootstrap(
            self.controller, "2.1.3-rc.0.10", package_hash, None)
        self.assertEqual(plan["prior"]["package_version"], "2.1.2")

    def test_runtime_bootstrap_refuses_noncanonical_legacy_version_output(self) -> None:
        fixture = self.install_legacy_consumer_runtime()
        executable = Path(fixture["executable"])
        canonical_banner = (
            "\n🎯 YYLO v2.1.2 - TypeScript CLI\n"
            "   Node.js v22.22.3 on darwin\n"
            f"   Working directory: {executable.parent.resolve()}\n\n"
        )
        cases = {
            "wrong version": ("2.1.1\n", canonical_banner.replace("v2.1.2", "v2.1.1")),
            "malformed banner": ("2.1.2\n", canonical_banner.replace("Node.js", "Node")),
            "ambiguous stdout": ("2.1.2\nyylo 2.1.2\n", canonical_banner),
            "unexpected stderr": ("2.1.2\n", canonical_banner + "unexpected\n"),
        }
        package_hash = hashlib.sha256(SCRIPT.read_bytes()).hexdigest()
        for label, (stdout, stderr) in cases.items():
            with self.subTest(label=label):
                self.set_legacy_version_output(fixture, stdout, stderr)
                with self.assertRaisesRegex(task_runtime.TaskWorkspaceError,
                                            "version output mismatched"):
                    task_runtime.runtime_bootstrap(
                        self.controller, "2.1.3-rc.0.10", package_hash, None)

    def test_runtime_bootstrap_receipt_binds_exact_legacy_identity_bytes(self) -> None:
        package_hash = hashlib.sha256(SCRIPT.read_bytes()).hexdigest()
        fixture = self.install_legacy_consumer_runtime()
        plan = task_runtime.runtime_bootstrap(
            self.controller, "2.1.3-rc.0.10", package_hash, None)
        identity_path = Path(fixture["identity"])
        identity_path.write_bytes(identity_path.read_bytes() + b" ")
        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError,
                                    "bound target prior state does not match"):
            task_runtime.runtime_bootstrap(
                self.controller, "2.1.3-rc.0.10", package_hash,
                Path(plan["receipt"]["path"]))
        self.assertEqual(git(self.repository, "rev-parse", "refs/heads/product"),
                         plan["target"]["sha"])

    def test_runtime_bootstrap_refuses_missing_tampered_and_stale_legacy_identity(self) -> None:
        package_hash = hashlib.sha256(SCRIPT.read_bytes()).hexdigest()
        fixture = self.install_legacy_consumer_runtime()
        identity_path = Path(fixture["identity"])
        identity_bytes = identity_path.read_bytes()
        executable = Path(fixture["executable"])
        executable_bytes = executable.read_bytes()

        identity_path.unlink()
        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError,
                                    "installed runtime identity"):
            task_runtime.runtime_bootstrap(
                self.controller, "2.1.3-rc.0.10", package_hash, None)
        identity_path.write_bytes(identity_bytes)

        identity = json.loads(identity_bytes)
        identity["executable_sha256"] = "0" * 64
        identity_path.write_text(json.dumps(identity) + "\n")
        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError, "stale or tampered"):
            task_runtime.runtime_bootstrap(
                self.controller, "2.1.3-rc.0.10", package_hash, None)
        identity_path.write_bytes(identity_bytes)

        executable.write_bytes(executable_bytes + b"# tampered\n")
        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError, "stale or tampered"):
            task_runtime.runtime_bootstrap(
                self.controller, "2.1.3-rc.0.10", package_hash, None)
        executable.write_bytes(executable_bytes); executable.chmod(0o755)

        identity = json.loads(identity_bytes)
        identity["version"] = "2.1.3-rc.0.10"
        identity_path.write_text(json.dumps(identity) + "\n")
        git(self.controller, "config", "--worktree", "juno.controller.runtimeVersion",
            "2.1.3-rc.0.10")
        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError,
                                    "invalid or not older"):
            task_runtime.runtime_bootstrap(
                self.controller, "2.1.3-rc.0.10", package_hash, None)

    def test_runtime_bootstrap_refuses_unmatched_legacy_installed_template(self) -> None:
        package_hash = hashlib.sha256(SCRIPT.read_bytes()).hexdigest()
        fixture = self.install_legacy_consumer_runtime()
        Path(fixture["template"]).write_bytes(b"# customized installed template\n")
        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError,
                                    "does not match.*installed template"):
            task_runtime.runtime_bootstrap(
                self.controller, "2.1.3-rc.0.10", package_hash, None)
    def test_runtime_bootstrap_refuses_product_bearing_metadata_controller(self) -> None:
        git(self.controller, "sparse-checkout", "disable")
        (self.controller / "README.md").write_text("product marker\n")
        git(self.controller, "add", "README.md")
        git(self.controller, "commit", "-m", "inject product path")
        package_hash = hashlib.sha256(SCRIPT.read_bytes()).hexdigest()
        with self.assertRaisesRegex(
                task_runtime.TaskWorkspaceError,
                "metadata-controller boundary failed: product_absent, tracked_boundary"):
            task_runtime.runtime_bootstrap(self.controller, "2.1.3", package_hash, None)

    def test_runtime_bootstrap_refuses_moved_tampered_dirty_and_customized_targets(self) -> None:
        package_hash = hashlib.sha256(SCRIPT.read_bytes()).hexdigest()
        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError, "customized"):
            task_runtime.runtime_bootstrap(self.controller, "2.1.3", package_hash, None)

        self.remove_runtime_for_consumer()
        plan = task_runtime.runtime_bootstrap(self.controller, "2.1.3", package_hash, None)
        receipt = Path(plan["receipt"]["path"])
        original = receipt.read_bytes()
        receipt.write_bytes(original + b" ")
        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError, "immutable identity"):
            task_runtime.runtime_bootstrap(self.controller, "2.1.3", package_hash, receipt)
        receipt.write_bytes(original)

        (self.controller / "dirty.tmp").write_text("dirty\n")
        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError, "dirty"):
            task_runtime.runtime_bootstrap(self.controller, "2.1.3", package_hash, receipt)
        (self.controller / "dirty.tmp").unlink()
        moved = self.advance_target()
        moved_tree = git(self.repository, "rev-parse", "HEAD^{tree}")
        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError, "moved"):
            task_runtime.runtime_bootstrap(self.controller, "2.1.3", package_hash, receipt)
        self.assertEqual(git(self.repository, "rev-parse", "HEAD"), moved)
        self.assertEqual(git(self.repository, "rev-parse", "HEAD^{tree}"), moved_tree)
        self.assertEqual(git(self.repository, "status", "--porcelain=v1"), "")

    def test_hydration_runtime_failure_preserves_manifest_and_retry_is_idempotent(self) -> None:
        workflow = self.repository / ".juno_task/config/worktree-hydration.yaml"
        workflow.parent.mkdir(parents=True, exist_ok=True)
        workflow.write_text("schema_version: v1\nworkflow_class: task_hydration\nsteps: []\n")
        git(self.repository, "add", str(workflow.relative_to(self.repository)))
        git(self.repository, "commit", "-m", "fixture hydration workflow")
        config = task_runtime.load_config(self.controller)
        frozen = task_runtime.hydration_identity(
            self.repository, git(self.repository, "rev-parse", "HEAD"), config)

        fake_runtime = self.root / "fake-runtime/task_workspace.py"
        fake_runtime.parent.mkdir()
        fake_runtime.write_text("# fixture module identity\n")
        marker = self.root / "hydration-installed.marker"
        runner = fake_runtime.with_name("workflow_runner.sh")
        runner.write_text(f"""#!/usr/bin/env python3
import json, pathlib, sys
marker = pathlib.Path({str(marker)!r})
if len(sys.argv) > 1 and sys.argv[1] == 'lint':
    raise SystemExit(0)
out = pathlib.Path(sys.argv[sys.argv.index('--out-dir') + 1])
out.mkdir(parents=True)
if marker.exists():
    (out / 'manifest.json').write_text(json.dumps({{'status': 'success', 'failed_steps': []}}) + '\\n')
    raise SystemExit(0)
marker.write_text('installed\\n')
(out / 'manifest.json').write_text(json.dumps({{'status': 'failed', 'failed_steps': ['install_once']}}) + '\\n')
raise SystemExit(17)
""")
        runner.chmod(0o755)

        with mock.patch.object(task_runtime, "__file__", str(fake_runtime)):
            with self.assertRaises(task_runtime.HydrationFailure) as raised:
                task_runtime.run_task_hydration(
                    self.controller, self.repository, "X", frozen, config)
        evidence = raised.exception.evidence
        self.assertEqual(evidence["failed_stage"], "run")
        self.assertEqual(evidence["exit_code"], 17)
        manifest = Path(evidence["manifest_path"])
        self.assertTrue(manifest.is_file())
        self.assertEqual(
            evidence["manifest_sha256"], hashlib.sha256(manifest.read_bytes()).hexdigest())
        self.assertEqual(json.loads(manifest.read_text())["failed_steps"], ["install_once"])

        with mock.patch.object(task_runtime, "__file__", str(fake_runtime)):
            recovered = task_runtime.run_task_hydration(
                self.controller, self.repository, "X", frozen, config)
        self.assertEqual(recovered["status"], "passed")
        self.assertEqual(json.loads(Path(recovered["manifest_path"]).read_text())["status"], "success")
        self.assertEqual(git(self.repository, "status", "--porcelain=v1"), "")

    # These acceptance flows require the built package binary and are selected
    # explicitly by binary-execution.test.ts. Keeping them out of unittest's
    # default discovery lets ordinary source/runtime validation run in a fresh
    # merge candidate whose ignored dist/ tree is intentionally absent.
    def build_required_public_cli_routes_hydration_retry_with_lint_diagnostics(self) -> None:
        package = json.loads((PACKAGE_ROOT / "package.json").read_text())
        self.assertTrue(PUBLIC_YY.is_file(), f"public yy binary is missing: {PUBLIC_YY}")
        run([str(PUBLIC_YY), "scripts", "update", "--force"], self.controller)
        packaged_executable = PACKAGE_ROOT / "dist/bin/cli.mjs"
        identity = self.controller / ".juno_task/runtime/identity.json"
        identity.parent.mkdir(parents=True, exist_ok=True)
        identity.write_text(json.dumps({
            "package": "@yylo/cli", "version": package["version"],
            "executable": str(packaged_executable),
            "executable_sha256": hashlib.sha256(packaged_executable.read_bytes()).hexdigest(),
            "source": "installed-release", "tracked": False,
        }) + "\n")
        git(self.controller, "config", "--worktree", "juno.controller.runtimeExecutable",
            str(packaged_executable))
        git(self.controller, "config", "--worktree", "juno.controller.runtimeVersion",
            package["version"])

        workflow = self.repository / ".juno_task/config/worktree-hydration.yaml"
        workflow.parent.mkdir(parents=True, exist_ok=True)
        workflow.write_text("""schema_version: v1
workflow_id: hydration-recovery-fixture
workflow_class: task_hydration
steps:
  - id: ready
    name: Verify fixture readiness
    probe: ["true"]
    command: ["true"]
    timeout_seconds: 30
    fail_workflow: true
    non_interactive: true
    network: false
    sensitive: false
    outputs: []
""")
        git(self.repository, "add", str(workflow.relative_to(self.repository)))
        git(self.repository, "commit", "-m", "fixture hydration workflow")
        self.base = git(self.repository, "rev-parse", "HEAD")

        runner = self.controller / ".juno_task/scripts/workflow_runner.sh"
        runner.write_text("""#!/usr/bin/env python3
import json, os, pathlib, sys
if os.environ.get('JUNO_WORKSPACE_ROLE'):
    print('unexpected inherited role=' + os.environ['JUNO_WORKSPACE_ROLE'], file=sys.stderr)
    raise SystemExit(23)
root = pathlib.Path(os.environ['JUNO_TASK_ROOT'])
marker = root / '.juno_task/runtime/hydration-transient-lint'
if len(sys.argv) > 1 and sys.argv[1] == 'lint':
    if not marker.exists():
        marker.parent.mkdir(parents=True, exist_ok=True); marker.write_text('failed once\\n')
        sys.stdout.buffer.write(b'O' * 40000)
        sys.stderr.buffer.write(b'E' * 40000 + b'\\ncausal lint failure\\n')
        raise SystemExit(9)
    print('Workflow lint / OK: no issues found')
    raise SystemExit(0)
out = pathlib.Path(sys.argv[sys.argv.index('--out-dir') + 1])
out.mkdir(parents=True)
(out / 'manifest.json').write_text(json.dumps({'outcome': 'passed'}) + '\\n')
""")
        runner.chmod(0o755)

        failed = run([str(PUBLIC_YY), "task", "start", "X"], self.controller, False)
        self.assertEqual(failed.returncode, 2)
        self.assertIn("task hydration lint failed", failed.stderr)
        failed_record = task_runtime.read_state(self.controller)["tasks"]["X"]
        self.assertEqual(failed_record["state"], "HYDRATION_FAILED")
        artifact = Path(failed_record["hydration"]["artifact_dir"])
        diagnostic_path = artifact / "lint-diagnostic.json"
        self.assertTrue(diagnostic_path.is_file())
        diagnostic = json.loads(diagnostic_path.read_text())
        self.assertEqual(diagnostic["exit_code"], 9)
        self.assertEqual(diagnostic["cwd"], str((self.workspaces / "X").resolve()))
        self.assertEqual(diagnostic["runner"]["path"], str(runner.resolve()))
        self.assertEqual(diagnostic["runner"]["sha256"], hashlib.sha256(runner.read_bytes()).hexdigest())
        self.assertLessEqual(diagnostic["started_at_unix_ns"], diagnostic["completed_at_unix_ns"])
        self.assertEqual(stat.S_IMODE(artifact.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(diagnostic_path.stat().st_mode), 0o600)
        self.assertEqual(diagnostic["streams"]["stdout"]["persisted_bytes"], 32768)
        self.assertGreater(diagnostic["streams"]["stderr"]["truncated_bytes"], 0)
        self.assertEqual((artifact / "lint.stdout").stat().st_size, 32768)
        self.assertIn(b"causal lint failure", (artifact / "lint.stderr").read_bytes())
        frozen = failed_record["creation_receipt"]["hydration_workflow"]
        creation_identity = failed_record["workspace_identity"]["create_receipt_sha256"]
        workspace = Path(failed_record["worktree"])

        # Simulate the selected managed runtime from the dogfood report: it can
        # be invoked, but its dispatcher/audit protocol predates task hydrate.
        stale_runtime = self.controller / task_runtime.RUNTIME_PATH
        stale_runtime.write_text("""#!/usr/bin/env python3
import sys
print('task workspace: error: unsupported task audit operation: hydrate', file=sys.stderr)
raise SystemExit(2)
""")
        stale = run(["python3", str(stale_runtime), "hydrate", "--task", "X"],
                    self.controller, False)
        self.assertEqual(stale.returncode, 2)
        self.assertIn("unsupported task audit operation: hydrate", stale.stderr)

        recovered = run([str(PUBLIC_YY), "task", "hydrate", "X"], workspace)
        payload = json.loads(recovered.stdout)
        self.assertEqual((payload["outcome"], payload["state"]), ("hydrated", "WORKING"))
        self.assertEqual(payload["creation_receipt"]["hydration_workflow"], frozen)
        self.assertEqual(payload["workspace_identity"]["create_receipt_sha256"], creation_identity)
        self.assertEqual(Path(payload["worktree"]), workspace)
        audit = json.loads(Path(payload["control_audit"]["path"]).read_text())
        self.assertEqual((audit["operation"], audit["routing"]["invocation_role"]),
                         ("hydrate", "task"))
        self.assertEqual(payload["hydration"]["status"], "passed")
        self.assertTrue(Path(payload["hydration"]["manifest_path"]).is_file())

        repeated = json.loads(run(
            [str(PUBLIC_YY), "task", "hydrate", "X"], workspace).stdout)
        self.assertEqual((repeated["outcome"], repeated["state"]), ("hydrated", "WORKING"))
        self.assertEqual(repeated["workspace_identity"]["create_receipt_sha256"], creation_identity)
        self.assertEqual(Path(repeated["worktree"]), workspace)
        registrations = git(self.repository, "worktree", "list", "--porcelain")
        self.assertEqual(registrations.count(f"worktree {workspace}\n"), 1)
        self.assertEqual(git(workspace, "status", "--porcelain=v1"), "")
        print("PUBLIC_CLI_HYDRATION_RETRY_ACCEPTANCE_COMPLETED")

    def build_required_public_cli_recovers_missing_target_runtime_then_starts_task(self) -> None:
        package = json.loads((PACKAGE_ROOT / "package.json").read_text())
        self.assertEqual(package.get("name"), "@yylo/cli")
        self.assertTrue(PUBLIC_YY.is_file(), f"public yy binary is missing: {PUBLIC_YY}")

        self.remove_runtime_for_consumer()

        updated = run([str(PUBLIC_YY), "scripts", "update", "--force"], self.controller)
        self.assertEqual(updated.returncode, 0)
        controller_runtime = self.controller / task_runtime.RUNTIME_PATH
        self.assertEqual(
            controller_runtime.read_bytes(),
            (PACKAGE_ROOT / "dist/templates/scripts/task_workspace.py").read_bytes(),
        )
        self.assertFalse((self.repository / task_runtime.RUNTIME_PATH).exists())
        self.assertEqual(git(self.repository, "status", "--porcelain=v1"), "",
                         "scripts update dirtied the target holder")

        refused = run([str(PUBLIC_YY), "task", "start", "X"], self.controller, False)
        self.assertEqual(refused.returncode, 2)
        self.assertIn("yy task runtime-bootstrap --dry-run", refused.stderr)
        self.assertFalse((self.workspaces / "X").exists())
        self.assertEqual(task_runtime._bootstrap_target_status(self.controller), "",
                         "public task-start refusal dirtied the configured repository")

        planned = run(
            [str(PUBLIC_YY), "task", "runtime-bootstrap", "--dry-run"], self.controller)
        plan = json.loads(planned.stdout)
        receipt = Path(plan["receipt"]["path"])
        self.assertTrue(receipt.is_file())
        self.assertFalse((self.repository / task_runtime.RUNTIME_PATH).exists())

        applied = run(
            [str(PUBLIC_YY), "task", "runtime-bootstrap", "--apply", str(receipt)],
            self.controller)
        self.assertEqual(json.loads(applied.stdout)["outcome"], "completed")
        self.assertEqual(
            (self.repository / task_runtime.RUNTIME_PATH).read_bytes(),
            controller_runtime.read_bytes(),
        )

        started = run([str(PUBLIC_YY), "task", "start", "X"], self.controller)
        self.assertEqual(json.loads(started.stdout)["outcome"], "started")
        workspace = self.workspaces / "X"
        self.assertTrue(workspace.is_dir())
        self.assertEqual(git(workspace, "config", "--bool", "core.sparseCheckout"), "false")
        self.assertEqual(git(workspace, "ls-files", "-v", "src"), "H src/base.txt")
        self.assertEqual(git(workspace, "status", "--porcelain=v1"), "")
        print("PUBLIC_CLI_RUNTIME_BOOTSTRAP_ACCEPTANCE_COMPLETED")

    def build_required_public_cli_migrates_legacy_provenance_then_starts_task(self) -> None:
        package = json.loads((PACKAGE_ROOT / "package.json").read_text())
        self.assertEqual(package.get("name"), "@yylo/cli")
        self.assertTrue(PUBLIC_YY.is_file())
        run([str(PUBLIC_YY), "scripts", "update", "--force"], self.controller)
        packaged_executable = PACKAGE_ROOT / "dist/bin/cli.mjs"
        identity = self.controller / ".juno_task/runtime/identity.json"
        identity.parent.mkdir(parents=True, exist_ok=True)
        identity.write_text(json.dumps({
            "package": "@yylo/cli", "version": package["version"],
            "executable": str(packaged_executable),
            "executable_sha256": hashlib.sha256(packaged_executable.read_bytes()).hexdigest(),
            "source": "installed-release", "tracked": False,
        }) + "\n")
        packaged_runtime = PACKAGE_ROOT / "dist/templates/scripts/task_workspace.py"
        runtime = self.repository / task_runtime.RUNTIME_PATH
        runtime.write_bytes(packaged_runtime.read_bytes())
        git(self.repository, "rm", "juno-code/src/templates/scripts/task_workspace.py",
            "juno-code/package.json")
        git(self.repository, "add", task_runtime.RUNTIME_PATH)
        git(self.repository, "commit", "-m", "legacy package runtime without inventory provenance")
        before = git(self.repository, "rev-parse", "refs/heads/product")

        exclude = Path(git(self.controller, "rev-parse", "--path-format=absolute",
                           "--git-path", "info/exclude"))
        with exclude.open("a") as handle:
            handle.write("\n.juno_task/.version_check_cache\n.juno_task/managed-assets.json\n"
                         ".juno_task/runtime/managed-controller/generation.json\n")
        unrelated = self.controller / ".juno_task/.version_check_cache"
        unrelated.write_bytes(b"package canary unrelated dirt\n")
        unrelated_hash = hashlib.sha256(unrelated.read_bytes()).hexdigest()

        refused = run([str(PUBLIC_YY), "task", "start", "X"], self.controller, False)
        self.assertEqual(refused.returncode, 2)
        self.assertIn("target-runtime-provenance plan", refused.stderr)
        plan_path = self.root / "package-provenance-plan.json"
        planned = run([str(PUBLIC_YY), "migrate", "target-runtime-provenance", "plan",
                       "--controller", str(self.controller), "--output", str(plan_path)],
                      self.controller)
        plan = json.loads(planned.stdout)
        self.assertEqual(plan["target"]["sha"], before)
        self.assertEqual(plan["package"]["version"], package["version"])
        self.assertEqual(git(self.repository, "rev-parse", "refs/heads/product"), before)
        self.assertEqual(hashlib.sha256(unrelated.read_bytes()).hexdigest(), unrelated_hash)

        git(self.repository, "switch", "--detach")
        apply_path = self.root / "package-provenance-apply.json"
        applied = run([str(PUBLIC_YY), "migrate", "target-runtime-provenance", "apply",
                       "--plan", str(plan_path), "--output", str(apply_path),
                       "--authorize-target-runtime-provenance"], self.controller)
        migrated = json.loads(applied.stdout)
        self.assertEqual(migrated["changed_paths"], [task_runtime.MANAGED_INVENTORY_PATH])
        self.assertEqual(hashlib.sha256(unrelated.read_bytes()).hexdigest(), unrelated_hash)
        started = run([str(PUBLIC_YY), "task", "start", "X"], self.controller)
        self.assertEqual(json.loads(started.stdout)["outcome"], "started")
        self.assertEqual(hashlib.sha256(unrelated.read_bytes()).hexdigest(), unrelated_hash)
        print("PUBLIC_CLI_RUNTIME_PROVENANCE_ACCEPTANCE_COMPLETED")

    def test_stale_runtime_refuses_before_creating_branch_worktree_or_state(self) -> None:
        runtime = self.repository / task_runtime.RUNTIME_PATH
        runtime.write_text(runtime.read_text() + "\n# newer target generation\n")
        git(self.repository, "add", task_runtime.RUNTIME_PATH)
        git(self.repository, "commit", "-m", "new runtime generation")

        refused = self.command("start", "X", check=False)
        self.assertEqual(refused.returncode, 2)
        self.assertIn("managed task runtime differs", refused.stderr)
        self.assertIn("Juno source target", refused.stderr)
        self.assertIn("controller package/runtime matching that target", refused.stderr)
        self.assertIn("atomically update the source package", refused.stderr)
        self.assertNotIn("runtime-bootstrap", refused.stderr)
        self.assertFalse((self.workspaces / "X").exists())
        self.assertNotEqual(run(["git", "-C", str(self.repository), "show-ref", "--verify",
                                 "--quiet", "refs/heads/task-X"], self.repository, False).returncode, 0)
        self.assertNotIn("X", task_runtime.read_state(self.controller)["tasks"])
        status = self.payload("status", "X")
        self.assertFalse(status["runtime_generation"]["current"])

    def test_sparse_disable_and_materialization_failures_leave_no_partial_workspace(self) -> None:
        original_run = task_runtime.run

        def fail_sparse_disable(argv: list[str], cwd: Path, *, check: bool = True):
            if argv[-2:] == ["sparse-checkout", "disable"]:
                raise task_runtime.TaskWorkspaceError("injected sparse disable failure")
            return original_run(argv, cwd, check=check)

        with mock.patch.object(task_runtime, "run", side_effect=fail_sparse_disable):
            with self.assertRaisesRegex(task_runtime.TaskWorkspaceError, "injected sparse"):
                task_runtime.start(self.controller, "X")
        self.assertFalse((self.workspaces / "X").exists())
        self.assertNotEqual(run(["git", "-C", str(self.repository), "show-ref", "--verify",
                                 "--quiet", "refs/heads/task-X"], self.repository, False).returncode, 0)

        with mock.patch.object(task_runtime, "require_full_task_materialization",
                               side_effect=task_runtime.TaskWorkspaceError("injected proof failure")):
            with self.assertRaisesRegex(task_runtime.TaskWorkspaceError, "injected proof"):
                task_runtime.start(self.controller, "X")
        self.assertFalse((self.workspaces / "X").exists())
        self.assertNotEqual(run(["git", "-C", str(self.repository), "show-ref", "--verify",
                                 "--quiet", "refs/heads/task-X"], self.repository, False).returncode, 0)
        self.assertNotIn("X", task_runtime.read_state(self.controller)["tasks"])

    def test_routing_audit_rejects_a_forwarded_identity_for_another_controller(self) -> None:
        with mock.patch.dict(os.environ, {
            "JUNO_CONTROL_INVOCATION_ROOT": "/outer/integration",
            "JUNO_CONTROL_INVOCATION_ROLE": "integration-owner",
            "JUNO_CONTROL_EFFECTIVE_ROOT": "/outer/controller",
            "JUNO_CONTROL_OPERATION": "kanban",
        }, clear=False):
            with self.assertRaisesRegex(task_runtime.TaskWorkspaceError, "effective root mismatched"):
                task_runtime.routing_identity(self.controller)

    def test_control_audit_persists_validated_task_worktree_identity(self) -> None:
        self.payload("start", "X")
        worktree = self.workspaces / "X"
        with mock.patch.dict(os.environ, {
            "JUNO_CONTROL_INVOCATION_ROOT": str(worktree),
            "JUNO_CONTROL_INVOCATION_ROLE": "task",
            "JUNO_CONTROL_EFFECTIVE_ROOT": str(self.controller),
            "JUNO_CONTROL_OPERATION": "kanban",
        }, clear=False):
            reference = task_runtime.record_control_audit(
                self.controller, "task", "status", "X")
        path = Path(reference["path"])
        data = path.read_bytes()
        self.assertEqual(hashlib.sha256(data).hexdigest(), reference["sha256"])
        receipt = json.loads(data)
        self.assertEqual((receipt["surface"], receipt["operation"], receipt["task_id"]),
                         ("task", "status", "X"))
        self.assertEqual(receipt["routing"], {
            "invocation_root": str(worktree.resolve()), "invocation_role": "task",
            "effective_root": str(self.controller.resolve()),
        })

    def test_task_mutations_preserve_atomic_queue_sections(self) -> None:
        self.payload("start", "X")
        state_path = self.controller / ".juno_task/state/tasks.json"
        state = json.loads(state_path.read_text())
        state["queues"]["fixture-target"] = {"last_attempt": {"task_id": "Q"}, "conflicts": {}}
        state_path.write_text(json.dumps(state, sort_keys=True, separators=(",", ":")) + "\n")
        self.payload("start", "Y")
        after = json.loads(state_path.read_text())
        self.assertEqual(after["queues"], state["queues"])
        self.assertEqual(set(after["tasks"]), {"X", "Y"})

    def test_start_is_idempotent_only_for_unchanged_clean_identity(self) -> None:
        self.assertEqual(self.payload("start", "X")["outcome"], "started")
        self.assertEqual(self.payload("start", "X")["outcome"], "already_started")
        (self.workspaces / "X/src/dirty.txt").write_text("dirty\n")
        failed = self.command("start", "X", False)
        self.assertEqual(failed.returncode, 2)
        self.assertIn("identity drifted", failed.stderr)
        self.assertTrue((self.workspaces / "X").is_dir())

    def test_unrecorded_branch_and_path_collisions_refuse(self) -> None:
        git(self.repository, "branch", "task-X", self.base)
        branch = self.command("start", "X", False)
        self.assertEqual(branch.returncode, 2)
        self.assertIn("branch already exists", branch.stderr)
        git(self.repository, "branch", "-D", "task-X")
        (self.workspaces / "X").mkdir(parents=True)
        path = self.command("start", "X", False)
        self.assertEqual(path.returncode, 2)
        self.assertIn("path already exists", path.stderr)

    def test_status_reads_live_tip_and_exact_cumulative_paths_without_rewriting_creation_evidence(self) -> None:
        started = self.payload("start", "X")
        frozen_receipt = started["creation_receipt"]
        frozen_state = (self.controller / ".juno_task/state/tasks.json").read_bytes()
        at_a = self.payload("status", "X")
        self.assertEqual(at_a["tip_sha"], self.base)
        self.assertEqual(at_a["changed_paths"], [])

        tip_b = self.commit_task("X", "src/one.txt")
        at_b = self.payload("status", "X")
        self.assertEqual(at_b["tip_sha"], tip_b)
        self.assertEqual(at_b["changed_paths"], ["src/one.txt"])
        self.assertEqual(at_b["base_sha"], self.base)
        self.assertEqual(at_b["creation_receipt"], frozen_receipt)
        self.assertEqual(at_b["creation_receipt"]["base_sha"], self.base)

        tip_c = self.commit_task("X", "src/two.txt")
        at_c = self.payload("status", "X")
        self.assertEqual(at_c["tip_sha"], tip_c)
        self.assertEqual(at_c["changed_paths"], ["src/one.txt", "src/two.txt"])
        # Status is read-only: persisted WORKING truth remains the immutable A snapshot.
        self.assertEqual((self.controller / ".juno_task/state/tasks.json").read_bytes(), frozen_state)

    def test_status_reports_committed_and_uncommitted_paths_separately(self) -> None:
        self.payload("start", "X")
        tip = self.commit_task("X", "src/committed.txt")
        worktree = self.workspaces / "X"
        (worktree / "src/uncommitted.txt").write_text("dirty\n")
        (worktree / "src/tracked-dirty.txt").write_text("base\n")
        payload = self.payload("status", "X")
        self.assertEqual(payload["tip_sha"], tip)
        self.assertEqual(payload["changed_paths"], ["src/committed.txt"])
        self.assertEqual(payload["uncommitted_paths"], ["src/tracked-dirty.txt", "src/uncommitted.txt"])
        self.assertEqual(payload["changed_paths_scope"], "base_sha..tip committed diff")

    def test_status_reports_uncommitted_only_and_clean_cases(self) -> None:
        self.payload("start", "X")
        worktree = self.workspaces / "X"
        (worktree / "src/uncommitted-only.txt").write_text("dirty\n")
        uncommitted_only = self.payload("status", "X")
        self.assertEqual(uncommitted_only["changed_paths"], [])
        self.assertEqual(uncommitted_only["uncommitted_paths"], ["src/uncommitted-only.txt"])
        git(worktree, "add", "src/uncommitted-only.txt")
        staged = self.payload("status", "X")
        self.assertEqual(staged["changed_paths"], [])
        self.assertEqual(staged["uncommitted_paths"], ["src/uncommitted-only.txt"])
        git(worktree, "reset", "--hard", "HEAD")
        clean = self.payload("status", "X")
        self.assertEqual(clean["changed_paths"], [])
        self.assertEqual(clean["uncommitted_paths"], [])

    def test_status_reports_committed_paths_when_target_moved(self) -> None:
        self.payload("start", "X")
        tip = self.commit_task("X", "src/committed.txt")
        self.advance_target()
        payload = self.payload("status", "X")
        self.assertTrue(payload["target_moved"])
        self.assertEqual(payload["tip_sha"], tip)
        self.assertEqual(payload["changed_paths"], ["src/committed.txt"])
        self.assertEqual(payload["uncommitted_paths"], [])

    def test_exact_root_accepts_platform_alias_spelling_of_same_worktree(self) -> None:
        if sys.platform != "darwin":
            self.skipTest("darwin /var -> /private/var compatibility alias required")
        raw = Path(tempfile.mkdtemp(prefix="alias-probe-"))
        self.addCleanup(shutil.rmtree, raw, ignore_errors=True)
        if raw.resolve() == raw:
            self.skipTest("temp root is not reachable through a platform alias")
        probe = raw / "repo"
        probe.mkdir()
        git(probe, "init", "-b", "probe")
        # The alias spelling (for example /var/folders/...) must be accepted and
        # normalize to the physical /private/... form that git rev-parse
        # reports, instead of failing the lexical comparison.
        normalized = task_runtime.exact_root(probe, "alias worktree", physical_identity=True)
        self.assertEqual(normalized, probe.resolve())
        # The physical spelling stays accepted and both forms agree.
        self.assertEqual(task_runtime.exact_root(probe.resolve(), "physical worktree"), probe.resolve())

    def test_status_and_finish_refuse_moved_worktree_symlink_substitution(self) -> None:
        self.payload("start", "X")
        admitted = self.workspaces / "X"
        moved = self.root / "moved-X"
        admitted.rename(moved)
        admitted.symlink_to(moved, target_is_directory=True)
        for operation in ("status", "finish"):
            failed = self.command(operation, "X", False)
            self.assertEqual(failed.returncode, 2)
            self.assertIn("missing or reused", failed.stderr)
            self.assertEqual(task_runtime.read_state(self.controller)["tasks"]["X"]["state"], "WORKING")

    def test_status_and_finish_refuse_symlinked_parent_component(self) -> None:
        self.payload("start", "X")
        moved_root = self.root / "moved-workspaces"
        self.workspaces.rename(moved_root)
        self.workspaces.symlink_to(moved_root, target_is_directory=True)
        for operation in ("status", "finish"):
            failed = self.command(operation, "X", False)
            self.assertEqual(failed.returncode, 2)
            self.assertIn("missing or reused", failed.stderr)

    def test_finish_rechecks_exact_path_after_validation(self) -> None:
        self.payload("start", "X")
        self.commit_task("X")
        code = (
            "from pathlib import Path; "
            "worktree=Path.cwd().parent; moved=worktree.parent/'moved-during-validation'; "
            "worktree.rename(moved); worktree.symlink_to(moved, target_is_directory=True)"
        )
        self.write_policy(validation_code=code)
        failed = self.command("finish", "X", False)
        self.assertEqual(failed.returncode, 2)
        self.assertIn("changed during focused validation", failed.stderr)
        self.assertEqual(task_runtime.read_state(self.controller)["tasks"]["X"]["state"], "WORKING")

    def test_status_and_finish_share_exact_nul_delimited_git_pathnames(self) -> None:
        for relative in ("src/rename-source.txt", "src/delete-me.txt"):
            (self.repository / relative).write_text("base\n")
        git(self.repository, "add", "src/rename-source.txt", "src/delete-me.txt")
        git(self.repository, "commit", "-m", "unusual pathname base")
        self.base = git(self.repository, "rev-parse", "HEAD")
        self.payload("start", "X")
        worktree = self.workspaces / "X"
        names = [
            "src/line\nbreak.txt", "src/tab\tname.txt", 'src/double\"quote.txt',
            "src/back\\slash.txt", "src/unicode-雪.txt",
        ]
        for relative in names:
            (worktree / relative).write_text(relative, encoding="utf-8")
        renamed = 'src/renamed-\"tab\t.txt'
        (worktree / "src/rename-source.txt").rename(worktree / renamed)
        (worktree / "src/delete-me.txt").unlink()
        git(worktree, "add", "-A")
        # A gitlink is a pathname-bearing tree entry too. Materialize a real
        # nested repository so the outer worktree remains clean after commit.
        nested = worktree / "src/gitlink"
        nested.mkdir()
        git(nested, "init")
        git(nested, "config", "user.email", "test@example.com")
        git(nested, "config", "user.name", "Test")
        (nested / "nested.txt").write_text("nested\n")
        git(nested, "add", "nested.txt")
        git(nested, "commit", "-m", "nested")
        gitlink_sha = git(nested, "rev-parse", "HEAD")
        git(worktree, "update-index", "--add", "--cacheinfo", "160000", gitlink_sha, "src/gitlink")
        git(worktree, "commit", "-m", "exact unusual pathnames")
        expected = sorted({
            *names, "src/rename-source.txt", renamed, "src/delete-me.txt", "src/gitlink",
        })
        self.assertEqual(self.payload("status", "X")["changed_paths"], expected)
        queued = self.payload("finish", "X")
        self.assertEqual(queued["changed_paths"], expected)
        self.assertEqual(queued["state"], "QUEUED")

    def test_changed_path_parser_fails_closed_for_non_utf8_json_name(self) -> None:
        result = subprocess.CompletedProcess(
            args=["git"], returncode=0, stdout=b"src/non-utf8-\xff.txt\0", stderr=b"")
        reason = "Git changed path is not valid UTF-8 and cannot be represented in canonical JSON"
        with mock.patch.object(task_runtime.subprocess, "run", return_value=result):
            with self.assertRaisesRegex(task_runtime.TaskWorkspaceError, reason):
                task_runtime.git_pathnames(self.repository, "diff", "--name-only", "-z", "A..B")

    def test_status_and_finish_share_fail_closed_live_worktree_identity(self) -> None:
        self.payload("start", "X")
        worktree = self.workspaces / "X"
        (worktree / "src/dirty.txt").write_text("dirty\n")
        # Status keeps reporting committed and uncommitted paths separately on a
        # dirty tree; only finish refuses the unclean worktree before queueing.
        live = self.payload("status", "X")
        self.assertEqual(live["changed_paths"], [])
        self.assertEqual(live["uncommitted_paths"], ["src/dirty.txt"])
        failed = self.command("finish", "X", False)
        self.assertEqual(failed.returncode, 2)
        self.assertIn("worktree is dirty", failed.stderr)
        (worktree / "src/dirty.txt").unlink()

        git(worktree, "config", "--worktree", "juno.workspace.role", "integration-owner")
        for operation in ("status", "finish"):
            failed = self.command(operation, "X", False)
            self.assertEqual(failed.returncode, 2)
            self.assertIn("role/identity drifted", failed.stderr)
        git(worktree, "config", "--worktree", "juno.workspace.role", "task")

        git(worktree, "checkout", "--detach", self.base)
        failed = self.command("status", "X", False)
        self.assertEqual(failed.returncode, 2)
        self.assertIn("branch/worktree identity drifted", failed.stderr)
        git(worktree, "checkout", "task-X")

        git(worktree, "config", "--worktree", "juno.workspace.taskId", "reused")
        failed = self.command("status", "X", False)
        self.assertEqual(failed.returncode, 2)
        self.assertIn("role/identity drifted", failed.stderr)

    def test_status_refuses_missing_reused_and_receipt_drifted_worktrees(self) -> None:
        self.payload("start", "X")
        worktree = self.workspaces / "X"
        git(self.repository, "worktree", "remove", str(worktree))
        missing = self.command("status", "X", False)
        self.assertEqual(missing.returncode, 2)
        self.assertIn("missing or reused", missing.stderr)

        worktree.mkdir()
        git(worktree, "init")
        git(worktree, "config", "user.email", "test@example.com")
        git(worktree, "config", "user.name", "Test")
        (worktree / "foreign.txt").write_text("foreign\n")
        git(worktree, "add", "foreign.txt")
        git(worktree, "commit", "-m", "foreign")
        reused = self.command("status", "X", False)
        self.assertEqual(reused.returncode, 2)
        self.assertIn("different repository", reused.stderr)

        self.payload("start", "Y")
        state_path = self.controller / ".juno_task/state/tasks.json"
        state = json.loads(state_path.read_text())
        state["tasks"]["Y"]["creation_receipt"]["base_sha"] = "0" * 40
        state_path.write_text(json.dumps(state, sort_keys=True, separators=(",", ":")) + "\n")
        drifted = self.command("status", "Y", False)
        self.assertEqual(drifted.returncode, 2)
        self.assertIn("creation receipt or recorded identity drifted", drifted.stderr)

    def test_moved_target_is_reported_independently_without_rebasing_live_task_tip(self) -> None:
        self.payload("start", "X")
        task_tip = self.commit_task("X")
        advanced = self.advance_target()
        failed = self.command("start", "X", False)
        self.assertEqual(failed.returncode, 2)
        status = self.payload("status", "X")
        self.assertTrue(status["target_moved"])
        self.assertEqual(status["current_target_sha"], advanced)
        self.assertEqual(status["tip_sha"], task_tip)
        self.assertEqual(status["changed_paths"], ["src/feature.txt"])
        self.assertEqual(git(self.workspaces / "X", "rev-parse", "HEAD"), task_tip)

    def test_finish_refuses_dirty_and_preserves_worktree(self) -> None:
        self.payload("start", "X")
        self.commit_task("X")
        (self.workspaces / "X/src/untracked.txt").write_text("dirty\n")
        failed = self.command("finish", "X", False)
        self.assertEqual(failed.returncode, 2)
        self.assertIn("dirty", failed.stderr)
        self.assertTrue((self.workspaces / "X/src/untracked.txt").exists())
        self.assertEqual(task_runtime.read_state(self.controller)["tasks"]["X"]["state"], "WORKING")

    def test_finish_refuses_disallowed_path_and_preserves_commit(self) -> None:
        self.payload("start", "X")
        tip = self.commit_task("X", "outside.txt")
        failed = self.command("finish", "X", False)
        self.assertEqual(failed.returncode, 2)
        self.assertIn("disallowed paths: outside.txt", failed.stderr)
        self.assertEqual(git(self.workspaces / "X", "rev-parse", "HEAD"), tip)
        self.assertTrue((self.workspaces / "X").is_dir())

    def test_preflight_reports_disallowed_path_before_validation_or_queue_mutation(self) -> None:
        self.payload("start", "X")
        tip = self.commit_task("X", "outside.txt")
        failed = self.command("preflight", "X", False)
        self.assertEqual(failed.returncode, 2)
        self.assertIn("disallowed paths: outside.txt", failed.stderr)
        record = task_runtime.read_state(self.controller)["tasks"]["X"]
        self.assertEqual(record["state"], "WORKING")
        self.assertEqual(record["validation"], [])
        self.assertEqual(git(self.workspaces / "X", "rev-parse", "HEAD"), tip)

    def test_preflight_emits_immutable_closure_and_finish_persists_it(self) -> None:
        self.payload("start", "X")
        tip = self.commit_task("X")
        checked = self.payload("preflight", "X")
        closure = checked["review_ready_closure"]
        self.assertEqual(checked["outcome"], "preflight_passed")
        self.assertEqual(closure["tip_sha"], tip)
        self.assertEqual(closure["changed_paths"], ["src/feature.txt"])
        body = {key: value for key, value in closure.items() if key != "closure_sha256"}
        self.assertEqual(closure["closure_sha256"], task_runtime.stable_sha256(body))
        self.assertEqual(task_runtime.read_state(self.controller)["tasks"]["X"]["state"],
                         "WORKING")
        queued = self.payload("finish", "X")
        queued_closure = queued["review_ready_closure"]
        for key, value in closure.items():
            if key != "closure_sha256":
                self.assertEqual(queued_closure[key], value)
        standing = queued_closure["standing_validation"]
        self.assertEqual(standing["outcome"], "PASSED")
        self.assertEqual(standing["tip_sha"], tip)
        queued_body = {key: value for key, value in queued_closure.items()
                       if key != "closure_sha256"}
        self.assertEqual(queued_closure["closure_sha256"],
                         task_runtime.stable_sha256(queued_body))

    def test_finish_refuses_failed_focused_validation_without_state_advance(self) -> None:
        self.payload("start", "X")
        self.commit_task("X")
        self.write_policy(validation_code="import sys; print('failure-out'); print('failure-err', file=sys.stderr); sys.exit(7)")
        failed = self.command("finish", "X", False)
        self.assertEqual(failed.returncode, 2)
        self.assertIn("focused validation failed", failed.stderr)
        status = self.payload("status", "X")
        self.assertEqual(status["state"], "WORKING")
        self.assertEqual(status["last_validation_outcome"], "FAILED")
        self.assertEqual(status["validation"][0]["exit_code"], 7)
        self.assertIn("failure-out", status["validation"][0]["stdout_tail"])
        self.assertIn("failure-err", status["validation"][0]["stderr_tail"])
        self.assertTrue((self.workspaces / "X").is_dir())

    def test_finish_queues_clean_committed_tip_without_merging_or_cleanup(self) -> None:
        self.payload("start", "X")
        tip = self.commit_task("X")
        queued = self.payload("finish", "X")
        self.assertEqual(queued["state"], "QUEUED")
        self.assertEqual(queued["tip_sha"], tip)
        self.assertEqual(queued["changed_paths"], ["src/feature.txt"])
        self.assertEqual(queued["validation"][0]["exit_code"], 0)
        self.assertEqual(git(self.repository, "rev-parse", "refs/heads/product"), self.base)
        self.assertTrue((self.workspaces / "X").is_dir())
        self.assertEqual(self.payload("finish", "X")["outcome"], "already_queued")

    def test_empty_commit_is_not_a_finished_feature(self) -> None:
        self.payload("start", "X")
        git(self.workspaces / "X", "commit", "--allow-empty", "-m", "empty")
        failed = self.command("finish", "X", False)
        self.assertEqual(failed.returncode, 2)
        self.assertIn("no product diff", failed.stderr)
        self.assertEqual(self.payload("status", "X")["state"], "WORKING")

    def test_timeout_closes_stdin_and_persists_bounded_truncated_evidence(self) -> None:
        self.payload("start", "X")
        self.commit_task("X")
        code = ("import sys,time; assert sys.stdin.buffer.read() == b''; "
                "print('A'*5000,flush=True); print('B'*5000,file=sys.stderr,flush=True); time.sleep(5)")
        self.write_policy(validation_code=code, timeout_seconds=1, max_output_bytes=1024)
        started = time.monotonic()
        failed = self.command("finish", "X", False)
        self.assertLess(time.monotonic() - started, 3)
        self.assertEqual(failed.returncode, 2)
        self.assertIn("timed out", failed.stderr)
        evidence = self.payload("status", "X")["validation"][0]
        self.assertTrue(evidence["timed_out"])
        self.assertGreater(evidence["stdout_truncated_bytes"], 0)
        self.assertGreater(evidence["stderr_truncated_bytes"], 0)
        self.assertLessEqual(len(evidence["stdout_tail"].encode()), 1024)
        self.assertLessEqual(len(evidence["stderr_tail"].encode()), 1024)
        self.assertTrue(evidence["log_path"].startswith("/tmp/yy-validation-"))
        self.assertEqual(hashlib.sha256(Path(evidence["log_path"]).read_bytes()).hexdigest(),
                         evidence["log_sha256"])

    def test_focused_scheduler_serializes_only_shared_resource_in_policy_order(self) -> None:
        markers = self.root / "focused-schedule.jsonl"
        lock = self.root / "focused-managed-install.lock"
        def row(name: str, delay: float, resource: bool = False) -> dict:
            code = (
                "import json,time,sys; p=sys.argv[1]; name=sys.argv[2]; delay=float(sys.argv[3]); "
                "open(p,'a').write(json.dumps({'name':name,'event':'start','at':time.time_ns()})+'\\n'); "
                "time.sleep(delay); "
                "open(p,'a').write(json.dumps({'name':name,'event':'end','at':time.time_ns()})+'\\n')"
            )
            value = {"id": name, "cwd": "src", "argv": [sys.executable, "-c", code,
                     str(markers), name, str(delay)], "timeout_seconds": 3,
                     "max_output_bytes": 1024}
            if resource:
                value["resource"] = {"id": "managed-install", "lock_path": str(lock),
                                     "wait_timeout_seconds": 3}
            return value
        rows = [row("task-workspace", .8, True), row("integration-workspace", .25),
                row("script-installer", .8, True)]
        evidence = task_runtime.run_focused_validations(rows, self.repository)
        events = [json.loads(line) for line in markers.read_text().splitlines()]
        at = {(item["name"], item["event"]): item["at"] for item in events}

        self.assertLessEqual(at[("task-workspace", "end")], at[("script-installer", "start")])
        self.assertLess(at[("integration-workspace", "start")], at[("task-workspace", "end")])
        self.assertEqual([item["id"] for item in evidence], [row["id"] for row in rows])
        self.assertEqual([item["schedule"]["lane_position"] for item in evidence], [0, 0, 1])
        self.assertTrue(evidence[0]["schedule"]["critical_path"])
        self.assertFalse(evidence[1]["schedule"]["critical_path"])
        self.assertTrue(evidence[2]["schedule"]["critical_path"])
        self.assertEqual(evidence[1]["timing"]["critical_path_contribution_ms"],
                         evidence[1]["timing"]["wall_duration_ms"])
        self.assertFalse(any(item["timed_out"] for item in evidence))

    def test_validation_can_stream_both_child_channels_without_losing_evidence(self) -> None:
        row = {
            "id": "observable",
            "argv": [sys.executable, "-c", "import sys; print('live-out'); print('live-err', file=sys.stderr)"],
            "timeout_seconds": 5,
            "max_output_bytes": 1024,
        }
        streamed = io.StringIO()
        with mock.patch.dict(os.environ, {"JUNO_VALIDATION_STREAM": "1"}), contextlib.redirect_stderr(streamed):
            evidence = task_runtime.run_validation(row, self.repository)

        self.assertEqual(evidence["exit_code"], 0)
        self.assertIn("live-out", evidence["stdout_tail"])
        self.assertIn("live-err", evidence["stderr_tail"])
        self.assertIn("live-out", streamed.getvalue())
        self.assertIn("live-err", streamed.getvalue())
        log = Path(evidence["log_path"])
        self.assertIn(b"live-out", log.read_bytes())
        self.assertIn(b"live-err", log.read_bytes())
        self.assertIn("timed_out=false", streamed.getvalue())

    def test_log_allocation_is_unique_sanitized_and_fails_closed(self) -> None:
        with ThreadPoolExecutor(max_workers=4) as pool:
            allocated = list(pool.map(
                lambda _: task_runtime.allocate_long_run_log("flow with spaces", "task path"),
                range(4),
            ))
        paths = [path for path, _ in allocated]
        for _, handle in allocated: handle.close()
        self.assertEqual(len(set(paths)), 4)
        self.assertTrue(all(str(path).startswith("/tmp/yy-flow-with-spaces-task-path-") for path in paths))
        with mock.patch.object(task_runtime.os, "open", side_effect=PermissionError("denied")):
            with self.assertRaisesRegex(task_runtime.TaskWorkspaceError, "cannot allocate long-run log"):
                task_runtime.allocate_long_run_log("validation", "failure")

        failed_path = self.root / "log write failure.log"
        failed_path.write_bytes(b"")
        class BrokenLog:
            def write(self, _data): raise OSError("disk full")
            def close(self): pass
        row = {"id": "write-failure", "argv": [sys.executable, "-c", "print('payload', flush=True)"],
               "timeout_seconds": 5, "max_output_bytes": 1024}
        with mock.patch.object(task_runtime, "allocate_long_run_log",
                               return_value=(failed_path, BrokenLog())):
            evidence = task_runtime.run_validation(row, self.repository)
        self.assertTrue(evidence["log_write_failed"])
        self.assertIn("disk full", evidence["log_write_error"])
        self.assertNotEqual(evidence["exit_code"], 0)

    def test_duplicate_finish_validates_once_but_different_tasks_finish_concurrently(self) -> None:
        counter = self.root / "validation-counter.txt"
        events = self.root / "validation-events"
        code = f"""
from pathlib import Path
import json, os, time
events = Path({str(events)!r})
counter = Path({str(counter)!r})
events.mkdir(exist_ok=True)
workspace = Path.cwd().parent.name
started = time.monotonic()
(events / f'{{workspace}}-{{os.getpid()}}.ready').touch()
while len(list(events.glob('*.ready'))) < 2:
    time.sleep(0.01)
counter.open('a').write('run\\n')
# Hold the post-barrier window open briefly so the overlap assertion observes
# genuine concurrency even under heavy host scheduling; the barrier above, not
# this hold, is what proves the different-task concurrency contract.
time.sleep(0.25)
finished = time.monotonic()
(events / f'{{workspace}}-{{os.getpid()}}.json').write_text(json.dumps(
    {{'workspace': workspace, 'started': started, 'finished': finished}}
))
"""
        # The validation timeout is the independent hang/deadlock budget. The
        # concurrency contract below is proved by child-process overlap, not by
        # a loaded host's end-to-end wall-clock duration.
        self.write_policy(validation_code=code, timeout_seconds=5)
        self.payload("start", "X")
        self.payload("start", "Y")
        self.commit_task("X")
        self.commit_task("Y")
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(self.payload, "finish", task_id) for task_id in ("X", "Y")]
            x, y = [future.result(timeout=10) for future in futures]
        different_task_events = [json.loads(path.read_text()) for path in events.glob("*.json")]
        self.assertEqual({item["workspace"] for item in different_task_events}, {"X", "Y"})
        latest_start = max(item["started"] for item in different_task_events)
        earliest_finish = min(item["finished"] for item in different_task_events)
        self.assertLess(
            latest_start, earliest_finish,
            f"different-task validations did not overlap: {different_task_events!r}; "
            f"lock={RESOURCE_LOCK_PATH}; {_owner_diagnostics(_read_lock_owner())}; {_load_diagnostics()}",
        )
        self.assertEqual({x["outcome"], y["outcome"]}, {"queued"})
        self.assertEqual(counter.read_text().splitlines(), ["run", "run"])

        # A fresh task receives two simultaneous finish requests. Its task lease
        # runs validation once and the follower reuses the durable queued result.
        self.payload("start", "Z")
        self.commit_task("Z")
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = [future.result(timeout=10) for future in
                       [pool.submit(self.payload, "finish", "Z") for _ in range(2)]]
        self.assertEqual({item["outcome"] for item in results}, {"queued", "already_queued"})
        self.assertEqual(counter.read_text().splitlines(), ["run", "run", "run"])
        self.assertEqual(len(list(events.glob("*.json"))), 3)

    def test_validation_argv_is_not_a_shell_and_policy_bounds_refuse(self) -> None:
        marker = self.root / "injected"
        self.write_policy(validation_code="import sys; assert sys.argv[1].startswith(';')",
                          extra_args=[f"; touch {marker}"])
        self.payload("start", "X")
        self.commit_task("X")
        self.assertEqual(self.payload("finish", "X")["outcome"], "queued")
        self.assertFalse(marker.exists())
        self.write_policy(timeout_seconds=0)
        failed = self.command("status", "Y", False)
        self.assertEqual(failed.returncode, 2)
        self.assertIn("timeout_seconds", failed.stderr)

    def test_validation_drops_forwarded_control_audit_environment(self) -> None:
        row = {
            "id": "audit-isolation",
            "cwd": ".",
            "timeout_seconds": 5,
            "max_output_bytes": 4096,
            "argv": [sys.executable, "-c", (
                "import os; assert not any(key.startswith('JUNO_CONTROL_') "
                "for key in os.environ)"
            )],
        }
        with mock.patch.dict(os.environ, {
            "JUNO_CONTROL_INVOCATION_ROOT": str(self.repository),
            "JUNO_CONTROL_INVOCATION_ROLE": "task",
            "JUNO_CONTROL_EFFECTIVE_ROOT": str(self.controller),
            "JUNO_CONTROL_OPERATION": "orchestration",
        }):
            evidence = task_runtime.run_validation(row, self.repository)
        self.assertEqual(evidence["exit_code"], 0, evidence)
        self.assertFalse(evidence["timed_out"])

    def test_product_tree_with_controller_private_data_refuses_before_creation(self) -> None:
        private = self.repository / ".juno_task/tasks/xx/X.md"
        private.parent.mkdir(parents=True)
        private.write_text("controller data\n")
        git(self.repository, "add", ".juno_task/tasks/xx/X.md")
        git(self.repository, "commit", "-m", "bad product metadata")
        failed = self.command("start", "X", False)
        self.assertEqual(failed.returncode, 2)
        self.assertIn("controller-private data", failed.stderr)
        self.assertFalse((self.workspaces / "X").exists())

    def test_forbidden_tree_check_is_targeted_and_error_is_bounded(self) -> None:
        private = self.repository / ".juno_task/tasks/xx"
        private.mkdir(parents=True)
        for index in range(250):
            (private / f"task-{index:04d}-{'x' * 80}.md").write_text("controller data\n")
        git(self.repository, "add", ".juno_task/tasks")
        git(self.repository, "commit", "-m", "large forbidden tree")
        failed = self.command("start", "X", False)
        self.assertEqual(failed.returncode, 2)
        self.assertIn(".juno_task/tasks", failed.stderr)
        self.assertLess(len(failed.stderr), 1000)

    def test_status_reports_unavailable_target_without_calling_it_unmoved(self) -> None:
        self.payload("start", "X")
        git(self.repository, "checkout", "--detach", self.base)
        git(self.repository, "branch", "-D", "product")
        status = self.payload("status", "X")
        self.assertFalse(status["target_available"])
        self.assertIsNone(status["target_moved"])
        self.assertIsNone(status["current_target_sha"])
        self.assertEqual(status["target_error"], "target_ref_unavailable")



    def write_profiled_policy(self, profiles: Optional[list[dict]] = None) -> None:
        config = self.controller / ".juno_task/config/task-workspace.json"
        value = json.loads(config.read_text())
        value["allowed_paths"] = ["src", "pkg"]
        value["validation_profiles"] = (profiles if profiles is not None else [{
            "id": "pkg-suite", "path_roots": ["pkg"],
            "commands": [{"id": "pkg-test", "cwd": "pkg",
                          "argv": [sys.executable, "-c", "pass"],
                          "timeout_seconds": 10, "max_output_bytes": 4096}],
        }])
        config.write_text(json.dumps(value, indent=2) + "\n")

    def test_validation_profiles_policy_admits_only_deterministic_profiles(self) -> None:
        self.write_profiled_policy()
        config = task_runtime.load_config(self.controller)
        self.assertEqual([profile["id"] for profile in config["validation_profiles"]],
                         ["pkg-suite"])
        overlapping = [{"id": "pkg-suite", "path_roots": ["pkg"],
                        "commands": [{"id": "pkg-test", "cwd": "pkg",
                                      "argv": [sys.executable, "-c", "pass"],
                                      "timeout_seconds": 10, "max_output_bytes": 4096}]},
                       {"id": "nested-suite", "path_roots": ["pkg/nested"],
                        "commands": [{"id": "nested-test", "cwd": "pkg/nested",
                                      "argv": [sys.executable, "-c", "pass"],
                                      "timeout_seconds": 10, "max_output_bytes": 4096}]}]
        for mutation, profiles in (
                ("overlap", overlapping),
                ("escaped-cwd", [{"id": "pkg-suite", "path_roots": ["pkg"],
                                  "commands": [{"id": "pkg-test", "cwd": "src",
                                                "argv": [sys.executable, "-c", "pass"],
                                                "timeout_seconds": 10,
                                                "max_output_bytes": 4096}]}]),
                ("duplicate-id", [{"id": "full-suite", "path_roots": ["pkg"],
                                   "commands": [{"id": "pkg-test", "cwd": "pkg",
                                                 "argv": [sys.executable, "-c", "pass"],
                                                 "timeout_seconds": 10,
                                                 "max_output_bytes": 4096}]}]),
                ("disallowed-root", [{"id": "pkg-suite", "path_roots": [".juno_task/state"],
                                      "commands": [{"id": "pkg-test", "cwd": ".juno_task/state",
                                                    "argv": [sys.executable, "-c", "pass"],
                                                    "timeout_seconds": 10,
                                                    "max_output_bytes": 4096}]}]),
                ("duplicate-command-id", [{"id": "pkg-suite", "path_roots": ["pkg"],
                                           "commands": [
                                               {"id": "focused", "cwd": "pkg",
                                                "argv": [sys.executable, "-c", "pass"],
                                                "timeout_seconds": 10,
                                                "max_output_bytes": 4096}]}])):
            with self.subTest(mutation=mutation):
                self.write_profiled_policy(profiles)
                with self.assertRaisesRegex(task_runtime.TaskWorkspaceError,
                                            "validation profile"):
                    task_runtime.load_config(self.controller)
        self.write_profiled_policy()
        task_runtime.load_config(self.controller)

    def test_finish_routes_focused_validation_by_package_profile(self) -> None:
        self.write_profiled_policy()
        self.payload("start", "X")
        worktree = self.workspaces / "X"
        (worktree / "pkg").mkdir(parents=True, exist_ok=True)
        (worktree / "pkg/feature.txt").write_text("package feature\n")
        git(worktree, "add", "pkg/feature.txt")
        git(worktree, "commit", "-m", "package feature")
        finished = self.payload("finish", "X")
        self.assertEqual(finished["state"], "QUEUED")
        self.assertEqual(finished["validation"], [])
        self.assertEqual(finished["validation_routing"],
                         {"mode": "profile", "profile_ids": ["pkg-suite"],
                          "authored_path_count": 1})

    def test_task_run_persists_needs_decision_before_product_editing(self) -> None:
        self.install_task_run_assets()
        task_runtime.task_file(self.controller, "X").write_text(
            "---\nid: X\nstatus: todo\n---\n## Context\nTBD owner decision required\n")
        git(self.controller, "add", ".juno_task/tasks", ".juno_task/workflows",
            ".juno_task/prompts/lifecycle")
        git(self.controller, "commit", "-m", "ambiguous typed task run")
        projection = task_runtime.managed_task_run(self.controller.resolve(), "X")
        self.assertEqual(projection["state"], "NEEDS_DECISION")
        self.assertEqual(projection["attempts"]["implementation"], 0)
        repeated = task_runtime.managed_task_run(self.controller.resolve(), "X")
        self.assertEqual(repeated["run_id"], projection["run_id"])
        self.assertEqual(repeated["attempts"]["implementation"], 0)
        self.assertNotIn("X", task_runtime.read_state(self.controller)["tasks"])
        self.assertFalse((self.workspaces / "X").exists())

    def test_task_run_compiles_typed_operations_and_queues_one_logical_commit(self) -> None:
        self.install_task_run_assets()
        task_runtime.task_file(self.controller, "X").write_text(
            "---\nid: X\nstatus: todo\n---\n## Goal\nShip one file.\n"
            "## Acceptance\n- The committed file is validated.\n")
        git(self.controller, "add", ".juno_task/tasks", ".juno_task/workflows",
            ".juno_task/prompts/lifecycle")
        git(self.controller, "commit", "-m", "ready typed task run")

        def implement(_controller: Path, _task_id: str, record: dict,
                      _run_dir: Path, _prompt: Path, **_kwargs: object) -> dict:
            worktree = Path(record["worktree"])
            (worktree / "src/managed.txt").write_text("managed\n")
            git(worktree, "add", "src/managed.txt")
            before = git(worktree, "rev-parse", "HEAD")
            git(worktree, "commit", "-m", "managed implementation")
            return {"terminal_state": "completed", "before_sha": before,
                    "after_sha": git(worktree, "rev-parse", "HEAD"),
                    "receipt": {"path": "fixture", "sha256": "0" * 64},
                    "session_id": "fixture"}

        with mock.patch.object(task_runtime, "_launch_task_worker", side_effect=implement):
            projection = task_runtime.managed_task_run(self.controller.resolve(), "X")
        self.assertEqual(projection["state"], "QUEUED")
        self.assertEqual(projection["attempts"]["implementation"], 1)
        record = task_runtime.read_state(self.controller)["tasks"]["X"]
        self.assertEqual(record["state"], "QUEUED")
        self.assertEqual(git(Path(record["worktree"]), "rev-list", "--count",
                             f"{record['base_sha']}..{record['tip_sha']}"), "1")

    def test_task_run_serializes_concurrent_callers_and_dispatches_one_worker(self) -> None:
        self.install_task_run_assets()
        task_runtime.task_file(self.controller, "X").write_text(
            "---\nid: X\nstatus: todo\n---\n## Goal\nShip once.\n"
            "## Acceptance\n- The committed file is validated.\n")
        git(self.controller, "add", ".juno_task/tasks", ".juno_task/workflows",
            ".juno_task/prompts/lifecycle")
        git(self.controller, "commit", "-m", "concurrent managed task")
        calls = 0
        call_lock = __import__("threading").Lock()

        def implement(_controller: Path, _task_id: str, record: dict,
                      _run_dir: Path, _prompt: Path, **_kwargs: object) -> dict:
            nonlocal calls
            with call_lock: calls += 1
            worktree = Path(record["worktree"])
            before = git(worktree, "rev-parse", "HEAD")
            (worktree / "src/managed.txt").write_text("managed\n")
            git(worktree, "add", "src/managed.txt")
            git(worktree, "commit", "-m", "managed implementation")
            return {"terminal_state": "completed", "before_sha": before,
                    "after_sha": git(worktree, "rev-parse", "HEAD"),
                    "receipt": {"path": "fixture", "sha256": "0" * 64},
                    "session_id": "fixture"}

        with mock.patch.object(task_runtime, "_launch_task_worker", side_effect=implement):
            with ThreadPoolExecutor(max_workers=2) as pool:
                results = [future.result(timeout=20) for future in
                           [pool.submit(task_runtime.managed_task_run,
                                        self.controller.resolve(), "X") for _ in range(2)]]
        self.assertEqual(calls, 1)
        self.assertEqual({row["state"] for row in results}, {"QUEUED"})
        self.assertEqual({row["run_id"] for row in results}, {results[0]["run_id"]})

    def test_task_run_recovers_committed_worker_and_resumes_blocked_revision_in_child(self) -> None:
        self.install_task_run_assets()
        task_path = task_runtime.task_file(self.controller, "X")
        task_path.write_text("---\nid: X\nstatus: todo\n---\n## Goal\nShip once.\n"
                             "## Acceptance\n- The committed file is validated.\n")
        git(self.controller, "add", ".juno_task/tasks", ".juno_task/workflows",
            ".juno_task/prompts/lifecycle")
        git(self.controller, "commit", "-m", "managed task revision one")
        calls: list[str] = []

        def worker(_controller: Path, _task_id: str, record: dict,
                   run_dir: Path, _prompt: Path, **_kwargs: object) -> dict:
            calls.append(run_dir.name)
            worktree = Path(record["worktree"])
            before = git(worktree, "rev-parse", "HEAD")
            if len(calls) == 1:
                return {"terminal_state": "blocked", "before_sha": before,
                        "after_sha": before, "receipt": {"path": "blocked", "sha256": "1" * 64},
                        "session_id": "blocked"}
            (worktree / "src/managed.txt").write_text("resolved\n")
            git(worktree, "add", "src/managed.txt")
            git(worktree, "commit", "-m", "resolved managed implementation")
            return {"terminal_state": "completed", "before_sha": before,
                    "after_sha": git(worktree, "rev-parse", "HEAD"),
                    "receipt": {"path": "completed", "sha256": "2" * 64},
                    "session_id": "completed"}

        with mock.patch.object(task_runtime, "_launch_task_worker", side_effect=worker):
            blocked = task_runtime.managed_task_run(self.controller.resolve(), "X")
            self.assertEqual(blocked["state"], "NEEDS_DECISION")
            repeated = task_runtime.managed_task_run(self.controller.resolve(), "X")
            self.assertEqual(repeated["run_id"], blocked["run_id"])
            self.assertEqual(len(calls), 1)
            task_path.write_text(task_path.read_text() + "\nOwner decision: proceed with resolved scope.\n")
            git(self.controller, "add", str(task_path.relative_to(self.controller)))
            git(self.controller, "commit", "-m", "resolve managed task decision")
            queued = task_runtime.managed_task_run(self.controller.resolve(), "X")
        self.assertEqual(queued["state"], "QUEUED")
        self.assertEqual(queued["run_id"], blocked["run_id"])
        self.assertEqual(calls, ["implementation-0001", "implementation-0002"])
        run_dir = self.controller / task_runtime.TASK_RUN_ROOT / "X" / queued["run_id"]
        prompts = sorted(run_dir.glob("workers/implementation-*/worker-prompt.md"))
        self.assertEqual(len(prompts), 0)  # mocked workers never materialize prompts
        journal = json.loads((run_dir / "journal.json").read_text())
        self.assertEqual(journal["attempts"]["decision_resumes"], 1)
        self.assertEqual(journal["attempts"]["worker_launches"], 2)

    def test_task_run_adopts_interrupted_projection_publication(self) -> None:
        self.install_task_run_assets()
        task_runtime.task_file(self.controller, "X").write_text(
            "---\nid: X\nstatus: todo\n---\n## Context\nTBD owner decision required\n")
        git(self.controller, "add", ".juno_task/tasks", ".juno_task/workflows",
            ".juno_task/prompts/lifecycle")
        git(self.controller, "commit", "-m", "ambiguous managed task")
        first = task_runtime.managed_task_run(self.controller.resolve(), "X")
        self.assertEqual(first["state"], "NEEDS_DECISION")
        run_dir = (self.controller / ".juno_task/runtime/lifecycle-runs/task/X" / first["run_id"])
        journal_path = run_dir / "journal.json"
        journal = json.loads(journal_path.read_text())
        # Simulate a crash after the projection write but before the journal
        # append: the exact numbered artifact stays, the journal rewinds.
        stranded = run_dir / "projections/0001-needs_decision.json"
        self.assertTrue(stranded.is_file())
        journal["projections"] = []
        journal["state"] = "CLAIMED"
        journal["events"] = []
        journal_path.write_text(json.dumps(journal, indent=1) + "\n")
        resumed = task_runtime.managed_task_run(self.controller.resolve(), "X")
        self.assertEqual(resumed["state"], "NEEDS_DECISION")
        self.assertEqual(resumed["run_id"], first["run_id"])
        recovered = json.loads(journal_path.read_text())
        self.assertEqual(len(recovered["projections"]), 1)
        self.assertEqual(recovered["projections"][0]["path"], str(stranded.resolve()))
        self.assertEqual(len(list((run_dir / "projections").glob("*.json"))), 1)
        # Tampered stranded bytes never become authoritative.
        journal["projections"] = []
        journal_path.write_text(json.dumps(journal, indent=1) + "\n")
        tampered = json.loads(stranded.read_text())
        tampered["state"] = "QUEUED"
        stranded.write_text(json.dumps(tampered, indent=1) + "\n")
        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError, "collision"):
            task_runtime.managed_task_run(self.controller.resolve(), "X")
        # A self-consistent artifact with a recomputed embedded digest still
        # refuses: adoption binds to the reconstructed projection, not to the
        # artifact's own attestation.
        journal["projections"] = []
        journal_path.write_text(json.dumps(journal, indent=1) + "\n")
        semantically_tampered = json.loads(stranded.read_text())
        semantically_tampered["state"] = "NEEDS_DECISION"
        semantically_tampered["attempts"]["implementation"] = 99
        lifecycle = task_runtime.lifecycle_runtime
        body = {k: v for k, v in semantically_tampered.items()
                if k != "projection_sha256"}
        semantically_tampered["projection_sha256"] = lifecycle.digest(body)
        stranded.write_text(lifecycle.canonical_bytes(semantically_tampered).decode())
        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError, "collision"):
            task_runtime.managed_task_run(self.controller.resolve(), "X")
        # An otherwise field-bound artifact whose embedded digest is invalid is
        # refused even though every nonvolatile field matches.
        journal["projections"] = []
        journal_path.write_text(json.dumps(journal, indent=1) + "\n")
        valid = json.loads(stranded.read_text())
        valid["attempts"]["implementation"] = 0
        body = {k: v for k, v in valid.items() if k != "projection_sha256"}
        valid["projection_sha256"] = "0" * 64
        self.assertNotEqual(valid["projection_sha256"], lifecycle.digest(body))
        stranded.write_text(lifecycle.canonical_bytes(valid).decode())
        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError, "collision"):
            task_runtime.managed_task_run(self.controller.resolve(), "X")

    def test_task_run_repairs_stale_terminal_pointer_from_journal(self) -> None:
        self.install_task_run_assets()
        task_runtime.task_file(self.controller, "X").write_text(
            "---\nid: X\nstatus: todo\n---\n## Goal\nShip once.\n"
            "## Acceptance\n- The committed file is validated.\n")
        git(self.controller, "add", ".juno_task/tasks", ".juno_task/workflows",
            ".juno_task/prompts/lifecycle")
        git(self.controller, "commit", "-m", "terminal managed task")

        def implement(_controller: Path, _task_id: str, record: dict,
                      run_dir: Path, _prompt: Path, **_kwargs: object) -> dict:
            worktree = Path(record["worktree"]); before = git(worktree, "rev-parse", "HEAD")
            (worktree / "src/managed.txt").write_text("managed\n")
            git(worktree, "add", "src/managed.txt"); git(worktree, "commit", "-m", "managed")
            receipt = run_dir / "managed-agent/receipt.json"; receipt.parent.mkdir(parents=True)
            receipt.write_text(json.dumps({"terminal_result": {"state": "completed"},
                                           "session_id": "fixture"}) + "\n")
            return {"terminal_state": "completed", "before_sha": before,
                    "after_sha": git(worktree, "rev-parse", "HEAD"),
                    "receipt": {"path": str(receipt),
                                "sha256": hashlib.sha256(receipt.read_bytes()).hexdigest()},
                    "session_id": "fixture"}

        with mock.patch.object(task_runtime, "_launch_task_worker", side_effect=implement):
            terminal = task_runtime.managed_task_run(self.controller.resolve(), "X")
        self.assertEqual(terminal["state"], "QUEUED")
        run_dir = self.controller / ".juno_task/runtime/lifecycle-runs/task/X" / terminal["run_id"]
        latest = self.controller / ".juno_task/runtime/lifecycle-runs/task/X/latest.json"
        # Simulate a crash between the terminal journal write and publication:
        # the pointer is stale and the summary was never written.
        (run_dir / "summary.json").unlink()
        latest.write_text(json.dumps({
            "schema_version": "juno_managed_task_run_latest.v2",
            "run_id": terminal["run_id"], "terminal": False,
            "projection_path": None, "summary": None}) + "\n")
        resumed = task_runtime.managed_task_run(self.controller.resolve(), "X")
        self.assertEqual(resumed["state"], "QUEUED")
        self.assertEqual(resumed["run_id"], terminal["run_id"])
        pointer = json.loads(latest.read_text())
        journal = json.loads((run_dir / "journal.json").read_text())
        self.assertTrue(pointer["terminal"])
        self.assertEqual(pointer["projection_path"],
                         journal["projections"][-1]["path"])
        self.assertIsInstance(pointer["summary"], dict)
        self.assertTrue((run_dir / "summary.json").is_file())
        # Tampered journal-referenced bytes are refused, not adopted.
        referenced = Path(journal["projections"][-1]["path"])
        tampered = json.loads(referenced.read_text())
        tampered["attempts"]["implementation"] = 99
        referenced.write_text(json.dumps(tampered, indent=1) + "\n")
        latest.write_text(json.dumps({
            "schema_version": "juno_managed_task_run_latest.v2",
            "run_id": terminal["run_id"], "terminal": False,
            "projection_path": None, "summary": None}) + "\n")
        with self.assertRaises(
                task_runtime.lifecycle_runtime.LifecycleContractError):
            task_runtime.managed_task_run(self.controller.resolve(), "X")
        # A missing final journal artifact fails closed even when the pointer
        # references an earlier valid projection.
        journal = json.loads((run_dir / "journal.json").read_text())
        final_path = Path(journal["projections"][-1]["path"])
        final_path.unlink()
        latest.write_text(json.dumps({
            "schema_version": "juno_managed_task_run_latest.v2",
            "run_id": terminal["run_id"], "terminal": True,
            "projection_path": str(final_path.resolve()), "summary": None}) + "\n")
        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError,
                                    "artifact is missing"):
            task_runtime.managed_task_run(self.controller.resolve(), "X")

    def test_task_run_hydration_gate_reruns_stale_evidence_before_worker_budget(self) -> None:
        self.install_task_run_assets()
        workflow = self.repository / ".juno_task/config/worktree-hydration.yaml"
        workflow.parent.mkdir(parents=True, exist_ok=True)
        workflow.write_text("""schema_version: v1
workflow_id: hydration-gate-fixture
workflow_class: task_hydration
steps:
  - id: ready
    name: Verify fixture readiness
    probe: ["true"]
    command: ["true"]
    timeout_seconds: 30
    fail_workflow: true
    non_interactive: true
    network: false
    sensitive: false
    outputs: []
""")
        git(self.repository, "add", str(workflow.relative_to(self.repository)))
        git(self.repository, "commit", "-m", "fixture hydration workflow")
        self.base = git(self.repository, "rev-parse", "HEAD")
        fake_runtime = self.root / "fake-runtime/task_workspace.py"
        fake_runtime.parent.mkdir(parents=True, exist_ok=True)
        fake_runtime.write_bytes(SCRIPT.read_bytes())
        runner = fake_runtime.with_name("workflow_runner.sh")
        runner.write_text(FIXTURE_HYDRATION_RUNNER)
        os.chmod(runner, 0o755)
        task_runtime.task_file(self.controller, "X").write_text(
            "---\nid: X\nstatus: todo\n---\n## Goal\nShip once.\n"
            "## Acceptance\n- The committed file is validated.\n")
        git(self.controller, "add", ".juno_task/tasks", ".juno_task/workflows",
            ".juno_task/prompts/lifecycle")
        git(self.controller, "commit", "-m", "hydrated managed task")
        with mock.patch.object(task_runtime, "__file__", str(fake_runtime)):
            task_runtime.start(self.controller.resolve(), "X")
            record = task_runtime.read_state(self.controller)["tasks"]["X"]
            self.assertEqual(record["state"], "WORKING")
            self.assertEqual(record["hydration"]["status"], "passed")
            # Stale evidence: the frozen manifest artifact disappeared after start.
            Path(record["hydration"]["manifest_path"]).unlink()
            calls: list[str] = []

            def implement(_controller: Path, _task_id: str, rec: dict,
                          run_dir: Path, _prompt: Path, **_kwargs: object) -> dict:
                calls.append(run_dir.name)
                worktree = Path(rec["worktree"])
                before = git(worktree, "rev-parse", "HEAD")
                (worktree / "src/managed.txt").write_text("managed\n")
                git(worktree, "add", "src/managed.txt")
                git(worktree, "commit", "-m", "managed implementation")
                return {"terminal_state": "completed", "before_sha": before,
                        "after_sha": git(worktree, "rev-parse", "HEAD"),
                        "receipt": {"path": "fixture", "sha256": "0" * 64},
                        "session_id": "fixture"}

            with mock.patch.object(task_runtime, "_launch_task_worker", side_effect=implement):
                projection = task_runtime.managed_task_run(self.controller.resolve(), "X")
        self.assertEqual(projection["state"], "QUEUED")
        self.assertEqual(calls, ["implementation-0001"])
        refreshed = task_runtime.read_state(self.controller)["tasks"]["X"]
        self.assertEqual(refreshed["hydration"]["status"], "passed")
        self.assertTrue(Path(refreshed["hydration"]["manifest_path"]).is_file())

    def test_task_run_hydration_gate_fails_closed_without_worker_budget(self) -> None:
        self.install_task_run_assets()
        workflow = self.repository / ".juno_task/config/worktree-hydration.yaml"
        workflow.parent.mkdir(parents=True, exist_ok=True)
        workflow.write_text("""schema_version: v1
workflow_id: hydration-gate-fixture
workflow_class: task_hydration
steps:
  - id: ready
    name: Verify fixture readiness
    probe: ["true"]
    command: ["true"]
    timeout_seconds: 30
    fail_workflow: true
    non_interactive: true
    network: false
    sensitive: false
    outputs: []
""")
        git(self.repository, "add", str(workflow.relative_to(self.repository)))
        git(self.repository, "commit", "-m", "fixture hydration workflow")
        self.base = git(self.repository, "rev-parse", "HEAD")
        fake_runtime = self.root / "fake-runtime/task_workspace.py"
        fake_runtime.parent.mkdir(parents=True, exist_ok=True)
        fake_runtime.write_bytes(SCRIPT.read_bytes())
        runner = fake_runtime.with_name("workflow_runner.sh")
        runner.write_text(FIXTURE_HYDRATION_RUNNER)
        os.chmod(runner, 0o755)
        task_runtime.task_file(self.controller, "X").write_text(
            "---\nid: X\nstatus: todo\n---\n## Goal\nShip once.\n"
            "## Acceptance\n- The committed file is validated.\n")
        git(self.controller, "add", ".juno_task/tasks", ".juno_task/workflows",
            ".juno_task/prompts/lifecycle")
        git(self.controller, "commit", "-m", "hydrated managed task")
        with mock.patch.object(task_runtime, "__file__", str(fake_runtime)):
            task_runtime.start(self.controller.resolve(), "X")
            record = task_runtime.read_state(self.controller)["tasks"]["X"]
            Path(record["hydration"]["manifest_path"]).unlink()
            # The authorized rerun itself fails: no receipts, no budget, no worker.
            runner.write_text("#!/usr/bin/env python3\nimport sys\n"
                              "print('hydration unrecoverable', file=sys.stderr)\n"
                              "raise SystemExit(9)\n")
            calls: list[str] = []

            def implement(*_args: object, **_kwargs: object) -> dict:
                calls.append("worker")
                raise AssertionError("worker must not launch while the gate fails")

            with mock.patch.object(task_runtime, "_launch_task_worker", side_effect=implement):
                with self.assertRaisesRegex(task_runtime.TaskWorkspaceError,
                                            "task hydration"):
                    task_runtime.managed_task_run(self.controller.resolve(), "X")
        self.assertEqual(calls, [])
        runs = self.controller / ".juno_task/runtime/lifecycle-runs/task/X"
        journals = sorted(runs.glob("*/journal.json"))
        self.assertEqual(len(journals), 1)
        journal = json.loads(journals[0].read_text())
        self.assertEqual(journal["attempts"]["worker_launches"], 0)
        self.assertEqual(journal["attempts"]["implementation"], 0)
        self.assertEqual(list((journals[0].parent / "workers").glob("*")), [])

    def test_task_run_incomplete_terminal_blocks_and_replays_idempotently(self) -> None:
        self.install_task_run_assets()
        task_runtime.task_file(self.controller, "X").write_text(
            "---\nid: X\nstatus: todo\n---\n## Goal\nShip once.\n"
            "## Acceptance\n- The committed file is validated.\n")
        git(self.controller, "add", ".juno_task/tasks", ".juno_task/workflows",
            ".juno_task/prompts/lifecycle")
        git(self.controller, "commit", "-m", "incomplete managed task")

        def implement(_controller: Path, _task_id: str, record: dict,
                      run_dir: Path, _prompt: Path, **_kwargs: object) -> dict:
            worktree = Path(record["worktree"])
            before = git(worktree, "rev-parse", "HEAD")
            receipt = run_dir / "managed-agent/receipt.json"
            receipt.parent.mkdir(parents=True)
            receipt.write_text(json.dumps({"terminal_result": {"state": "incomplete"},
                                           "session_id": "fixture"}) + "\n")
            return {"terminal_state": "incomplete", "before_sha": before,
                    "after_sha": before,
                    "receipt": {"path": str(receipt),
                                "sha256": hashlib.sha256(receipt.read_bytes()).hexdigest()},
                    "session_id": "fixture"}

        with mock.patch.object(task_runtime, "_launch_task_worker", side_effect=implement):
            blocked = task_runtime.managed_task_run(self.controller.resolve(), "X")
        self.assertEqual(blocked["state"], "BLOCKED")
        self.assertIn("explicit reviewed task-run replacement",
                      blocked["next_legal_action"])
        run_dir = self.controller / ".juno_task/runtime/lifecycle-runs/task/X" / blocked["run_id"]
        journal = json.loads((run_dir / "journal.json").read_text())
        self.assertTrue(journal["terminal"])
        # A second invocation replays the exact terminal BLOCKED projection
        # instead of rejecting its own valid terminal artifact.
        replay = task_runtime.managed_task_run(self.controller.resolve(), "X")
        self.assertEqual(replay["state"], "BLOCKED")
        self.assertEqual(replay["run_id"], blocked["run_id"])
        self.assertEqual(replay["next_legal_action"], blocked["next_legal_action"])
        replay_journal = json.loads((run_dir / "journal.json").read_text())
        self.assertEqual(replay_journal["projections"], journal["projections"])

    def test_managed_worker_receipts_use_effective_admission(self) -> None:
        self.install_task_run_assets()
        self.payload("start", "X")
        record = task_runtime.read_state(self.controller)["tasks"]["X"]
        supersession = {
            "schema_version": task_runtime.UMBRELLA_SUPERSESSION_SCHEMA,
            "umbrella_admission": {
                "union_paths": [*record["creation_receipt"]["allowed_paths"],
                                 "newly/authorized.txt"],
            },
            "generated_output_admission": {
                "schema_version": "juno_task_generated_output_admission.v1",
                "bindings": [], "declarations": {}, "destinations": []},
        }
        record["admission_supersessions"] = [supersession]
        record["admission_supersession_sha256"] = task_runtime.stable_sha256(supersession)
        run_dir = self.controller / ".juno_task/runtime/lifecycle-runs/task/X/receipt-fixture"
        run_dir.mkdir(parents=True)
        gate = {"dependency_evidence": [], "hydration_manifest_sha256": None}
        _create, verify, edit = task_runtime._managed_worker_receipts(run_dir, record, gate)
        create = json.loads((run_dir / "create-receipt.json").read_text())
        self.assertEqual(create["expected_paths"], supersession["umbrella_admission"]["union_paths"])
        self.assertEqual(create["admission_kind"], "superseding")
        self.assertEqual(create["admission_supersession_sha256"],
                         record["admission_supersession_sha256"])
        verify_value = json.loads(verify.read_text())
        self.assertTrue(verify_value["passed"])
        self.assertIn("dependency_evidence", verify_value)
        self.assertIn("hydration_manifest_sha256", verify_value)
        edit_value = json.loads(edit.read_text())
        self.assertEqual(edit_value["allowed_paths_sha256"],
                         task_runtime.stable_sha256(
                             supersession["umbrella_admission"]["union_paths"]))
        # Without a supersession the historical creation admission remains
        # the effective worker authority.
        plain = task_runtime.read_state(self.controller)["tasks"]["X"]
        run_dir2 = run_dir.parent / "receipt-fixture-plain"
        run_dir2.mkdir(parents=True)
        task_runtime._managed_worker_receipts(run_dir2, plain, gate)
        create2 = json.loads((run_dir2 / "create-receipt.json").read_text())
        self.assertEqual(create2["expected_paths"],
                         plain["creation_receipt"]["allowed_paths"])
        self.assertEqual(create2["admission_kind"], "historical_creation")
        self.assertNotIn("admission_supersession_sha256", create2)

    def test_task_run_hydration_gate_detects_dependency_tree_drift_and_heals(self) -> None:
        self.install_task_run_assets()
        package = self.repository / "src"
        (package / ".gitignore").write_text("node_modules/\n")
        (package / "package.json").write_text(json.dumps(
            {"name": "fixture", "version": "1.0.0",
             "dependencies": {"left-pad": "1.3.0"}}) + "\n")
        (package / "package-lock.json").write_text(json.dumps(
            {"name": "fixture", "version": "1.0.0", "lockfileVersion": 3,
             "packages": {"": {"name": "fixture", "version": "1.0.0",
                               "dependencies": {"left-pad": "1.3.0"}},
                          "node_modules/left-pad": {"version": "1.3.0",
                                                     "resolved": "left-pad",
                                                     "integrity": "sha512-fixture"}}}) + "\n")
        workflow = self.repository / ".juno_task/config/worktree-hydration.yaml"
        workflow.parent.mkdir(parents=True, exist_ok=True)
        workflow.write_text("""schema_version: v1
workflow_id: hydration-gate-fixture
workflow_class: task_hydration
steps:
  - id: ready
    name: Verify fixture readiness
    probe: ["true"]
    command: ["true"]
    timeout_seconds: 30
    fail_workflow: true
    non_interactive: true
    network: false
    sensitive: false
    outputs: []
""")
        git(self.repository, "add", "src/.gitignore", "src/package.json", "src/package-lock.json",
            str(workflow.relative_to(self.repository)))
        git(self.repository, "commit", "-m", "fixture hydration workflow with exact lock")
        self.base = git(self.repository, "rev-parse", "HEAD")
        fake_runtime = self.root / "fake-runtime/task_workspace.py"
        fake_runtime.parent.mkdir(parents=True, exist_ok=True)
        fake_runtime.write_bytes(SCRIPT.read_bytes())
        runner = fake_runtime.with_name("workflow_runner.sh")
        runner.write_text(FIXTURE_INSTALLING_HYDRATION_RUNNER)
        os.chmod(runner, 0o755)
        task_runtime.task_file(self.controller, "X").write_text(
            "---\nid: X\nstatus: todo\n---\n## Goal\nShip once.\n"
            "## Acceptance\n- The committed file is validated.\n")
        git(self.controller, "add", ".juno_task/tasks", ".juno_task/workflows",
            ".juno_task/prompts/lifecycle")
        git(self.controller, "commit", "-m", "hydrated managed task")
        with mock.patch.object(task_runtime, "__file__", str(fake_runtime)):
            task_runtime.start(self.controller.resolve(), "X")
            record = task_runtime.read_state(self.controller)["tasks"]["X"]
            worktree = Path(record["worktree"])
            self.assertTrue((worktree / "src/node_modules/left-pad").is_dir())
            # Corrupt the installed dependency tree: the lock, stamp, and
            # sentinel all remain intact, so only package-tree validation
            # can detect the drift.
            shutil.rmtree(worktree / "src/node_modules/left-pad")
            calls: list[str] = []

            def implement(_controller: Path, _task_id: str, rec: dict,
                          run_dir: Path, _prompt: Path, **_kwargs: object) -> dict:
                calls.append(run_dir.name)
                tree = Path(rec["worktree"])
                before = git(tree, "rev-parse", "HEAD")
                (tree / "src/managed.txt").write_text("managed\n")
                git(tree, "add", "src/managed.txt")
                git(tree, "commit", "-m", "managed implementation")
                return {"terminal_state": "completed", "before_sha": before,
                        "after_sha": git(tree, "rev-parse", "HEAD"),
                        "receipt": {"path": "fixture", "sha256": "0" * 64},
                        "session_id": "fixture"}

            # An unrecoverable rerun (hydration "passes" without healing)
            # fails closed before any worker budget; the tree stays corrupt
            # from the drift above.
            runner.write_text(FIXTURE_HYDRATION_RUNNER)
            os.chmod(runner, 0o755)
            with mock.patch.object(
                    task_runtime, "_launch_task_worker",
                    side_effect=lambda *a, **k: (_ for _ in ()).throw(
                        AssertionError("worker must not launch"))):
                with self.assertRaisesRegex(
                        task_runtime.TaskWorkspaceError,
                        "installed Node dependency tree"):
                    task_runtime.managed_task_run(self.controller.resolve(), "X")

            # A healing rerun restores the exact installed tree and the worker
            # proceeds only after the gate re-verifies it.
            runner.write_text(FIXTURE_INSTALLING_HYDRATION_RUNNER)
            os.chmod(runner, 0o755)
            with mock.patch.object(task_runtime, "_launch_task_worker",
                                   side_effect=implement):
                projection = task_runtime.managed_task_run(
                    self.controller.resolve(), "X")
            self.assertEqual(projection["state"], "QUEUED")
            self.assertEqual(calls, ["implementation-0001"])
            self.assertTrue((worktree / "src/node_modules/left-pad").is_dir())

    def test_task_run_decision_receipt_is_idempotent_and_refuses_mismatch(self) -> None:
        self.install_task_run_assets()
        ambiguous = ("---\nid: X\nstatus: todo\n---\n## Context\n"
                     "TBD owner decision required\n")
        task_runtime.task_file(self.controller, "X").write_text(ambiguous)
        git(self.controller, "add", ".juno_task/tasks", ".juno_task/workflows",
            ".juno_task/prompts/lifecycle")
        git(self.controller, "commit", "-m", "ambiguous decision task")
        first = task_runtime.managed_task_run(self.controller.resolve(), "X")
        self.assertEqual(first["state"], "NEEDS_DECISION")
        run_dir = self.controller / ".juno_task/runtime/lifecycle-runs/task/X" / first["run_id"]
        decisions = sorted((run_dir / "decisions").glob("*.json"))
        self.assertEqual(len(decisions), 1)
        # An unchanged rerun reuses the immutable receipt and republishes.
        second = task_runtime.managed_task_run(self.controller.resolve(), "X")
        self.assertEqual(second["state"], "NEEDS_DECISION")
        self.assertEqual(sorted((run_dir / "decisions").glob("*.json")), decisions)
        journal = json.loads((run_dir / "journal.json").read_text())
        self.assertEqual(len(journal.get("decision_receipts", [])), 1)
        original_bytes = decisions[0].read_bytes()
        # Semantically different bytes refuse.
        tampered = json.loads(decisions[0].read_text())
        tampered["questions"] = ["different question?"]
        decisions[0].write_text(json.dumps(tampered, indent=1) + "\n")
        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError,
                                    "decision receipt collision"):
            task_runtime.managed_task_run(self.controller.resolve(), "X")
        # Byte-only differences refuse even when the JSON value is unchanged.
        equivalent = json.loads(decisions[0].read_text())
        decisions[0].write_text(json.dumps(equivalent, indent=4, sort_keys=True) + "\n")
        with self.assertRaisesRegex(task_runtime.TaskWorkspaceError,
                                    "decision receipt collision"):
            task_runtime.managed_task_run(self.controller.resolve(), "X")
        # Restoring the exact canonical bytes resumes and repairs a journal
        # reference whose hash went stale.
        decisions[0].write_bytes(original_bytes)
        run_journal = json.loads((run_dir / "journal.json").read_text())
        run_journal["decision_receipts"] = [{"path": str(decisions[0].resolve()),
                                             "sha256": "0" * 64}]
        (run_dir / "journal.json").write_text(json.dumps(run_journal, indent=1) + "\n")
        resumed = task_runtime.managed_task_run(self.controller.resolve(), "X")
        self.assertEqual(resumed["state"], "NEEDS_DECISION")
        repaired = json.loads((run_dir / "journal.json").read_text())
        import hashlib as _hashlib
        self.assertEqual(repaired["decision_receipts"][0]["sha256"],
                         _hashlib.sha256(decisions[0].read_bytes()).hexdigest())

    def test_task_run_recovers_after_implementation_commit_checkpoint_crash(self) -> None:
        self.install_task_run_assets()
        task_runtime.task_file(self.controller, "X").write_text(
            "---\nid: X\nstatus: todo\n---\n## Goal\nShip once.\n"
            "## Acceptance\n- The committed file is validated.\n")
        git(self.controller, "add", ".juno_task/tasks", ".juno_task/workflows",
            ".juno_task/prompts/lifecycle")
        git(self.controller, "commit", "-m", "crash managed task")
        real_checkpoint = task_runtime.lifecycle_runtime.lifecycle_checkpoint
        crashed = False
        launches = 0

        def implement(_controller: Path, _task_id: str, record: dict,
                      run_dir: Path, _prompt: Path, **_kwargs: object) -> dict:
            nonlocal launches
            launches += 1
            worktree = Path(record["worktree"]); before = git(worktree, "rev-parse", "HEAD")
            (worktree / "src/managed.txt").write_text("managed\n")
            git(worktree, "add", "src/managed.txt"); git(worktree, "commit", "-m", "managed")
            receipt = run_dir / "managed-agent/receipt.json"; receipt.parent.mkdir(parents=True)
            receipt.write_text(json.dumps({"terminal_result": {"state": "completed"},
                                           "session_id": "fixture"}) + "\n")
            return {"terminal_state": "completed", "before_sha": before,
                    "after_sha": git(worktree, "rev-parse", "HEAD"),
                    "receipt": {"path": str(receipt),
                                "sha256": hashlib.sha256(receipt.read_bytes()).hexdigest()},
                    "session_id": "fixture"}

        def checkpoint(*args: object, **kwargs: object) -> dict:
            nonlocal crashed
            if (kwargs.get("phase") == "implementation-1"
                    and kwargs.get("boundary") == "POST" and not crashed):
                crashed = True
                raise OSError("fixture crash after implementation commit")
            return real_checkpoint(*args, **kwargs)

        with mock.patch.object(task_runtime, "_launch_task_worker", side_effect=implement), \
             mock.patch.object(task_runtime.lifecycle_runtime, "lifecycle_checkpoint",
                               side_effect=checkpoint):
            with self.assertRaisesRegex(task_runtime.TaskWorkspaceError, "fixture crash"):
                task_runtime.managed_task_run(self.controller.resolve(), "X")
        with mock.patch.object(task_runtime, "_launch_task_worker",
                               side_effect=AssertionError("worker relaunched")):
            queued = task_runtime.managed_task_run(self.controller.resolve(), "X")
        self.assertEqual(queued["state"], "QUEUED")
        self.assertEqual(launches, 1)

    def test_standing_evidence_replay_cuts_redundant_runs_by_eighty_percent(self) -> None:
        counter = self.root / "standing-counter.txt"
        code = f"from pathlib import Path; Path({str(counter)!r}).open('a').write('run\\n')"
        self.write_policy(validation_code=code)
        self.payload("start", "X")
        self.commit_task("X")
        first_plan = self.payload("checkpoint", "X")
        runs = [self.payload("evidence-run", "X") for _ in range(5)]
        self.assertEqual(first_plan["plan_sha256"], runs[0]["plan_sha256"])
        self.assertEqual(runs[0]["executed"], 1)
        self.assertTrue(all(item["reused"] == 1 for item in runs[1:]))
        self.assertEqual(counter.read_text().splitlines(), ["run"])
        baseline, actual = 5, len(counter.read_text().splitlines())
        self.assertGreaterEqual((baseline - actual) / baseline, 0.8)

        worktree = self.workspaces / "X"
        (worktree / "src/repair.txt").write_text("repair\n")
        git(worktree, "add", "src/repair.txt")
        git(worktree, "commit", "-m", "repair")
        repaired = self.payload("checkpoint", "X")
        self.assertNotEqual(repaired["plan_sha256"], first_plan["plan_sha256"])
        superseded = (self.controller / task_runtime.STANDING_ROOT / "X" /
                      first_plan["plan_sha256"] /
                      f"superseded-by-{repaired['plan_sha256']}.json")
        self.assertEqual(json.loads(superseded.read_text())["outcome"], "SUPERSEDED")


class MinimumRcLifecycleContractTests(unittest.TestCase):
    def test_documentation_routes_inert_active_and_unsafe_without_process_guessing(self) -> None:
        lifecycle = task_runtime.lifecycle_runtime
        inert = lifecycle.documentation_route([{"status": "M", "path": "AGENTS.md"}])
        self.assertEqual(inert["mode"], "inert_zero_command")
        active = lifecycle.documentation_route([{"status": "M", "path": "README.md"}])
        self.assertEqual(active["mode"], "active_audit")
        for rows in ([{"status": "M", "path": "README.md"}, {"status": "M", "path": "src/a.ts"}],
                     [{"status": "D", "path": "AGENTS.md"}],
                     [{"status": "M", "path": "package-lock.json"}]):
            self.assertEqual(lifecycle.documentation_route(rows)["mode"], "fallback")

    def test_zero_exit_with_parsed_failures_is_not_reusable_pass(self) -> None:
        integrity = task_runtime.lifecycle_runtime.parsed_test_result_integrity(
            ["npm", "test"], b"Test Files  2 failed\nTests  4 failed\n", 0)
        self.assertTrue(integrity["contradiction"])
        self.assertFalse(integrity["eligible_pass"])
        self.assertTrue(task_runtime.lifecycle_runtime.parsed_test_result_integrity(
            ["npm", "test"], b"Test Files  9 passed\n", 0)["eligible_pass"])

    def test_real_zero_exit_with_failed_test_summary_becomes_terminal_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            subprocess.run(["git", "init", "-b", "main"], cwd=root, check=True,
                           stdout=subprocess.DEVNULL)
            subprocess.run(["git", "config", "user.email", "test@example.invalid"], cwd=root, check=True)
            subprocess.run(["git", "config", "user.name", "Test"], cwd=root, check=True)
            (root / "tracked.txt").write_text("x\n")
            subprocess.run(["git", "add", "."], cwd=root, check=True)
            subprocess.run(["git", "commit", "-m", "base"], cwd=root, check=True,
                           stdout=subprocess.DEVNULL)
            result = task_runtime.run_validation({
                "id": "contradictory", "cwd": "src",
                "argv": [sys.executable, "-c", "print('Test Files  1 failed')"],
                "timeout_seconds": 10, "max_output_bytes": 4096,
            }, root)
            self.assertEqual(result["process_exit_code"], 0)
            self.assertEqual(result["exit_code"], 65)
            self.assertFalse(result["result_integrity"]["eligible_pass"])

    def test_failure_summary_before_large_diagnostics_is_never_pass_eligible(self) -> None:
        output = b"Tests  1 failed\n" + (b"diagnostic payload\n" * 140000)
        self.assertGreater(len(output), 2 * 1024 * 1024)
        integrity = task_runtime.lifecycle_runtime.parsed_test_result_integrity(
            ["npm", "test"], output, 0)
        self.assertFalse(integrity["eligible_pass"])
        self.assertTrue(integrity["contradiction"])
        self.assertGreaterEqual(integrity["parsed_failure_count"], 1)
        self.assertEqual(integrity["output_bytes"], len(output))

    def test_readiness_gate_is_deterministic_and_edits_no_product_bytes(self) -> None:
        lifecycle = task_runtime.lifecycle_runtime
        self.assertEqual(lifecycle.readiness_questions(
            b"## Goal\nShip it\n## Acceptance\n- proven\n"), [])
        questions = lifecycle.readiness_questions(b"## Context\nTBD owner decision required\n")
        self.assertGreaterEqual(len(questions), 3)

    def test_command_closure_names_each_changed_identity_field(self) -> None:
        lifecycle = task_runtime.lifecycle_runtime
        previous = {"input_closure_sha256": "a", "runtime_sha256": "old",
                    "dependency_locks": {"x": "1"}, "observable_tree": "tree"}
        current = {"input_closure_sha256": "b", "runtime_sha256": "new",
                   "dependency_locks": {"x": "2"}, "observable_tree": "tree"}
        self.assertEqual([row["field"] for row in lifecycle.closure_invalidation(previous, current)],
                         ["dependency_locks", "runtime_sha256"])
        decisions = [lifecycle.evidence_decision("a", "reused", closure=current),
                     lifecycle.evidence_decision("b", "executed", closure=current),
                     lifecycle.evidence_decision("c", "invalidated", closure=current)]
        self.assertEqual(lifecycle.evidence_counters(decisions)["reused"], 1)
        self.assertEqual(lifecycle.evidence_counters(decisions)["executed"], 1)

    def test_command_closure_binds_allowlisted_environment_and_npm_toolchain_fieldwise(self) -> None:
        lifecycle = task_runtime.lifecycle_runtime
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); bin_dir = root / "bin"; bin_dir.mkdir()
            (bin_dir / "node").write_text("#!/bin/sh\necho v22.1.0\n")
            (bin_dir / "npm").write_text("#!/bin/sh\necho 10.2.0\n")
            (bin_dir / "node").chmod(0o755); (bin_dir / "npm").chmod(0o755)
            subprocess.run(["git", "init", "-b", "main"], cwd=root, check=True,
                           stdout=subprocess.DEVNULL)
            subprocess.run(["git", "config", "user.email", "test@example.invalid"], cwd=root, check=True)
            subprocess.run(["git", "config", "user.name", "Test"], cwd=root, check=True)
            (root / "package-lock.json").write_text("{}\n")
            subprocess.run(["git", "add", "."], cwd=root, check=True)
            subprocess.run(["git", "commit", "-m", "base"], cwd=root, check=True,
                           stdout=subprocess.DEVNULL)
            head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root,
                                           text=True).strip()
            row = {"id": "npm", "cwd": "", "argv": ["npm", "test"],
                   "timeout_seconds": 10, "max_output_bytes": 4096}
            first_env = {"PATH": str(bin_dir), "HOME": str(root), "CI": "1",
                         "SECRET_TOKEN": "must-not-bind"}
            first = lifecycle.command_closure(
                root, head, row, config_sha256="a" * 64, policy_sha256=None,
                runtime_sha256="b" * 64, environment=first_env)
            self.assertEqual(first["environment"], {
                "CI": "1", "HOME": str(root), "PATH": str(bin_dir)})
            self.assertNotIn("SECRET_TOKEN", first["environment"])
            self.assertEqual({item["name"] for item in first["executables"]}, {"npm", "node"})
            self.assertEqual(first["command_runtime"]["npm"]["version"], "10.2.0")
            drifted = lifecycle.command_closure(
                root, head, row, config_sha256="a" * 64, policy_sha256=None,
                runtime_sha256="b" * 64, environment={**first_env, "CI": "0"})
            self.assertEqual([row["field"] for row in
                              lifecycle.closure_invalidation(first, drifted)], ["environment"])
            (bin_dir / "npm").write_text("#!/bin/sh\necho 10.3.0\n")
            tool_drift = lifecycle.command_closure(
                root, head, row, config_sha256="a" * 64, policy_sha256=None,
                runtime_sha256="b" * 64, environment=first_env)
            fields = [row["field"] for row in lifecycle.closure_invalidation(first, tool_drift)]
            self.assertEqual(fields, ["command_runtime", "executables"])

    def test_active_documentation_audits_false_guidance_then_reuses_corrected_identity(self) -> None:
        lifecycle = task_runtime.lifecycle_runtime
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            subprocess.run(["git", "init", "-b", "main"], cwd=root, check=True,
                           stdout=subprocess.DEVNULL)
            subprocess.run(["git", "config", "user.email", "test@example.invalid"], cwd=root, check=True)
            subprocess.run(["git", "config", "user.name", "Test"], cwd=root, check=True)
            files = {
                "juno-code/package.json": json.dumps({"name": "@yylo/cli", "version": "1.2.3"}) + "\n",
                "juno-code/src/cli/commands/task.ts": "task.command('task'); task.command('run').option('--path <path>');\n",
                "juno-code/src/bin/cli.ts": "program.command('task');\n",
                "src/schema.py": "SCHEMA = 'juno_known_schema.v1'\n",
                "README.md": ("[wrong](https://github.com/example/not-yylo)\n"
                              "```bash\nyy task imaginary --invented\n"
                              "npm install -g @yylo/cli@9.9.9\n```\n"
                              "`juno_unknown_schema.v9`\n"),
                "MIGRATION.md": "Move to the new runtime.\n",
                "RELEASE_NOTES.md": "# Release 9.9.9\n",
            }
            for relative, content in files.items():
                target = root / relative; target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(content)
            subprocess.run(["git", "add", "."], cwd=root, check=True)
            subprocess.run(["git", "commit", "-m", "bad docs"], cwd=root, check=True,
                           stdout=subprocess.DEVNULL)
            bad_head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root,
                                               text=True).strip()
            policy = lifecycle.default_documentation_policy()
            paths = ["README.md", "MIGRATION.md", "RELEASE_NOTES.md"]
            bad = lifecycle.active_documentation_audit(root, bad_head, paths, policy)
            codes = {finding["code"] for finding in bad["findings"]}
            self.assertTrue({"active_doc.unknown_public_identity",
                             "active_doc.unknown_cli_subcommand",
                             "active_doc.unknown_cli_option",
                             "active_doc.install_identity_mismatch",
                             "active_doc.unknown_schema_identity",
                             "active_doc.incoherent_migration_guidance",
                             "active_doc.release_identity_mismatch"}.issubset(codes),
                            bad["findings"])
            (root / "README.md").write_text(
                "[project](https://github.com/yylo-dev/yylo)\n"
                "```bash\nyy task run TASK_ID --path src\n"
                "npm install -g @yylo/cli@1.2.3\n```\n`juno_known_schema.v1`\n")
            (root / "MIGRATION.md").write_text(
                "Migrate from 1.2.2 to 1.2.3. Rollback restores 1.2.2.\n")
            (root / "RELEASE_NOTES.md").write_text("# 1.2.3\n")
            subprocess.run(["git", "add", "."], cwd=root, check=True)
            subprocess.run(["git", "commit", "-m", "correct docs"], cwd=root, check=True,
                           stdout=subprocess.DEVNULL)
            head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root,
                                           text=True).strip()
            corrected = lifecycle.active_documentation_audit(root, head, paths, policy)
            repeated = lifecycle.active_documentation_audit(root, head, paths, policy)
            self.assertEqual(corrected["outcome"], "PASSED", corrected["findings"])
            self.assertEqual(repeated["audit_sha256"], corrected["audit_sha256"])

    def test_active_documentation_accepts_tracked_directory_links_and_rejects_missing_links(self) -> None:
        lifecycle = task_runtime.lifecycle_runtime
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            subprocess.run(["git", "init", "-b", "main"], cwd=root, check=True,
                           stdout=subprocess.DEVNULL)
            subprocess.run(["git", "config", "user.email", "test@example.invalid"], cwd=root, check=True)
            subprocess.run(["git", "config", "user.name", "Test"], cwd=root, check=True)
            (root / "docs").mkdir(); (root / "docs/guide.md").write_text("guide\n")
            (root / "README.md").write_text("[docs](./docs/) [missing](./missing/)\n")
            subprocess.run(["git", "add", "."], cwd=root, check=True)
            subprocess.run(["git", "commit", "-m", "docs"], cwd=root, check=True,
                           stdout=subprocess.DEVNULL)
            head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
            audit = lifecycle.active_documentation_audit(root, head, ["README.md"])
            self.assertEqual(audit["findings"], [{
                "code": "active_doc.broken_relative_link", "path": "README.md",
                "target": "./missing/",
            }])

    def test_grouped_coherence_collects_all_seeded_cheap_defects_in_one_report(self) -> None:
        lifecycle = task_runtime.lifecycle_runtime
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            subprocess.run(["git", "init", "-b", "product"], cwd=root, check=True,
                           stdout=subprocess.DEVNULL)
            subprocess.run(["git", "config", "user.email", "test@example.invalid"], cwd=root, check=True)
            subprocess.run(["git", "config", "user.name", "Test"], cwd=root, check=True)
            files = {
                ".juno_task/config/task-workspace.json": "{}\n",
                "juno-code/package.json": json.dumps({"name": "pkg", "version": "1.0.0"}) + "\n",
                "juno-code/package-lock.json": json.dumps({"packages": {"": {"name": "pkg", "version": "1.0.0"}}}) + "\n",
                "juno-code/scripts/implementation-contract.json": json.dumps({"source": "canonical.txt", "destinations": ["generated.txt"]}) + "\n",
                "canonical.txt": "same\n", "generated.txt": "same\n",
                "juno-code/src/templates/managed-assets.json": json.dumps({"admissionOutputs": [{"source": "canonical.txt", "destination": "managed.txt"}]}) + "\n",
                "juno-code/src/templates/canonical.txt": "managed\n", "managed.txt": "managed\n",
            }
            for relative, content in files.items():
                path = root / relative; path.parent.mkdir(parents=True, exist_ok=True); path.write_text(content)
            subprocess.run(["git", "add", "."], cwd=root, check=True)
            subprocess.run(["git", "commit", "-m", "base"], cwd=root, check=True,
                           stdout=subprocess.DEVNULL)
            (root / "juno-code/package.json").write_text(json.dumps({
                "name": "pkg", "version": "2.0.0", "bin": {"missing": "dist/missing.js"}}) + "\n")
            (root / ".juno_task/config/task-workspace.json").write_text("{malformed\n")
            (root / "canonical.txt").write_text("new source\n")
            (root / "juno-code/src/templates/canonical.txt").write_text("new managed source\n")
            subprocess.run(["git", "add", "."], cwd=root, check=True)
            subprocess.run(["git", "commit", "-m", "seed defects"], cwd=root, check=True,
                           stdout=subprocess.DEVNULL)
            head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
            changed = subprocess.check_output(
                ["git", "diff", "--name-only", "HEAD^..HEAD"], cwd=root, text=True).splitlines()
            report = lifecycle.grouped_coherence(root, root, head, changed)
            codes = {row["code"] for row in report["findings"]}
            self.assertTrue({"coherence.package_lock_identity",
                             "coherence.executable_delegate_missing",
                             "coherence.config_malformed",
                             "coherence.generated_output_mismatch",
                             "coherence.managed_output_mismatch"}.issubset(codes))
            self.assertEqual(report["outcome"], "FAILED")

    def test_compiler_binds_committed_template_prompt_and_refuses_mutation(self) -> None:
        lifecycle = task_runtime.lifecycle_runtime
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            subprocess.run(["git", "init", "-b", "controller"], cwd=root, check=True,
                           stdout=subprocess.DEVNULL)
            subprocess.run(["git", "config", "user.email", "test@example.invalid"], cwd=root, check=True)
            subprocess.run(["git", "config", "user.name", "Test"], cwd=root, check=True)
            workflow = root / ".juno_task/workflows/yy-task-run.yaml"
            prompt_a = root / ".juno_task/prompts/lifecycle/task-implementation.md"
            prompt_b = root / ".juno_task/prompts/lifecycle/task-test-repair.md"
            workflow.parent.mkdir(parents=True); prompt_a.parent.mkdir(parents=True)
            source = Path(__file__).resolve().parents[2]
            if not (source / "workflows/yy-task-run.yaml").is_file():
                source = Path(__file__).resolve().parents[3] / "juno-code/src/templates"
            workflow.write_bytes((source / "workflows/yy-task-run.yaml").read_bytes())
            prompt_a.write_bytes((source / "prompts/lifecycle/task-implementation.md").read_bytes())
            prompt_b.write_bytes((source / "prompts/lifecycle/task-test-repair.md").read_bytes())
            subprocess.run(["git", "add", "."], cwd=root, check=True)
            subprocess.run(["git", "commit", "-m", "assets"], cwd=root, check=True,
                           stdout=subprocess.DEVNULL)
            plan = lifecycle.compile_lifecycle_template(root, "task-run", "T1")
            self.assertEqual(plan["template"]["id"], "canonical-task-run")
            prompt_a.write_text("model-authored mutation\n")
            with self.assertRaisesRegex(lifecycle.LifecycleContractError, "uncommitted|drifted"):
                lifecycle.compile_lifecycle_template(root, "task-run", "T1")


if __name__ == "__main__":
    if len(sys.argv) >= 6 and sys.argv[1] == "--resource-lock-guard-probe":
        _protocol_guard_probe(
            _configured_lock_path(sys.argv[2]),
            Path(sys.argv[3]), Path(sys.argv[4]), Path(sys.argv[5]),
        )
    elif len(sys.argv) >= 3 and sys.argv[1] == "--resource-lock-birth":
        print(json.dumps(_process_birth_identity(int(sys.argv[2]))))
    elif len(sys.argv) >= 5 and sys.argv[1] == "--resource-lock-op":
        operation, lock_argument, payload_argument = sys.argv[2:5]
        print(json.dumps(_protocol_operation(
            _configured_lock_path(lock_argument), operation, json.loads(payload_argument),
        )))
    else:
        unittest.main()
