import fs from 'fs-extra';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import { promisify } from 'node:util';

export interface ControllerCheckpointResult {
  attempted: boolean;
  ok: boolean;
  warning?: string;
}

/** Best-effort outer finalizer. It never changes the owning run's exit status. */
export async function checkpointControllerAfterFinalization(
  workingDirectory: string,
  runExitCode: number,
): Promise<ControllerCheckpointResult> {
  if (process.env.JUNO_CONTROLLER_CHECKPOINT_ACTIVE === '1') {
    return { attempted: false, ok: true };
  }
  const configured = process.env.JUNO_TASK_ROOT?.trim();
  let root = path.resolve(configured || workingDirectory);
  if (path.basename(root) === '.juno_task') root = path.dirname(root);
  const script = path.join(root, '.juno_task', 'scripts', 'controller_checkpoint.py');
  if (!(await fs.pathExists(script))) return { attempted: false, ok: true };
  const message = runExitCode === 0
    ? 'chore(controller): checkpoint finalized run state'
    : `chore(controller): checkpoint failed run state (exit ${runExitCode})`;
  try {
    const execFile = promisify(childProcess.execFile);
    await execFile('python3', [script, '--root', root, 'commit', '--message', message], {
      cwd: root,
      env: { ...process.env, JUNO_CONTROLLER_CHECKPOINT_ACTIVE: '1' },
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return { attempted: true, ok: true };
  } catch (error) {
    const warning = `Controller checkpoint failed after finalization; run ${script} --root ${root} commit manually: ${String(error)}`;
    console.error(`WARNING: ${warning}`);
    return { attempted: true, ok: false, warning };
  }
}
