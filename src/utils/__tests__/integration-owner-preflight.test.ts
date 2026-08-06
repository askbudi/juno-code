import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

const root = path.resolve(process.cwd(), '..');
const helper = path.resolve(process.cwd(), 'src/templates/scripts/integration_owner_preflight.py');
const candidate = path.resolve(process.cwd(), 'src/templates/scripts/integration_candidate.py');

describe('target-ref integration channel', () => {
  it('is compilable and exposes only receipt-gated CAS integration controls', async () => {
    execFileSync('python3', ['-m', 'py_compile', helper]);
    const source = await fs.readFile(helper, 'utf8');
    expect(source).toContain('git_common_dir');
    expect(source).toContain('update-ref');
    expect(source).toContain('partial_local_integration');
    expect(source).toContain('--resume-receipt');
    expect(source).toContain('resume_stage');
    expect(source).toContain('juno-feature/');
    expect(source).toContain('--actual-review-command');
    expect(source).toContain('--controller-checkout');
    expect(source).toContain('--restore-controller-checkout');
    expect(source).toContain('exact_integrated');
    expect(source).toContain('controller_restoration');
    expect(source).toContain('unsafe_active_runtime_ownership');
    expect(source).toContain('--checked-out-target');
    expect(source).toContain('detach_same_sha');
    expect(source).toContain('allow_post_detach_ambiguity=True');
    expect(source).toContain('and not allow_post_detach_ambiguity:raise IntegrationError("ambiguous detached runtime identity for target retry")');
    expect(source).toContain('--risk-tier');
    expect(source).toContain('not_required_by_effective_tier');
    expect(source).toContain('stale_behind_target');
    expect(source).toContain('skipped_by_policy');
    expect(source).not.toContain('--nested-owner-receipt');
    expect(source).not.toContain('controller_nested_integration_owner_receipt_required');
    expect(source).not.toContain('--checkpoint-controller');
    expect(source).not.toContain('other_write_capable_processes');
    expect(source).toContain('git_flow.auto_after_integration');
    expect(source).toContain('"controller_sync":controller_sync');
    const flowSource = await fs.readFile(path.resolve(process.cwd(), 'src/templates/scripts/git_flow.py'), 'utf8');
    expect(flowSource).toContain('os.environ.pop("JUNO_WORKSPACE_ROLE", None)');
    expect(flowSource).toContain('os.environ["JUNO_WORKSPACE_ROLE"] = asserted_role');
    expect(source.indexOf('write(a.output,{k:v for k,v in receipt.items() if k!="_output_path"},replace=True)')).toBeLessThan(
      source.indexOf('git_flow.auto_after_integration'),
    );
    const candidateSource = await fs.readFile(candidate, 'utf8');
    expect(candidateSource).toContain('--target-channel-owner');
    expect(candidateSource).toContain('protected_role_override="integration-owner"');
    expect(candidateSource).toContain('role_persisted_by_planning":False');
  });

  it.skipIf(process.env.JUNO_CODE_REAL_GIT_INTEGRATION !== '1')(
    'passes the opt-in real Git candidate/CAS/tag/stale-ref suite',
    () => {
      // The suite sentinel protects external checkouts; this explicit opt-in
      // retains unmocked lifecycle coverage for a dedicated isolated run.
      execFileSync('python3', [
        path.join(root, '.juno_task/scripts/tests/test_integration_concurrency.py'),
      ], { stdio: 'pipe' });
    },
  );
});
