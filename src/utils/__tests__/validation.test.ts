/**
 * Tests for validation utilities module
 */

import { describe, it, expect, beforeEach, vi, beforeAll, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as tmp from 'tmp';
import {
  ValidationError,
  validateSubagent,
  validateModel,
  validateIterations,
  validateLogLevel,
  validatePaths,
  isValidSubagent,
  isValidSessionStatus,
  isValidLogLevel,
  isValidPath,
  sanitizePromptText,
  sanitizeFilePath,
  sanitizeGitUrl,
  sanitizeSessionId,
  formatValidationError,
  validateWithFallback,
  validateConfig,
  validateEnvironmentVars,
  validateCommandOptions,
  validateJson,
  validateUniqueArray,
  validateNumberRange,
  validateStringLength,
  SubagentSchema,
  LogLevelSchema,
  SessionStatusSchema,
  IterationsSchema
} from '../validation';

describe('ValidationError', () => {
  it('should create error with field and suggestions', () => {
    const error = new ValidationError(
      'Test error',
      'testField',
      'testValue',
      ['suggestion1', 'suggestion2']
    );

    expect(error.message).toBe('Test error');
    expect(error.field).toBe('testField');
    expect(error.value).toBe('testValue');
    expect(error.suggestions).toEqual(['suggestion1', 'suggestion2']);
    expect(error.name).toBe('ValidationError');
  });
});

describe('Core Validation Functions', () => {
  describe('validateSubagent', () => {
    it('should validate direct subagent names', () => {
      expect(validateSubagent('claude')).toBe('claude');
      expect(validateSubagent('cursor')).toBe('cursor');
      expect(validateSubagent('codex')).toBe('codex');
      expect(validateSubagent('gemini')).toBe('gemini');
    });

    it('should handle aliases', () => {
      expect(validateSubagent('claude-code')).toBe('claude');
      expect(validateSubagent('claude_code')).toBe('claude');
      expect(validateSubagent('gemini-cli')).toBe('gemini');
      expect(validateSubagent('cursor-agent')).toBe('cursor');
    });

    it('should throw ValidationError for invalid subagent', () => {
      expect(() => validateSubagent('invalid')).toThrow(ValidationError);
    });
  });

  describe('validateModel', () => {
    it('should validate model names', () => {
      expect(validateModel('gpt-4')).toBe('gpt-4');
      expect(validateModel('claude-3-sonnet')).toBe('claude-3-sonnet');
      expect(validateModel('model_name-v2')).toBe('model_name-v2');
    });

    it('should warn for potentially invalid Claude models', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      validateModel('gpt-4', 'claude');
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Warning: Model 'gpt-4' may not be valid for Claude subagent")
      );
      consoleSpy.mockRestore();
    });

    it('should throw ValidationError for invalid characters', () => {
      expect(() => validateModel('model<>')).toThrow(ValidationError);
    });
  });

  describe('validateIterations', () => {
    it('should validate positive integers', () => {
      expect(validateIterations(1)).toBe(1);
      expect(validateIterations(50)).toBe(50);
      expect(validateIterations(1000)).toBe(1000);
    });

    it('should convert -1 to Infinity', () => {
      expect(validateIterations(-1)).toBe(Infinity);
    });

    it('should throw ValidationError for invalid values', () => {
      expect(() => validateIterations(0)).toThrow(ValidationError);
      expect(() => validateIterations(-5)).toThrow(ValidationError);
      expect(() => validateIterations(1.5)).toThrow(ValidationError);
    });
  });

  describe('validateLogLevel', () => {
    it('should validate log levels', () => {
      expect(validateLogLevel('error')).toBe('error');
      expect(validateLogLevel('warn')).toBe('warn');
      expect(validateLogLevel('info')).toBe('info');
      expect(validateLogLevel('debug')).toBe('debug');
      expect(validateLogLevel('trace')).toBe('trace');
    });

    it('should throw ValidationError for invalid log level', () => {
      expect(() => validateLogLevel('invalid')).toThrow(ValidationError);
    });
  });

  describe('validatePaths', () => {
    let tmpDir: tmp.DirResult;
    let tmpFile: tmp.FileResult;

    beforeEach(() => {
      tmpDir = tmp.dirSync({ unsafeCleanup: true });
      tmpFile = tmp.fileSync({ dir: tmpDir.name });
    });

    afterEach(() => {
      tmpFile.removeCallback();
      tmpDir.removeCallback();
    });

    it('should validate existing file paths', async () => {
      const result = await validatePaths(tmpFile.name, 'file');
      expect(result).toBe(path.resolve(tmpFile.name));
    });

    it('should validate existing directory paths', async () => {
      const result = await validatePaths(tmpDir.name, 'directory');
      expect(result).toBe(path.resolve(tmpDir.name));
    });

    it('should reject non-existent paths', async () => {
      await expect(validatePaths('/non/existent/path', 'file'))
        .rejects.toThrow(ValidationError);
    });

    it('should reject wrong path type', async () => {
      await expect(validatePaths(tmpDir.name, 'file'))
        .rejects.toThrow(ValidationError);
    });
  });
});

describe('Type Guards', () => {
  describe('isValidSubagent', () => {
    it('should return true for valid subagents', () => {
      expect(isValidSubagent('claude')).toBe(true);
      expect(isValidSubagent('cursor')).toBe(true);
      expect(isValidSubagent('codex')).toBe(true);
      expect(isValidSubagent('gemini')).toBe(true);
    });

    it('should return false for invalid values', () => {
      expect(isValidSubagent('invalid')).toBe(false);
      expect(isValidSubagent(123)).toBe(false);
      expect(isValidSubagent(null)).toBe(false);
      expect(isValidSubagent(undefined)).toBe(false);
    });
  });

  describe('isValidSessionStatus', () => {
    it('should return true for valid session statuses', () => {
      expect(isValidSessionStatus('running')).toBe(true);
      expect(isValidSessionStatus('completed')).toBe(true);
      expect(isValidSessionStatus('failed')).toBe(true);
      expect(isValidSessionStatus('cancelled')).toBe(true);
    });

    it('should return false for invalid values', () => {
      expect(isValidSessionStatus('invalid')).toBe(false);
      expect(isValidSessionStatus(123)).toBe(false);
    });
  });

  describe('isValidLogLevel', () => {
    it('should return true for valid log levels', () => {
      expect(isValidLogLevel('error')).toBe(true);
      expect(isValidLogLevel('warn')).toBe(true);
      expect(isValidLogLevel('info')).toBe(true);
      expect(isValidLogLevel('debug')).toBe(true);
      expect(isValidLogLevel('trace')).toBe(true);
    });

    it('should return false for invalid values', () => {
      expect(isValidLogLevel('invalid')).toBe(false);
      expect(isValidLogLevel(123)).toBe(false);
    });
  });

  describe('isValidPath', () => {
    let tmpDir: tmp.DirResult;
    let tmpFile: tmp.FileResult;

    beforeEach(() => {
      tmpDir = tmp.dirSync({ unsafeCleanup: true });
      tmpFile = tmp.fileSync({ dir: tmpDir.name });
    });

    afterEach(() => {
      tmpFile.removeCallback();
      tmpDir.removeCallback();
    });

    it('should return true for existing file paths', async () => {
      expect(await isValidPath(tmpFile.name, 'file')).toBe(true);
    });

    it('should return true for existing directory paths', async () => {
      expect(await isValidPath(tmpDir.name, 'directory')).toBe(true);
    });

    it('should return false for non-existent paths', async () => {
      expect(await isValidPath('/non/existent/path', 'file')).toBe(false);
    });
  });
});

describe('Input Sanitization', () => {
  describe('sanitizePromptText', () => {
    it('should remove control characters', () => {
      const input = 'Hello\x00World\x1F!';
      const result = sanitizePromptText(input);
      expect(result).toBe('HelloWorld!');
    });

    it('should normalize line endings', () => {
      const input = 'Line 1\r\nLine 2\r\nLine 3';
      const result = sanitizePromptText(input);
      expect(result).toBe('Line 1\nLine 2\nLine 3');
    });

    it('should trim whitespace', () => {
      const input = '  Hello World  ';
      const result = sanitizePromptText(input);
      expect(result).toBe('Hello World');
    });

    it('should throw ValidationError for non-string input', () => {
      expect(() => sanitizePromptText(123 as any)).toThrow(ValidationError);
    });
  });

  describe('sanitizeFilePath', () => {
    it('should remove dangerous characters', () => {
      const input = 'file<>name:"|?*.txt';
      const result = sanitizeFilePath(input);
      expect(result).toBe(path.resolve('filename.txt'));
    });

    it('should throw ValidationError for non-string input', () => {
      expect(() => sanitizeFilePath(123 as any)).toThrow(ValidationError);
    });

    it('should throw ValidationError for empty path after cleaning', () => {
      expect(() => sanitizeFilePath('<>:"|?*')).toThrow(ValidationError);
    });
  });

  describe('sanitizeGitUrl', () => {
    it('should validate HTTPS URLs', () => {
      const url = 'https://github.com/user/repo.git';
      expect(sanitizeGitUrl(url)).toBe(url);
    });

    it('should validate SSH URLs', () => {
      const url = 'git@github.com:user/repo.git';
      expect(sanitizeGitUrl(url)).toBe(url);
    });

    it('should validate GitHub URLs without .git', () => {
      const url = 'https://github.com/user/repo';
      expect(sanitizeGitUrl(url)).toBe(url);
    });

    it('should throw ValidationError for invalid URLs', () => {
      expect(() => sanitizeGitUrl('not-a-git-url')).toThrow(ValidationError);
    });

    it('should throw ValidationError for non-string input', () => {
      expect(() => sanitizeGitUrl(123 as any)).toThrow(ValidationError);
    });
  });

  describe('sanitizeSessionId', () => {
    it('should validate valid session IDs', () => {
      const sessionId = 'session_12345-abc';
      expect(sanitizeSessionId(sessionId)).toBe(sessionId);
    });

    it('should throw ValidationError for short session IDs', () => {
      expect(() => sanitizeSessionId('short')).toThrow(ValidationError);
    });

    it('should throw ValidationError for invalid characters', () => {
      expect(() => sanitizeSessionId('session@#$%')).toThrow(ValidationError);
    });

    it('should throw ValidationError for non-string input', () => {
      expect(() => sanitizeSessionId(123 as any)).toThrow(ValidationError);
    });
  });
});

describe('Error Handling', () => {
  describe('formatValidationError', () => {
    it('should format error with field and suggestions', () => {
      const error = new ValidationError(
        'Test error',
        'testField',
        'testValue',
        ['suggestion1', 'suggestion2']
      );

      const formatted = formatValidationError(error);
      expect(formatted).toContain('Test error');
      expect(formatted).toContain('Field: testField');
      expect(formatted).toContain('Value: "testValue"');
      expect(formatted).toContain('Suggestions:');
      expect(formatted).toContain('1. suggestion1');
      expect(formatted).toContain('2. suggestion2');
    });

    it('should format error without optional fields', () => {
      const error = new ValidationError('Simple error');
      const formatted = formatValidationError(error);
      expect(formatted).toBe('Simple error');
    });
  });

  describe('validateWithFallback', () => {
    it('should return validated value on success', () => {
      const validator = (value: unknown) => {
        if (typeof value === 'string') return value.toUpperCase();
        throw new ValidationError('Must be string');
      };

      const result = validateWithFallback(validator, 'hello', 'DEFAULT');
      expect(result).toBe('HELLO');
    });

    it('should return default value on validation failure', () => {
      const validator = (value: unknown) => {
        if (typeof value === 'string') return value;
        throw new ValidationError('Must be string');
      };

      const result = validateWithFallback(validator, 123, 'DEFAULT');
      expect(result).toBe('DEFAULT');
    });

    it('should log warning when not silent', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const validator = () => { throw new ValidationError('Test error'); };

      validateWithFallback(validator, 'test', 'DEFAULT', false);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Validation warning: Test error')
      );
      consoleSpy.mockRestore();
    });

    it('should not log warning when silent', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const validator = () => { throw new ValidationError('Test error'); };

      validateWithFallback(validator, 'test', 'DEFAULT', true);
      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });
});

describe('Configuration Validation', () => {
  describe('validateConfig', () => {
    it('should validate complete configuration', () => {
      const config = {
        defaultSubagent: 'claude',
        defaultBackend: 'mcp',
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
        onHourlyLimit: 'raise'
      };

      expect(() => validateConfig(config)).not.toThrow();
    });

    it('should throw ValidationError for invalid config', () => {
      const config = {
        defaultSubagent: 'invalid',
        defaultMaxIterations: -1,
        logLevel: 'invalid'
      };

      expect(() => validateConfig(config)).toThrow(ValidationError);
    });
  });

  describe('validateEnvironmentVars', () => {
    it('should validate environment variables', () => {
      const envVars = {
        JUNO_TASK_DEFAULT_SUBAGENT: 'claude',
        JUNO_TASK_LOG_LEVEL: 'info',
        JUNO_TASK_VERBOSE: 'true',
        OTHER_VAR: 'ignored'
      };

      const result = validateEnvironmentVars(envVars);
      expect(result.defaultSubagent).toBe('claude');
      expect(result.logLevel).toBe('info');
      expect(result.verbose).toBe(true);
    });

    it('should throw ValidationError for invalid environment variables', () => {
      const envVars = {
        JUNO_TASK_DEFAULT_SUBAGENT: 'invalid'
      };

      expect(() => validateEnvironmentVars(envVars)).toThrow(ValidationError);
    });
  });

  describe('validateCommandOptions', () => {
    it('should validate CLI options', () => {
      const options = {
        subagent: 'claude',
        verbose: true,
        maxIterations: 50
      };

      expect(() => validateCommandOptions(options)).not.toThrow();
    });

    it('should throw ValidationError for invalid options', () => {
      const options = {
        subagent: 'invalid',
        verbose: 'not-boolean'
      };

      expect(() => validateCommandOptions(options)).toThrow(ValidationError);
    });
  });
});

describe('Utility Functions', () => {
  describe('validateJson', () => {
    it('should parse valid JSON', () => {
      const json = '{"key": "value", "number": 42}';
      const result = validateJson(json);
      expect(result).toEqual({ key: 'value', number: 42 });
    });

    it('should throw ValidationError for invalid JSON', () => {
      expect(() => validateJson('invalid json')).toThrow(ValidationError);
    });
  });

  describe('validateUniqueArray', () => {
    it('should validate unique arrays', () => {
      const array = [1, 2, 3, 4];
      expect(validateUniqueArray(array)).toEqual(array);
    });

    it('should throw ValidationError for duplicate values', () => {
      const array = [1, 2, 2, 3];
      expect(() => validateUniqueArray(array)).toThrow(ValidationError);
    });
  });

  describe('validateNumberRange', () => {
    it('should validate numbers within range', () => {
      expect(validateNumberRange(5, 1, 10)).toBe(5);
      expect(validateNumberRange(1, 1, 10)).toBe(1);
      expect(validateNumberRange(10, 1, 10)).toBe(10);
    });

    it('should throw ValidationError for numbers outside range', () => {
      expect(() => validateNumberRange(0, 1, 10)).toThrow(ValidationError);
      expect(() => validateNumberRange(11, 1, 10)).toThrow(ValidationError);
    });
  });

  describe('validateStringLength', () => {
    it('should validate strings within length range', () => {
      expect(validateStringLength('hello', 1, 10)).toBe('hello');
      expect(validateStringLength('a', 1, 10)).toBe('a');
      expect(validateStringLength('1234567890', 1, 10)).toBe('1234567890');
    });

    it('should throw ValidationError for strings outside length range', () => {
      expect(() => validateStringLength('', 1, 10)).toThrow(ValidationError);
      expect(() => validateStringLength('12345678901', 1, 10)).toThrow(ValidationError);
    });
  });
});

describe('Zod Schemas', () => {
  describe('SubagentSchema', () => {
    it('should transform aliases to canonical names', () => {
      expect(SubagentSchema.parse('claude-code')).toBe('claude');
      expect(SubagentSchema.parse('claude')).toBe('claude');
    });

    it('should throw for invalid subagents', () => {
      expect(() => SubagentSchema.parse('invalid')).toThrow();
    });
  });

  describe('LogLevelSchema', () => {
    it('should validate log levels', () => {
      expect(LogLevelSchema.parse('info')).toBe('info');
      expect(LogLevelSchema.parse('debug')).toBe('debug');
    });

    it('should throw for invalid log levels', () => {
      expect(() => LogLevelSchema.parse('invalid')).toThrow();
    });
  });

  describe('IterationsSchema', () => {
    it('should transform -1 to Infinity', () => {
      expect(IterationsSchema.parse(-1)).toBe(Infinity);
      expect(IterationsSchema.parse(50)).toBe(50);
    });

    it('should throw for invalid iterations', () => {
      expect(() => IterationsSchema.parse(0)).toThrow();
      expect(() => IterationsSchema.parse(-2)).toThrow();
    });
  });
});