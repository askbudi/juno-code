/**
 * Unified Error Hierarchy Tests
 *
 * Comprehensive tests for the unified error system to ensure
 * all components work together correctly.
 */

import { describe, it, expect } from 'vitest';

// Import error classes
import {
  JunoTaskError,
  ErrorCategory,
  ErrorCode,
  createErrorContext,
  SystemError,
  FileNotFoundError,
  PermissionDeniedError,
  ValidationError,
  RequiredFieldError,
  InvalidFormatError,
  MCPError,
  MCPConnectionError,
  MCPToolError,
  ConfigurationError,
  ConfigFileNotFoundError,
  TemplateError,
  TemplateNotFoundError,
  SessionError,
  SessionNotFoundError,
  CLIError,
  CommandNotFoundError,
  TUIError,
  TUINotAvailableError,
  errorRecoveryManager,
  isJunoTaskError,
  hasErrorCode,
  hasErrorCategory,
  formatError
} from '../index';

describe('Unified Error Hierarchy', () => {
  describe('Base Error Class', () => {
    it('should create error with proper hierarchy', () => {
      const error = new FileNotFoundError('/test/file.txt');

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(JunoTaskError);
      expect(error).toBeInstanceOf(SystemError);
      expect(error).toBeInstanceOf(FileNotFoundError);
    });

    it('should have correct properties', () => {
      const error = new FileNotFoundError('/test/file.txt', 'read');

      expect(error.category).toBe(ErrorCategory.SYSTEM);
      expect(error.code).toBe(ErrorCode.SYSTEM_FILE_NOT_FOUND);
      expect(error.message).toContain('File not found during read: /test/file.txt');
      expect(error.id).toBeDefined();
      expect(error.timestamp).toBeInstanceOf(Date);
      expect(error.context).toBeDefined();
      expect(error.context.metadata?.filePath).toBe('/test/file.txt');
      expect(error.context.metadata?.operation).toBe('read');
    });

    it('should support error chaining', () => {
      const causeError = new Error('Original cause');
      const error = new FileNotFoundError('/test/file.txt', 'read', { cause: causeError });

      expect(error.cause).toBe(causeError);
      expect(error.stack).toContain('Caused by:');
    });

    it('should provide recovery actions', () => {
      const error = new FileNotFoundError('/test/file.txt');

      expect(error.getRecoveryActions()).toHaveLength(2);
      expect(error.getRecoveryActions()[0].id).toBe('create_file');
      expect(error.isRecoverable()).toBe(true);
    });

    it('should serialize to JSON correctly', () => {
      const error = new FileNotFoundError('/test/file.txt');
      const json = error.toJSON();

      expect(json.id).toBe(error.id);
      expect(json.name).toBe('FileNotFoundError');
      expect(json.code).toBe(ErrorCode.SYSTEM_FILE_NOT_FOUND);
      expect(json.category).toBe(ErrorCategory.SYSTEM);
      expect(json.context).toBeDefined();
    });
  });

  describe('Error Categories', () => {
    it('should create system errors correctly', () => {
      const fileError = new FileNotFoundError('/test/file.txt');
      const permError = new PermissionDeniedError('/test/dir', 'write');

      expect(fileError.category).toBe(ErrorCategory.SYSTEM);
      expect(permError.category).toBe(ErrorCategory.SYSTEM);
      expect(fileError.code).toBe(ErrorCode.SYSTEM_FILE_NOT_FOUND);
      expect(permError.code).toBe(ErrorCode.SYSTEM_PERMISSION_DENIED);
    });

    it('should create validation errors correctly', () => {
      const requiredError = new RequiredFieldError('username');
      const formatError = new InvalidFormatError('email', 'invalid-email', 'valid email address');

      expect(requiredError.category).toBe(ErrorCategory.VALIDATION);
      expect(formatError.category).toBe(ErrorCategory.VALIDATION);
      expect(requiredError.code).toBe(ErrorCode.VALIDATION_REQUIRED_FIELD);
      expect(formatError.code).toBe(ErrorCode.VALIDATION_INVALID_FORMAT);
    });

    it('should create MCP errors correctly', () => {
      const connError = new MCPConnectionError('test-server');
      const toolError = new MCPToolError('test-tool', 'Tool failed');

      expect(connError.category).toBe(ErrorCategory.MCP);
      expect(toolError.category).toBe(ErrorCategory.MCP);
      expect(connError.code).toBe(ErrorCode.MCP_CONNECTION_FAILED);
      expect(toolError.code).toBe(ErrorCode.MCP_TOOL_EXECUTION_FAILED);
    });

    it('should create configuration errors correctly', () => {
      const configError = new ConfigFileNotFoundError('/config/app.json');

      expect(configError.category).toBe(ErrorCategory.CONFIGURATION);
      expect(configError.code).toBe(ErrorCode.CONFIG_FILE_NOT_FOUND);
    });

    it('should create template errors correctly', () => {
      const templateError = new TemplateNotFoundError('init-template');

      expect(templateError.category).toBe(ErrorCategory.TEMPLATE);
      expect(templateError.code).toBe(ErrorCode.TEMPLATE_NOT_FOUND);
    });

    it('should create session errors correctly', () => {
      const sessionError = new SessionNotFoundError('session-123');

      expect(sessionError.category).toBe(ErrorCategory.SESSION);
      expect(sessionError.code).toBe(ErrorCode.SESSION_NOT_FOUND);
    });

    it('should create CLI errors correctly', () => {
      const cliError = new CommandNotFoundError('unknown-cmd', ['init', 'start']);

      expect(cliError.category).toBe(ErrorCategory.CLI);
      expect(cliError.code).toBe(ErrorCode.CLI_COMMAND_NOT_FOUND);
    });

    it('should create TUI errors correctly', () => {
      const tuiError = new TUINotAvailableError('No TTY available');

      expect(tuiError.category).toBe(ErrorCategory.TUI);
      expect(tuiError.code).toBe(ErrorCode.TUI_NOT_AVAILABLE);
    });
  });

  describe('Error Context', () => {
    it('should create error context correctly', () => {
      const context = createErrorContext(
        ErrorCode.SYSTEM_FILE_NOT_FOUND,
        ErrorCategory.SYSTEM,
        {
          component: 'file-reader',
          operation: 'readFile',
          isRetriable: true
        }
      );

      expect(context.code).toBe(ErrorCode.SYSTEM_FILE_NOT_FOUND);
      expect(context.category).toBe(ErrorCategory.SYSTEM);
      expect(context.component).toBe('file-reader');
      expect(context.operation).toBe('readFile');
      expect(context.isRetriable).toBe(true);
      expect(context.timestamp).toBeInstanceOf(Date);
    });

    it('should provide rich metadata', () => {
      const error = new MCPConnectionError('test-server', 'Connection timeout', {
        context: {
          metadata: {
            serverConfig: { host: 'localhost', port: 8080 },
            custom: { retryCount: 3 }
          }
        }
      });

      expect(error.context.metadata?.serverName).toBe('test-server');
      expect(error.context.metadata?.details).toBe('Connection timeout');
      expect(error.context.metadata?.serverConfig).toEqual({ host: 'localhost', port: 8080 });
      expect(error.context.metadata?.custom).toEqual({ retryCount: 3 });
    });
  });

  describe('Recovery System', () => {
    it('should provide default recovery actions', () => {
      const error = new FileNotFoundError('/test/file.txt');
      const actions = error.getRecoveryActions();

      expect(actions).toHaveLength(2);
      expect(actions[0].id).toBe('create_file');
      expect(actions[0].canAutomate).toBe(false);
      expect(actions[1].id).toBe('use_alternative_path');
      expect(actions[1].canAutomate).toBe(true);
    });

    it('should support retry logic', () => {
      const error = new MCPConnectionError('test-server');

      expect(error.isRetryable()).toBe(true);
      expect(error.getMaxRetries()).toBe(3);
      expect(error.shouldRetry(1)).toBe(true);
      expect(error.shouldRetry(5)).toBe(false);
    });

    it('should calculate retry delays with backoff', () => {
      const error = new MCPConnectionError('test-server');
      const strategy = error.getBackoffStrategy();

      const delay1 = strategy.calculateDelay(1);
      const delay2 = strategy.calculateDelay(2);
      const delay3 = strategy.calculateDelay(3);

      expect(delay2).toBeGreaterThan(delay1);
      expect(delay3).toBeGreaterThan(delay2);
      expect(delay3).toBeLessThanOrEqual(strategy.maxDelay);
    });

    it('should create recovery plans', () => {
      const error = new MCPConnectionError('test-server');
      const plan = errorRecoveryManager.createRecoveryPlan(error);

      expect(plan.id).toBeDefined();
      expect(plan.error).toBe(error);
      expect(plan.strategies).toBeDefined();
      expect(plan.metadata.createdAt).toBeInstanceOf(Date);
    });
  });

  describe('Error Utilities', () => {
    it('should identify JunoTask errors', () => {
      const junoError = new FileNotFoundError('/test/file.txt');
      const regularError = new Error('Regular error');

      expect(isJunoTaskError(junoError)).toBe(true);
      expect(isJunoTaskError(regularError)).toBe(false);
      expect(isJunoTaskError('string')).toBe(false);
      expect(isJunoTaskError(null)).toBe(false);
    });

    it('should check error codes', () => {
      const error = new FileNotFoundError('/test/file.txt');

      expect(hasErrorCode(error, ErrorCode.SYSTEM_FILE_NOT_FOUND)).toBe(true);
      expect(hasErrorCode(error, ErrorCode.SYSTEM_PERMISSION_DENIED)).toBe(false);
      expect(hasErrorCode(new Error('regular'), ErrorCode.SYSTEM_FILE_NOT_FOUND)).toBe(false);
    });

    it('should check error categories', () => {
      const systemError = new FileNotFoundError('/test/file.txt');
      const mcpError = new MCPConnectionError('test-server');

      expect(hasErrorCategory(systemError, ErrorCategory.SYSTEM)).toBe(true);
      expect(hasErrorCategory(systemError, ErrorCategory.MCP)).toBe(false);
      expect(hasErrorCategory(mcpError, ErrorCategory.MCP)).toBe(true);
      expect(hasErrorCategory(new Error('regular'), ErrorCategory.SYSTEM)).toBe(false);
    });

    it('should format errors correctly', () => {
      const junoError = new FileNotFoundError('/test/file.txt');
      const regularError = new Error('Regular error');

      const junoFormatted = formatError(junoError);
      const regularFormatted = formatError(regularError);

      expect(junoFormatted).toContain('File not found: /test/file.txt');
      expect(junoFormatted).toContain('Suggestions:');
      expect(regularFormatted).toBe('Regular error');
    });
  });

  describe('Error Integration', () => {
    it('should work with async/await patterns', async () => {
      const createAsyncError = async (): Promise<never> => {
        throw new MCPConnectionError('test-server', 'Async failure');
      };

      await expect(createAsyncError()).rejects.toThrow(MCPConnectionError);
      await expect(createAsyncError()).rejects.toHaveProperty('code', ErrorCode.MCP_CONNECTION_FAILED);
    });

    it('should support instanceof checks with inheritance', () => {
      const fileError = new FileNotFoundError('/test/file.txt');
      const mcpError = new MCPConnectionError('test-server');

      // Base classes
      expect(fileError instanceof Error).toBe(true);
      expect(fileError instanceof JunoTaskError).toBe(true);
      expect(fileError instanceof SystemError).toBe(true);
      expect(mcpError instanceof MCPError).toBe(true);

      // Cross-category checks should fail
      expect(fileError instanceof MCPError).toBe(false);
      expect(mcpError instanceof SystemError).toBe(false);
    });

    it('should provide user-friendly messages', () => {
      const error = new RequiredFieldError('username', {
        fieldPath: 'user.credentials.username',
        expectedType: 'string'
      });

      const userMessage = error.getUserMessage();

      expect(userMessage).toContain('Required field \'username\' is missing at path: user.credentials.username');
      expect(userMessage).toContain('Suggestions:');
      expect(userMessage).toContain('Expected type: string');
    });
  });

  describe('Performance and Memory', () => {
    it('should not leak memory with large error chains', () => {
      let lastError: Error | undefined;

      // Create a chain of 100 errors
      for (let i = 0; i < 100; i++) {
        lastError = new FileNotFoundError(`/test/file${i}.txt`, 'read', { cause: lastError });
      }

      expect(lastError).toBeInstanceOf(FileNotFoundError);
      expect(lastError!.cause).toBeDefined();

      // The error should still be functional
      expect(isJunoTaskError(lastError)).toBe(true);
      expect(lastError!.message).toContain('file99.txt');
    });

    it('should create errors efficiently', () => {
      const startTime = Date.now();
      const errors: JunoTaskError[] = [];

      // Create 1000 errors
      for (let i = 0; i < 1000; i++) {
        errors.push(new FileNotFoundError(`/test/file${i}.txt`));
      }

      const duration = Date.now() - startTime;

      expect(errors).toHaveLength(1000);
      expect(duration).toBeLessThan(1000); // Should complete in under 1 second
      expect(errors[0].id).not.toBe(errors[999].id); // Should have unique IDs
    });
  });
});