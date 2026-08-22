import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ execFileSync: vi.fn(), existsSync: vi.fn(() => true) }));
vi.mock('node:child_process', () => ({
  default: { execFileSync: mocks.execFileSync },
  execFileSync: mocks.execFileSync,
}));
vi.mock('node:fs', () => ({
  default: { existsSync: mocks.existsSync },
  existsSync: mocks.existsSync,
}));

import { resolveController } from '../controller-resolver.js';

afterEach(() => {
  delete process.env.YYLO_LAST_SESSION_ID_SCOPE_0123456789ABCDEF;
  delete process.env.YYLO_LAST_EXECUTION_SETTINGS;
  delete process.env.CONTROLLER_BOUNDARY_CONFIG;
  mocks.execFileSync.mockReset();
});

describe('controller resolver child environment', () => {
  it('preserves routing/config and removes continuity before resolver dispatch', () => {
    process.env.YYLO_LAST_SESSION_ID_SCOPE_0123456789ABCDEF = 'historical';
    process.env.YYLO_LAST_EXECUTION_SETTINGS = 'legacy';
    process.env.CONTROLLER_BOUNDARY_CONFIG = 'preserved';
    mocks.execFileSync.mockReturnValue(JSON.stringify({
      path: '/controller', source: 'environment', expected_branch: 'main', actual_branch: 'main',
      role: 'task', enforcement: 'strict', operation: 'kanban', valid: true, diagnostics: [],
    }));

    expect(resolveController('/workspace', 'kanban').path).toBe('/controller');

    const environment = mocks.execFileSync.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv;
    expect(environment.CONTROLLER_BOUNDARY_CONFIG).toBe('preserved');
    expect(environment.YYLO_LAST_SESSION_ID_SCOPE_0123456789ABCDEF).toBeUndefined();
    expect(environment.YYLO_LAST_EXECUTION_SETTINGS).toBeUndefined();
  });
});
