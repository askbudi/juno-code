import { Command } from 'commander';
import { invokeTaskWorkspace, type TaskWorkspaceInvoker } from './task.js';

export function configureEvidenceCommand(
  program: Command,
  invoke: TaskWorkspaceInvoker = invokeTaskWorkspace,
): void {
  const evidence = program.command('evidence')
    .description('Run and inspect local content-addressed task validation evidence');
  evidence.command('run')
    .argument('<task-id>')
    .option('--lease-token <token>', 'Current fencing lease token for this gated run')
    .action((taskId: string, options: { leaseToken?: string }) => invoke(
      'evidence-run', taskId, [], options.leaseToken ? ['--lease-token', options.leaseToken] : [],
    ));
  evidence.command('status').argument('<task-id>').action((taskId: string) => invoke('evidence-status', taskId, []));
  evidence.command('await')
    .argument('<task-id>')
    .option('--lease-token <token>', 'Current fencing lease token when missing commands must run')
    .action((taskId: string, options: { leaseToken?: string }) => invoke(
      'evidence-await', taskId, [], options.leaseToken ? ['--lease-token', options.leaseToken] : [],
    ));
}
