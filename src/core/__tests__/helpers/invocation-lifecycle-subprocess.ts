import * as childProcess from 'node:child_process';
import * as path from 'node:path';
import fs from 'fs-extra';

import { writeInvocationTelemetryEvent } from '../../invocation-telemetry.js';
import {
  InvocationLifecycle,
  runWithInvocationLifecycle,
  startActiveInvocation,
} from '../../invocation-lifecycle.js';

const mode = process.argv[2] ?? 'success';

if (mode === 'observation-env') {
  const child = childProcess.spawnSync(process.execPath, ['-e', 'process.stdout.write(process.env.JUNO_CODE_WRAPPER_OBSERVATION || "")'], {
    encoding: 'utf8',
    env: process.env,
  });
  fs.writeJsonSync(path.join(process.cwd(), 'observation-env.json'), {
    current: process.env.JUNO_CODE_WRAPPER_OBSERVATION ?? null,
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
  if (mode === 'failure') process.exit(7);
  if (mode === 'timeout') process.exit(124);
  if (mode === 'wait') {
    await startActiveInvocation({ service: 'pi', requestedModel: 'test-model' });
    await new Promise<void>(() => setInterval(() => undefined, 1_000));
  }
});
