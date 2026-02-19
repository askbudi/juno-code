/**
 * Tests for validation utilities module (simplified)
 *
 * Tests only the exported functions and schemas from the simplified validation.ts module.
 * All removed functions (ValidationError, sanitize*, isValid*, validatePaths, etc.) are not tested.
 */

import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import {
  SubagentSchema,
  LogLevelSchema,
  SessionStatusSchema,
  IterationsSchema,
  ModelSchema,
  ConfigValidationSchema,
  validateSubagent,
  validateModel,
  validateIterations,
  validateLogLevel,
  validateConfig,
  validateEnvironmentVars,
} from '../validation';

// ============================================================================
// Zod Schemas
// ============================================================================

describe('Zod Schemas', () => {
  describe('SubagentSchema', () => {
    it('should accept canonical subagent names', () => {
      expect(SubagentSchema.parse('claude')).toBe('claude');
      expect(SubagentSchema.parse('cursor')).toBe('cursor');
      expect(SubagentSchema.parse('codex')).toBe('codex');
      expect(SubagentSchema.parse('gemini')).toBe('gemini');
      expect(SubagentSchema.parse('pi')).toBe('pi');
    });

    it('should transform aliases to canonical names', () => {
      expect(SubagentSchema.parse('claude-code')).toBe('claude');
      expect(SubagentSchema.parse('claude_code')).toBe('claude');
      expect(SubagentSchema.parse('gemini-cli')).toBe('gemini');
      expect(SubagentSchema.parse('cursor-agent')).toBe('cursor');
      expect(SubagentSchema.parse('pi-agent')).toBe('pi');
    });

    it('should throw ZodError for invalid subagent', () => {
      expect(() => SubagentSchema.parse('invalid')).toThrow(ZodError);
      expect(() => SubagentSchema.parse('')).toThrow(ZodError);
    });
  });

  describe('LogLevelSchema', () => {
    it('should accept valid log levels', () => {
      expect(LogLevelSchema.parse('error')).toBe('error');
      expect(LogLevelSchema.parse('warn')).toBe('warn');
      expect(LogLevelSchema.parse('info')).toBe('info');
      expect(LogLevelSchema.parse('debug')).toBe('debug');
      expect(LogLevelSchema.parse('trace')).toBe('trace');
    });

    it('should throw ZodError for invalid log levels', () => {
      expect(() => LogLevelSchema.parse('invalid')).toThrow(ZodError);
      expect(() => LogLevelSchema.parse('INFO')).toThrow(ZodError);
    });
  });

  describe('SessionStatusSchema', () => {
    it('should accept valid session statuses', () => {
      expect(SessionStatusSchema.parse('running')).toBe('running');
      expect(SessionStatusSchema.parse('completed')).toBe('completed');
      expect(SessionStatusSchema.parse('failed')).toBe('failed');
      expect(SessionStatusSchema.parse('cancelled')).toBe('cancelled');
    });

    it('should throw ZodError for invalid session statuses', () => {
      expect(() => SessionStatusSchema.parse('invalid')).toThrow(ZodError);
      expect(() => SessionStatusSchema.parse('pending')).toThrow(ZodError);
    });
  });

  describe('IterationsSchema', () => {
    it('should accept positive integers', () => {
      expect(IterationsSchema.parse(1)).toBe(1);
      expect(IterationsSchema.parse(50)).toBe(50);
      expect(IterationsSchema.parse(1000)).toBe(1000);
    });

    it('should transform -1 to Infinity', () => {
      expect(IterationsSchema.parse(-1)).toBe(Infinity);
    });

    it('should throw ZodError for invalid values', () => {
      expect(() => IterationsSchema.parse(0)).toThrow(ZodError);
      expect(() => IterationsSchema.parse(-2)).toThrow(ZodError);
      expect(() => IterationsSchema.parse(1.5)).toThrow(ZodError);
    });
  });

  describe('ModelSchema', () => {
    it('should accept valid model names', () => {
      expect(ModelSchema.parse('gpt-4')).toBe('gpt-4');
      expect(ModelSchema.parse('claude-3-sonnet')).toBe('claude-3-sonnet');
      expect(ModelSchema.parse('model_name-v2')).toBe('model_name-v2');
      expect(ModelSchema.parse('claude-opus-4-5-20251101')).toBe('claude-opus-4-5-20251101');
    });

    it('should throw ZodError for empty model name', () => {
      expect(() => ModelSchema.parse('')).toThrow(ZodError);
    });

    it('should throw ZodError for model names with invalid characters', () => {
      expect(() => ModelSchema.parse('model<>')).toThrow(ZodError);
      expect(() => ModelSchema.parse('model name')).toThrow(ZodError);
      expect(() => ModelSchema.parse('model@version')).toThrow(ZodError);
    });
  });

  describe('ConfigValidationSchema', () => {
    it('should be defined and be a Zod schema', () => {
      expect(ConfigValidationSchema).toBeDefined();
      expect(typeof ConfigValidationSchema.parse).toBe('function');
    });
  });
});

// ============================================================================
// Core Validation Functions
// ============================================================================

describe('Core Validation Functions', () => {
  describe('validateSubagent', () => {
    it('should return canonical names for direct subagent names', () => {
      expect(validateSubagent('claude')).toBe('claude');
      expect(validateSubagent('cursor')).toBe('cursor');
      expect(validateSubagent('codex')).toBe('codex');
      expect(validateSubagent('gemini')).toBe('gemini');
      expect(validateSubagent('pi')).toBe('pi');
    });

    it('should resolve aliases to canonical names', () => {
      expect(validateSubagent('claude-code')).toBe('claude');
      expect(validateSubagent('claude_code')).toBe('claude');
      expect(validateSubagent('gemini-cli')).toBe('gemini');
      expect(validateSubagent('cursor-agent')).toBe('cursor');
    });

    it('should throw ZodError for invalid subagent', () => {
      expect(() => validateSubagent('invalid')).toThrow(ZodError);
      expect(() => validateSubagent('')).toThrow(ZodError);
    });
  });

  describe('validateModel', () => {
    it('should return valid model names unchanged', () => {
      expect(validateModel('gpt-4')).toBe('gpt-4');
      expect(validateModel('claude-3-sonnet')).toBe('claude-3-sonnet');
      expect(validateModel('model_name-v2')).toBe('model_name-v2');
    });

    it('should accept model with optional subagent parameter', () => {
      expect(validateModel('gpt-4', 'claude')).toBe('gpt-4');
      expect(validateModel('claude-3-sonnet', 'codex')).toBe('claude-3-sonnet');
    });

    it('should throw ZodError for model names with invalid characters', () => {
      expect(() => validateModel('model<>')).toThrow(ZodError);
      expect(() => validateModel('model name')).toThrow(ZodError);
    });

    it('should throw ZodError for empty model name', () => {
      expect(() => validateModel('')).toThrow(ZodError);
    });
  });

  describe('validateIterations', () => {
    it('should return positive integers unchanged', () => {
      expect(validateIterations(1)).toBe(1);
      expect(validateIterations(50)).toBe(50);
      expect(validateIterations(1000)).toBe(1000);
    });

    it('should convert -1 to Infinity', () => {
      expect(validateIterations(-1)).toBe(Infinity);
    });

    it('should throw ZodError for zero', () => {
      expect(() => validateIterations(0)).toThrow(ZodError);
    });

    it('should throw ZodError for negative values other than -1', () => {
      expect(() => validateIterations(-5)).toThrow(ZodError);
      expect(() => validateIterations(-2)).toThrow(ZodError);
    });

    it('should throw ZodError for non-integer values', () => {
      expect(() => validateIterations(1.5)).toThrow(ZodError);
      expect(() => validateIterations(0.5)).toThrow(ZodError);
    });
  });

  describe('validateLogLevel', () => {
    it('should return valid log levels unchanged', () => {
      expect(validateLogLevel('error')).toBe('error');
      expect(validateLogLevel('warn')).toBe('warn');
      expect(validateLogLevel('info')).toBe('info');
      expect(validateLogLevel('debug')).toBe('debug');
      expect(validateLogLevel('trace')).toBe('trace');
    });

    it('should throw ZodError for invalid log level', () => {
      expect(() => validateLogLevel('invalid')).toThrow(ZodError);
      expect(() => validateLogLevel('INFO')).toThrow(ZodError);
      expect(() => validateLogLevel('')).toThrow(ZodError);
    });
  });
});

// ============================================================================
// Configuration Validation
// ============================================================================

describe('Configuration Validation', () => {
  describe('validateConfig', () => {
    it('should validate a complete valid configuration', () => {
      const config = {
        defaultSubagent: 'claude',
        defaultBackend: 'shell',
        defaultMaxIterations: 50,
        logLevel: 'info',
        verbose: false,
        quiet: false,
        mcpTimeout: 30000,
        mcpRetries: 3,
        interactive: true,
        headlessMode: false,
        workingDirectory: process.cwd(),
        sessionDirectory: '/tmp/sessions',
        onHourlyLimit: 'raise',
      };

      const result = validateConfig(config);
      expect(result).toBeDefined();
      expect(result.defaultSubagent).toBe('claude');
      expect(result.defaultMaxIterations).toBe(50);
      expect(result.logLevel).toBe('info');
    });

    it('should throw for invalid config (bad subagent)', () => {
      const config = {
        defaultSubagent: 'invalid',
        defaultBackend: 'shell',
        defaultMaxIterations: 50,
        logLevel: 'info',
        verbose: false,
        quiet: false,
        mcpTimeout: 30000,
        mcpRetries: 3,
        interactive: true,
        headlessMode: false,
        workingDirectory: process.cwd(),
        sessionDirectory: '/tmp/sessions',
        onHourlyLimit: 'raise',
      };

      expect(() => validateConfig(config)).toThrow();
    });

    it('should throw for invalid config (bad log level)', () => {
      const config = {
        defaultSubagent: 'claude',
        defaultBackend: 'shell',
        defaultMaxIterations: 50,
        logLevel: 'invalid',
        verbose: false,
        quiet: false,
        mcpTimeout: 30000,
        mcpRetries: 3,
        interactive: true,
        headlessMode: false,
        workingDirectory: process.cwd(),
        sessionDirectory: '/tmp/sessions',
        onHourlyLimit: 'raise',
      };

      expect(() => validateConfig(config)).toThrow();
    });

    it('should throw for missing required fields', () => {
      expect(() => validateConfig({})).toThrow();
      expect(() => validateConfig({ defaultSubagent: 'claude' })).toThrow();
    });
  });

  describe('validateEnvironmentVars', () => {
    it('should parse valid JUNO_TASK_ environment variables', () => {
      const envVars = {
        JUNO_TASK_DEFAULT_SUBAGENT: 'claude',
        JUNO_TASK_LOG_LEVEL: 'info',
        JUNO_TASK_VERBOSE: 'true',
        OTHER_VAR: 'ignored',
      };

      const result = validateEnvironmentVars(envVars);
      expect(result.defaultSubagent).toBe('claude');
      expect(result.logLevel).toBe('info');
      expect(result.verbose).toBe(true);
    });

    it('should handle boolean environment variables', () => {
      const envVars = {
        JUNO_TASK_VERBOSE: 'true',
        JUNO_TASK_QUIET: 'false',
        JUNO_TASK_INTERACTIVE: 'true',
        JUNO_TASK_HEADLESS_MODE: 'false',
      };

      const result = validateEnvironmentVars(envVars);
      expect(result.verbose).toBe(true);
      expect(result.quiet).toBe(false);
      expect(result.interactive).toBe(true);
      expect(result.headlessMode).toBe(false);
    });

    it('should handle iteration count from environment', () => {
      const envVars = {
        JUNO_TASK_DEFAULT_MAX_ITERATIONS: '100',
      };

      const result = validateEnvironmentVars(envVars);
      expect(result.defaultMaxIterations).toBe(100);
    });

    it('should ignore non-JUNO_TASK_ variables', () => {
      const envVars = {
        HOME: '/home/user',
        PATH: '/usr/bin',
        NODE_ENV: 'test',
      };

      const result = validateEnvironmentVars(envVars);
      expect(Object.keys(result)).toHaveLength(0);
    });

    it('should ignore undefined values', () => {
      const envVars: Record<string, string | undefined> = {
        JUNO_TASK_DEFAULT_SUBAGENT: undefined,
      };

      const result = validateEnvironmentVars(envVars);
      expect(result.defaultSubagent).toBeUndefined();
    });

    it('should throw Error for invalid environment variable values', () => {
      const envVars = {
        JUNO_TASK_DEFAULT_SUBAGENT: 'invalid-agent',
      };

      expect(() => validateEnvironmentVars(envVars)).toThrow(Error);
    });

    it('should include variable name in error message', () => {
      const envVars = {
        JUNO_TASK_DEFAULT_SUBAGENT: 'invalid-agent',
      };

      expect(() => validateEnvironmentVars(envVars)).toThrow(
        /JUNO_TASK_DEFAULT_SUBAGENT/
      );
    });

    it('should return empty config for empty input', () => {
      const result = validateEnvironmentVars({});
      expect(Object.keys(result)).toHaveLength(0);
    });
  });
});
