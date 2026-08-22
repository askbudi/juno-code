import * as childProcess from 'node:child_process';
import * as path from 'node:path';
import fs from 'fs-extra';
import { fileURLToPath } from 'node:url';

import { writeInvocationTelemetryEvent } from '../../invocation-telemetry.js';
import {
  InvocationLifecycle,
  runWithInvocationLifecycle,
  startActiveInvocation,
} from '../../invocation-lifecycle.js';

const mode = process.argv[2] ?? 'success';
const helper = fileURLToPath(import.meta.url);
const tsxLoader = path.resolve(path.dirname(helper), '../../../../node_modules/tsx/dist/loader.mjs');

function launchCanonicalChild(childMode: string, surface: string, metadata: Record<string, string> = {}): void {
  const moduleDirectory = path.resolve(path.dirname(helper), '../../../templates/scripts');
  const script = [
    'import os, sys',
    'from invocation_correlation import child_invocation_environment',
    `env = child_invocation_environment(os.environ, launch_surface=${JSON.stringify(surface)}, ` +
      `task_id=${metadata.taskId ? JSON.stringify(metadata.taskId) : 'None'}, ` +
      `workflow_run_id=${metadata.workflowRunId ? JSON.stringify(metadata.workflowRunId) : 'None'}, ` +
      `workflow_step_id=${metadata.workflowStepId ? JSON.stringify(metadata.workflowStepId) : 'None'})`,
    `os.execvpe(${JSON.stringify(process.execPath)}, ${JSON.stringify([
      process.execPath, '--import', tsxLoader, helper, childMode,
    ])}, env)`,
  ].join('; ');
  const result = childProcess.spawnSync('python3', ['-c', script], {
    cwd: process.cwd(),
    env: { ...process.env, PYTHONPATH: moduleDirectory },
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`canonical child failed: ${result.stderr}`);
}

if (mode === 'observation-env') {
  const child = childProcess.spawnSync(process.execPath, ['-e', 'process.stdout.write(process.env.YYLO_WRAPPER_OBSERVATION || "")'], {
    encoding: 'utf8',
    env: process.env,
  });
  fs.writeJsonSync(path.join(process.cwd(), 'observation-env.json'), {
    current: process.env.YYLO_WRAPPER_OBSERVATION ?? null,
    child: child.stdout,
  });
  process.exit(0);
}

const lifecycle = new InvocationLifecycle({
  workingDirectory: process.cwd(),
  junoCodeVersion: '9.8.7-test',
  launchSurface: 'yy',
  ...(mode === 'slow-start' ? {
    writeEvent: async (cwd, event, env) => {
      if (event.event_type === 'invocation_started') {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      return writeInvocationTelemetryEvent(cwd, event, env);
    },
  } : {}),
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

void runWithInvocationLifecycle(lifecycle, async () => {
  if (mode === 'slow-start') {
    await fs.writeFile(path.join(process.cwd(), 'ready'), '1');
    if (await startActiveInvocation({ service: 'pi', requestedModel: 'test-model' })) {
      await fs.writeFile(path.join(process.cwd(), 'dispatched'), '1');
    }
    return;
  }
  if (mode === 'tree-parent') {
    launchCanonicalChild('tree-child', 'workflow_runner', {
      taskId: 'TASK-42', workflowRunId: 'run-7', workflowStepId: 'step-a',
    });
    launchCanonicalChild('tree-parallel', 'parallel_runner', { taskId: 'BATCH-1' });
    const unrelated = childProcess.spawnSync(process.execPath, ['--import', tsxLoader, helper, 'tree-unrelated'], {
      cwd: process.cwd(), env: process.env, encoding: 'utf8',
    });
    if (unrelated.status !== 0) throw new Error(`unrelated root failed: ${unrelated.stderr}`);
    return;
  }
  if (mode === 'tree-child') {
    launchCanonicalChild('tree-grandchild', 'managed_agent_runner', { taskId: 'TASK-43' });
    return;
  }
  if (mode === 'failure') process.exit(7);
  if (mode === 'timeout') process.exit(124);
  if (mode === 'wait') {
    await startActiveInvocation({ service: 'pi', requestedModel: 'test-model' });
    await new Promise<void>(() => setInterval(() => undefined, 1_000));
  }
});
