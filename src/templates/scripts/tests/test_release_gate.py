#!/usr/bin/env python3
from __future__ import annotations
import hashlib, importlib.util, json
from pathlib import Path
import shutil, tempfile, unittest

SCRIPT = Path(__file__).resolve().parents[1] / "release_gate.py"
SPEC = importlib.util.spec_from_file_location("release_gate", SCRIPT); assert SPEC and SPEC.loader
gate = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(gate)
SHA, POLICY = "1" * 40, "2" * 64


class ReleaseGateTest(unittest.TestCase):
    def setUp(self): self.temp = Path(tempfile.mkdtemp(prefix="juno-release-gate-test-"))
    def tearDown(self): shutil.rmtree(self.temp, ignore_errors=True)
    def auth(self, **changes):
        value = {"schema_version": gate.AUTH_SCHEMA, "candidate_sha": SHA,
                 "policy_identity": POLICY, "owner_id": "owner-1",
                 "authorized_scopes": ["local_release"]}; value.update(changes)
        path = self.temp / "authorization.json"; data = gate.canonical(value); path.write_bytes(data)
        return path, hashlib.sha256(data).hexdigest()
    def test_canonical_producer_binds_owner_candidate_and_policy(self):
        path, mark = self.auth(); output = self.temp / "receipt.json"
        value = gate.produce(path, mark, SHA, POLICY, output)
        self.assertEqual(gate.PRODUCER_SCHEMA, value["producer_schema"])
        self.assertEqual(mark, value["owner_authorization_sha256"])
        self.assertEqual(value, json.loads(output.read_text()))
    def test_unknown_fields_scope_drift_and_digest_forgery_are_refused(self):
        for changes in ({"transcript": "bad"}, {"authorized_scopes": ["publish"]},
                        {"candidate_sha": "3" * 40}):
            path, mark = self.auth(**changes)
            with self.assertRaises(gate.ReleaseGateError):
                gate.produce(path, mark, SHA, POLICY, self.temp / "receipt.json")
        path, _ = self.auth()
        with self.assertRaisesRegex(gate.ReleaseGateError, "digest/content"):
            gate.produce(path, "f" * 64, SHA, POLICY, self.temp / "receipt.json")


if __name__ == "__main__": unittest.main()
