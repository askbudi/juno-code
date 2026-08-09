#!/usr/bin/env python3
from __future__ import annotations
import hashlib, json, os
from pathlib import Path
import shutil, subprocess, sys, tempfile, time, unittest

RUNNER = Path(__file__).resolve().parents[1] / "managed_agent_runner.py"


def git(root: Path, *args: str) -> str:
    return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()


class ManagedAgentRunnerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="managed-agent-test-"))
        self.controller = self.tmp / "controller"; self.controller.mkdir()
        subprocess.run(["git", "init", "-b", "controller", str(self.controller)], check=True, stdout=subprocess.DEVNULL)
        (self.controller / ".juno_task/prompts").mkdir(parents=True)
        (self.controller / ".juno_task/prompts/reflect.md").write_text("controller reflect\n")
        self.env_target = self.tmp / "controller.env"; self.env_target.write_text("MANAGED_TEST_SECRET=not-for-receipts\n")
        os.symlink(self.env_target, self.controller / ".env.juno")
        config = {"defaultSubagent":"pi", "defaultModel":":configured", "defaultModels":{"pi":":configured"},
                  "envFilePath":".env.juno", "promptMacros":{"global":{"reflect":{"path":".juno_task/prompts/reflect.md"}},"local":{}}}
        (self.controller / ".juno_task/config.json").write_text(json.dumps(config) + "\n")
        subprocess.run(["git", "-C", str(self.controller), "add", "."], check=True)
        subprocess.run(["git", "-C", str(self.controller), "-c", "user.name=T", "-c", "user.email=t@t", "commit", "-m", "controller"], check=True, stdout=subprocess.DEVNULL)
        self.candidate = self.tmp / "candidate"; self.candidate.mkdir()
        subprocess.run(["git", "init", "-b", "task", str(self.candidate)], check=True, stdout=subprocess.DEVNULL)
        (self.candidate / "allowed.txt").write_text("base\n")
        subprocess.run(["git", "-C", str(self.candidate), "add", "."], check=True)
        subprocess.run(["git", "-C", str(self.candidate), "-c", "user.name=T", "-c", "user.email=t@t", "commit", "-m", "base"], check=True, stdout=subprocess.DEVNULL)
        self.bin = self.tmp / "bin"; self.bin.mkdir()
        fake = self.bin / "yy"
        fake.write_text("""#!/usr/bin/env python3
import json, os, pathlib, sys, time
assert sys.argv[1:3] == ['pi','--config']; assert '-f' in sys.argv and '-p' not in sys.argv
assert not sys.stdin.read(1)
if os.environ.get('PI_MODEL') or os.environ.get('JUNO_MODEL'): raise SystemExit(91)
config=json.loads(pathlib.Path(sys.argv[3]).read_text())
assert config['defaultModel']==':configured' and config['defaultModels']['pi']==':configured'
assert pathlib.Path(config['envFilePath']).is_absolute() and pathlib.Path(config['envFilePath']).read_text().startswith('MANAGED_TEST_SECRET=')
macro=pathlib.Path(config['promptMacros']['global']['reflect']['path'])
assert macro.is_absolute() and macro.read_text()=='controller reflect\\n'
prompt=pathlib.Path(sys.argv[sys.argv.index('-f')+1]).read_text()
print('out-before', flush=True); print('err-before', file=sys.stderr, flush=True)
time.sleep(10 if 'signal-wait' in prompt else .35)
if 'transport-fail' in prompt: raise SystemExit(7)
payload={'session_id':'session-one','result':'answer'}
if 'semantic-fail' in prompt: payload['is_error']=True
if 'empty' in prompt: payload['result']=''
pathlib.Path(os.environ['JUNO_SUBAGENT_CAPTURE_PATH']).write_text(json.dumps(payload)+'\\n')
print('out-after', flush=True)
""")
        fake.chmod(0o755)
        self.prompt = self.tmp / "input.md"; self.prompt.write_text("ok\n")

    def tearDown(self): shutil.rmtree(self.tmp, ignore_errors=True)

    def command(self, out: Path, prompt: Path | None = None):
        return [sys.executable, str(RUNNER), "run", "--mode", "reviewer", "--controller-root", str(self.controller),
                "--controller-branch", "refs/heads/controller", "--agent-root", str(out / "agent-root"),
                "--prompt-file", str(prompt or self.prompt), "--out-dir", str(out), "--candidate-sha", git(self.candidate, "rev-parse", "HEAD"),
                "--candidate-root", str(self.candidate)]

    def env(self):
        return {**os.environ, "PATH": str(self.bin) + os.pathsep + os.environ["PATH"], "PI_MODEL": "forbidden", "JUNO_MODEL": "forbidden"}

    def test_live_separate_and_labelled_streams_before_exit(self):
        out = self.tmp / "stream"
        proc = subprocess.Popen(self.command(out), env=self.env(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline and not (out / "stdout.log").exists(): time.sleep(.01)
        while time.monotonic() < deadline and b"out-before" not in (out / "stdout.log").read_bytes(): time.sleep(.01)
        self.assertIsNone(proc.poll()); self.assertIn(b"err-before", (out / "stderr.log").read_bytes())
        self.assertEqual(proc.wait(timeout=3), 0)
        assert proc.stdout and proc.stderr; proc.stdout.close(); proc.stderr.close()
        self.assertEqual((out / "stdout.log").read_bytes(), b"out-before\nout-after\n")
        combined = (out / "combined.log").read_bytes(); self.assertIn(b"[stdout] out-before\n", combined); self.assertIn(b"[stderr] err-before\n", combined)
        receipt = json.loads((out / "receipt.json").read_text()); self.assertEqual(receipt["session_id"], "session-one")
        config_contract = receipt["compatible_config"]
        self.assertEqual({x["setting"] for x in config_contract["path_mappings"]},
                         {"envFilePath", "promptMacros.global.reflect.path"})
        derived = json.loads(Path(config_contract["derived"]["path"]).read_text())
        self.assertEqual(derived["defaultModel"], ":configured")
        self.assertEqual(derived["envFilePath"], str(self.controller.resolve() / ".env.juno"))
        self.assertEqual(derived["promptMacros"]["global"]["reflect"]["path"],
                         str(self.controller.resolve() / ".juno_task/prompts/reflect.md"))
        self.assertEqual(Path(derived["envFilePath"]).resolve(), self.env_target.resolve())
        self.assertNotIn("not-for-receipts", (out / "receipt.json").read_text())
        self.assertEqual(receipt["compatible_config_sha256"], json.loads((out / "terminal.json").read_text())["compatible_config_sha256"])
        self.assertFalse((out / "active.json").exists()); self.assertEqual((out / "response.txt").read_text(), "answer")

    def test_transport_and_semantic_fail_without_artificial_wait(self):
        for text in ("transport-fail", "semantic-fail", "empty"):
            prompt = self.tmp / f"{text}.md"; prompt.write_text(text)
            started = time.monotonic(); result = subprocess.run(self.command(self.tmp / ("out-" + text), prompt), env=self.env(), capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0); self.assertLess(time.monotonic() - started, 1.5)
            terminal = json.loads((self.tmp / ("out-" + text) / "terminal.json").read_text()); self.assertEqual(terminal["state"], "failed")

    def test_signal_is_forwarded_and_interruption_evidence_is_typed(self):
        prompt = self.tmp / "signal.md"; prompt.write_text("signal-wait")
        out = self.tmp / "signal-out"
        proc = subprocess.Popen(self.command(out, prompt), env=self.env(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            try:
                if json.loads((out / "active.json").read_text()).get("process_group_id"): break
            except (OSError, json.JSONDecodeError): pass
            time.sleep(.01)
        proc.terminate(); self.assertNotEqual(proc.wait(timeout=3), 0)
        assert proc.stdout and proc.stderr; proc.stdout.close(); proc.stderr.close()
        terminal = json.loads((out / "terminal.json").read_text())
        self.assertEqual(terminal["state"], "interrupted"); self.assertFalse((out / "active.json").exists())

    def test_worker_admission_and_changed_path_authority(self):
        common = str((self.candidate / git(self.candidate, "rev-parse", "--git-common-dir")).resolve())
        create = {"task_id":"T1", "worktree":str(self.candidate), "branch_ref":"refs/heads/task", "git_common_dir":common,
                  "expected_paths":["allowed.txt"], "workspace_manifest_identity":"m"}
        paths=[]
        for name, value in (("create", create), ("verify", {"passed":True,"task_id":"T1"}), ("edit", {"passed":True,"task_id":"T1"})):
            p=self.tmp/f"{name}.json"; p.write_text(json.dumps(value)); paths.append(p)
        out=self.tmp/"worker"; cmd=[sys.executable,str(RUNNER),"run","--mode","worker","--controller-root",str(self.controller),"--controller-branch","controller",
             "--agent-root",str(self.candidate),"--prompt-file",str(self.prompt),"--out-dir",str(out),"--task-id","T1",
             "--create-receipt",str(paths[0]),"--verify-receipt",str(paths[1]),"--edit-preflight-receipt",str(paths[2])]
        result=subprocess.run(cmd,env=self.env(),capture_output=True,text=True); self.assertEqual(result.returncode,0,result.stderr)
        receipt=json.loads((out/"receipt.json").read_text()); self.assertEqual(receipt["identity"]["unexpected_paths"],[])

    def test_missing_traversal_and_configured_file_drift_are_refused(self):
        config_path = self.controller / ".juno_task/config.json"
        original = json.loads(config_path.read_text())
        for bad_path in ("missing.env", "../controller.env"):
            config = dict(original); config["envFilePath"] = bad_path
            config_path.write_text(json.dumps(config) + "\n")
            subprocess.run(["git", "-C", str(self.controller), "add", str(config_path)], check=True)
            subprocess.run(["git", "-C", str(self.controller), "-c", "user.name=T", "-c", "user.email=t@t", "commit", "-m", "bad fixture"], check=True, stdout=subprocess.DEVNULL)
            result = subprocess.run(self.command(self.tmp / ("bad-" + bad_path.replace("/", "_"))), env=self.env(), capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0); self.assertIn("envFilePath", result.stderr)
            config_path.write_text(json.dumps(original) + "\n")
            subprocess.run(["git", "-C", str(self.controller), "add", str(config_path)], check=True)
            subprocess.run(["git", "-C", str(self.controller), "-c", "user.name=T", "-c", "user.email=t@t", "commit", "-m", "restore fixture"], check=True, stdout=subprocess.DEVNULL)
        out = self.tmp / "source-drift"
        proc = subprocess.Popen(self.command(out), env=self.env(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline and not (out / "stdout.log").exists(): time.sleep(.01)
        while time.monotonic() < deadline and b"out-before" not in (out / "stdout.log").read_bytes(): time.sleep(.01)
        self.env_target.write_text("MANAGED_TEST_SECRET=changed\n")
        self.assertNotEqual(proc.wait(timeout=3), 0)
        assert proc.stdout and proc.stderr; proc.stdout.close(); proc.stderr.close()
        terminal = json.loads((out / "terminal.json").read_text())
        self.assertIn("identity drifted", terminal["failure"])

    def test_real_config_loader_and_public_yy_help_accept_neutral_root(self):
        out = self.tmp / "real-config-smoke"
        result = subprocess.run(self.command(out), env=self.env(), capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        config_path = json.loads((out / "launch.json").read_text())["compatible_config"]["derived"]["path"]
        smoke_env = {k:v for k,v in os.environ.items() if not k.startswith(("PI_", "JUNO_")) and k != "TASK_ROOT"}
        smoke_env["JUNO_CODE_PROJECT_BOOTSTRAP_WRITES"] = "0"
        repository = RUNNER.parents[2]
        tsx = repository / "juno-code/node_modules/.bin/tsx"
        loader = repository / "juno-code/src/core/config.ts"
        if tsx.is_file() and loader.is_file():
            script = ("import {loadConfig} from " + json.dumps(str(loader)) + ";"
                      "void(async()=>{const c=await loadConfig({baseDir:process.argv[2],configFile:process.argv[1]});"
                      "if(c.defaultModel!==':configured'||c.promptMacros.global.reflect!=='controller reflect\\n'||!c.envFilePath.startsWith('/'))process.exit(81);})().catch(e=>{console.error(e);process.exit(82)});")
            loaded = subprocess.run([str(tsx), "--eval", script, config_path, str(out / "agent-root")],
                                    cwd=out / "launcher-root", env=smoke_env, stdin=subprocess.DEVNULL,
                                    capture_output=True, text=True, timeout=30)
            self.assertEqual(loaded.returncode, 0, loaded.stderr)
        real_path = os.pathsep.join(x for x in os.environ["PATH"].split(os.pathsep) if Path(x).resolve() != self.bin.resolve())
        real_yy = shutil.which("yy", path=real_path)
        if real_yy:
            smoke = subprocess.run([real_yy, "pi", "--config", config_path, "-w", str(out / "agent-root"), "--help"],
                                   cwd=out / "launcher-root", env=smoke_env, stdin=subprocess.DEVNULL,
                                   capture_output=True, text=True, timeout=30)
            self.assertEqual(smoke.returncode, 0, smoke.stderr)
            self.assertNotIn("failed to read path", smoke.stderr.lower())

    def test_prompt_and_candidate_drift_refused(self):
        out=self.tmp/"drift"; (self.candidate/"dirty").write_text("x")
        result=subprocess.run(self.command(out),env=self.env(),capture_output=True,text=True)
        self.assertNotEqual(result.returncode,0); self.assertFalse((out/"launch.json").exists())


if __name__ == "__main__": unittest.main()
