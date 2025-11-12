/**
 * Tests for startup JSON configuration validation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs-extra';
import path from 'node:path';
import {
  validateJSONConfigs,
  validateStartupConfigs,
  displayValidationResults,
  logValidationResults,
  type ValidationResult
} from '../startup-validation.js';

// Mock fs-extra with proper mocking pattern
vi.mock('fs-extra', () => {
  const readFile = vi.fn();
  const writeFile = vi.fn();
  const pathExists = vi.fn();
  const access = vi.fn();
  const ensureDir = vi.fn();
  const appendFile = vi.fn();
  const constants = { R_OK: 4 };

  return {
    default: {
      readFile,
      writeFile,
      pathExists,
      access,
      ensureDir,
      appendFile,
      constants
    },
    readFile,
    writeFile,
    pathExists,
    access,
    ensureDir,
    appendFile,
    constants
  };
});

// Mock chalk to avoid colors in test output
vi.mock('chalk', () => ({
  default: {
    green: vi.fn((text) => text),
    red: Object.assign(vi.fn((text) => text), { bold: vi.fn((text) => text) }),
    yellow: Object.assign(vi.fn((text) => text), { bold: vi.fn((text) => text) }),
    blue: vi.fn((text) => text),
    gray: vi.fn((text) => text),
  },
}));

// Mock logger
vi.mock('../logger.js', () => ({
  getMCPLogger: vi.fn(() => ({
    error: vi.fn(),
  })),
}));

describe('startup-validation', () => {
  const testBaseDir = '/test/project';
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Setup default mocks
    vi.mocked(fs.ensureDir).mockResolvedValue(undefined);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    vi.mocked(fs.appendFile).mockResolvedValue(undefined);
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  describe('validateJSONConfigs', () => {
    it('should pass validation for valid mcp.json', async () => {
      const validMcpConfig = {
        mcpServers: {
          'test-server': {
            name: 'test-server',
            command: 'python',
            args: ['server.py'],
            timeout: 3600,
            env: {
              'TEST_VAR': 'test_value'
            }
          }
        },
        default_server: 'test-server',
        global_settings: {
          connection_timeout: 30.0
        }
      };

      vi.mocked(fs.pathExists).mockResolvedValue(true);
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockImplementation(async (filePath: string) => {
        if (filePath.includes('mcp.json')) {
          return JSON.stringify(validMcpConfig);
        }
        if (filePath.includes('config.json')) {
          return JSON.stringify({ defaultSubagent: 'claude' });
        }
        throw new Error('File not found');
      });

      const result = await validateJSONConfigs(testBaseDir);

      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it('should fail validation for missing required mcp.json', async () => {
      vi.mocked(fs.pathExists).mockImplementation(async (filePath: string) => {
        return !filePath.includes('mcp.json'); // mcp.json missing, config.json exists
      });
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockImplementation(async (filePath: string) => {
        if (filePath.includes('config.json')) {
          return JSON.stringify({ defaultSubagent: 'claude' });
        }
        throw new Error('File not found');
      });

      const result = await validateJSONConfigs(testBaseDir);

      expect(result.isValid).toBe(false);
      const mcpError = result.errors.find(e => e.file === '.juno_task/mcp.json');
      expect(mcpError).toBeDefined();
      expect(mcpError?.type).toBe('missing_file');
      expect(mcpError?.message).toContain('Required configuration file not found');
    });

    it('should handle JSON parse errors', async () => {
      vi.mocked(fs.pathExists).mockResolvedValue(true);
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockImplementation(async (filePath: string) => {
        if (filePath.includes('mcp.json')) {
          return '{ invalid json }'; // Invalid JSON
        }
        return '{}';
      });

      const result = await validateJSONConfigs(testBaseDir);

      expect(result.isValid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].type).toBe('parse_error');
      expect(result.errors[0].message).toContain('Invalid JSON syntax');
    });

    it('should detect missing required fields in mcp.json', async () => {
      const invalidMcpConfig = {
        mcpServers: {
          'test-server': {
            // Missing required fields: name, command, args
            timeout: 3600
          }
        }
        // Missing required field: default_server
      };

      vi.mocked(fs.pathExists).mockResolvedValue(true);
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockImplementation(async (filePath: string) => {
        if (filePath.includes('mcp.json')) {
          return JSON.stringify(invalidMcpConfig);
        }
        return '{}';
      });

      const result = await validateJSONConfigs(testBaseDir);

      expect(result.isValid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);

      const missingFieldErrors = result.errors.filter(e => e.message.includes('Missing required field'));
      expect(missingFieldErrors.length).toBeGreaterThan(0);
    });

    it('should detect invalid default_server reference', async () => {
      const invalidMcpConfig = {
        mcpServers: {
          'test-server': {
            name: 'test-server',
            command: 'python',
            args: ['server.py']
          }
        },
        default_server: 'nonexistent-server' // References a server that doesn't exist
      };

      vi.mocked(fs.pathExists).mockResolvedValue(true);
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockImplementation(async (filePath: string) => {
        if (filePath.includes('mcp.json')) {
          return JSON.stringify(invalidMcpConfig);
        }
        return '{}';
      });

      const result = await validateJSONConfigs(testBaseDir);

      expect(result.isValid).toBe(false);
      const defaultServerError = result.errors.find(e => e.message.includes('default_server'));
      expect(defaultServerError).toBeDefined();
      expect(defaultServerError?.message).toContain('not found in mcpServers');
    });

    it('should handle permission errors', async () => {
      vi.mocked(fs.pathExists).mockImplementation(async (filePath: string) => {
        return filePath.includes('mcp.json'); // Only mcp.json exists
      });
      vi.mocked(fs.access).mockRejectedValue(new Error('Permission denied'));

      const result = await validateJSONConfigs(testBaseDir);

      expect(result.isValid).toBe(false);
      const permissionError = result.errors.find(e => e.type === 'permission_error');
      expect(permissionError).toBeDefined();
      expect(permissionError?.message).toContain('Cannot read configuration file');
    });

    it('should warn about unusual config.json values', async () => {
      const unusualConfig = {
        defaultSubagent: 'unknown-agent', // Not a standard subagent
        defaultMaxIterations: 'invalid'    // Wrong type
      };

      vi.mocked(fs.pathExists).mockImplementation(async (filePath: string) => {
        return filePath.includes('config.json'); // Only config.json exists
      });
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockImplementation(async (filePath: string) => {
        if (filePath.includes('config.json')) {
          return JSON.stringify(unusualConfig);
        }
        return '{}';
      });

      const result = await validateJSONConfigs(testBaseDir);

      expect(result.isValid).toBe(false); // Should fail due to type error
      expect(result.errors.some(e => e.message.includes('incorrect type'))).toBe(true);
      expect(result.warnings.some(w => w.message.includes('not a standard subagent'))).toBe(true);
    });

    it('should handle missing optional config.json gracefully', async () => {
      const validMcpConfig = {
        mcpServers: {
          'test-server': {
            name: 'test-server',
            command: 'python',
            args: ['server.py']
          }
        },
        default_server: 'test-server'
      };

      vi.mocked(fs.pathExists).mockImplementation(async (filePath: string) => {
        return filePath.includes('mcp.json'); // Only mcp.json exists
      });
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockImplementation(async (filePath: string) => {
        if (filePath.includes('mcp.json')) {
          return JSON.stringify(validMcpConfig);
        }
        throw new Error('File not found');
      });

      const result = await validateJSONConfigs(testBaseDir);

      expect(result.isValid).toBe(true);
      expect(result.warnings.some(w => w.file === '.juno_task/config.json')).toBe(true);
      expect(result.warnings.some(w => w.type === 'missing_optional')).toBe(true);
    });
  });

  describe('displayValidationResults', () => {
    it('should display success message for valid config', () => {
      const result: ValidationResult = {
        isValid: true,
        errors: [],
        warnings: []
      };

      displayValidationResults(result);

      expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('All configuration files are valid'));
    });

    it('should display errors with suggestions', () => {
      const result: ValidationResult = {
        isValid: false,
        errors: [{
          file: '.juno_task/mcp.json',
          type: 'parse_error',
          message: 'Invalid JSON syntax',
          suggestions: ['Check for missing commas', 'Use a JSON validator']
        }],
        warnings: []
      };

      displayValidationResults(result);

      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Configuration Validation Errors'));
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid JSON syntax'));
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Check for missing commas'));
    });

    it('should display warnings', () => {
      const result: ValidationResult = {
        isValid: true,
        errors: [],
        warnings: [{
          file: '.juno_task/config.json',
          type: 'unusual_value',
          message: 'Unusual subagent value',
          suggestions: ['Use standard subagent names']
        }]
      };

      displayValidationResults(result);

      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Configuration Warnings'));
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Unusual subagent value'));
    });
  });

  describe('logValidationResults', () => {
    it('should create detailed log file', async () => {
      const result: ValidationResult = {
        isValid: false,
        errors: [{
          file: '.juno_task/mcp.json',
          type: 'parse_error',
          message: 'Invalid JSON syntax',
          details: 'Unexpected token at position 5',
          suggestions: ['Check for missing commas']
        }],
        warnings: [{
          file: '.juno_task/config.json',
          type: 'missing_optional',
          message: 'Optional file not found'
        }]
      };

      const logFile = await logValidationResults(result, testBaseDir);

      expect(vi.mocked(fs.ensureDir)).toHaveBeenCalledWith(path.join(testBaseDir, '.juno_task', 'logs'));
      expect(vi.mocked(fs.writeFile)).toHaveBeenCalledWith(
        expect.stringContaining('startup-validation-'),
        expect.stringContaining('Overall Status: INVALID')
      );
      expect(logFile).toContain('startup-validation-');
    });

    it('should log successful validation', async () => {
      const result: ValidationResult = {
        isValid: true,
        errors: [],
        warnings: []
      };

      await logValidationResults(result, testBaseDir);

      expect(vi.mocked(fs.writeFile)).toHaveBeenCalledWith(
        expect.stringContaining('startup-validation-'),
        expect.stringContaining('Overall Status: VALID')
      );
    });
  });

  describe('validateStartupConfigs', () => {
    it('should return true for valid configuration', async () => {
      const validMcpConfig = {
        mcpServers: {
          'test-server': {
            name: 'test-server',
            command: 'python',
            args: ['server.py']
          }
        },
        default_server: 'test-server'
      };

      vi.mocked(fs.pathExists).mockResolvedValue(true);
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockImplementation(async (filePath: string) => {
        if (filePath.includes('mcp.json')) {
          return JSON.stringify(validMcpConfig);
        }
        return '{}';
      });

      const result = await validateStartupConfigs(testBaseDir, false);

      expect(result).toBe(true);
      expect(vi.mocked(fs.writeFile)).toHaveBeenCalled(); // Log file created
    });

    it('should return false for invalid configuration', async () => {
      vi.mocked(fs.pathExists).mockResolvedValue(false); // Missing required mcp.json

      const result = await validateStartupConfigs(testBaseDir, false);

      expect(result).toBe(false);
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Configuration validation failed'));
    });

    it('should handle validation system errors gracefully', async () => {
      vi.mocked(fs.pathExists).mockRejectedValue(new Error('System error'));

      const result = await validateStartupConfigs(testBaseDir, false);

      expect(result).toBe(true); // Should not block startup for system errors
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Configuration validation system error'));
    });

    it('should show verbose output when requested', async () => {
      const validConfig = {
        mcpServers: { 'test': { name: 'test', command: 'python', args: ['test.py'] } },
        default_server: 'test'
      };

      vi.mocked(fs.pathExists).mockResolvedValue(true);
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(validConfig));

      await validateStartupConfigs(testBaseDir, true);

      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Validating JSON configuration files'));
    });
  });
});