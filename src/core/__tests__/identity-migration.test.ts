import { describe, expect, it } from 'vitest';
import { migrateLegacyEnvironment } from '../identity-migration.js';

describe('YYLO identity migration', () => {
  it('maps legacy environment input without overriding canonical values', () => {
    const environment: NodeJS.ProcessEnv = {
      JUNO_CODE_MODEL: 'legacy-model',
      JUNO_CODE_VERBOSE: '1',
      YYLO_VERBOSE: '2',
    };

    migrateLegacyEnvironment(environment);

    expect(environment.YYLO_MODEL).toBe('legacy-model');
    expect(environment.YYLO_VERBOSE).toBe('2');
  });
});
