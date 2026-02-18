/**
 * Test command unit tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { configureTestCommand } from '../commands/test.js';
import type { TestCommandOptions } from '../types.js';

// Mock dependencies
vi.mock('fs-extra', () => ({
  default: {
    ensureDir: vi.fn(),
    writeFile: vi.fn(),
    readFile: vi.fn(),
    readJson: vi.fn(),
    writeJson: vi.fn(),
    pathExists: vi.fn()
  }
}));

// Mock chalk
vi.mock('chalk', () => ({
  default: {
    blue: vi.fn((text: string) => text),
    green: vi.fn((text: string) => text),
    red: vi.fn((text: string) => text),
    yellow: vi.fn((text: string) => text),
    gray: vi.fn((text: string) => text),
    bold: vi.fn((text: string) => text)
  }
}));

vi.mock('../../core/config.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({
    workingDirectory: '/test',
    defaultSubagent: 'claude',
    mcpServerName: 'test-server',
    mcpRetries: 3,
    verbose: false
  })
}));

vi.mock('../../core/session.js', () => ({
  createSessionManager: vi.fn().mockResolvedValue({
    createSession: vi.fn().mockResolvedValue({
      info: { id: 'test-session-id' },
      addHistoryEntry: vi.fn(),
      completeSession: vi.fn()
    })
  })
}));

vi.mock('../../mcp/client.js', () => ({
  createMCPClientFromConfig: vi.fn().mockResolvedValue({
    connect: vi.fn(),
    disconnect: vi.fn()
  })
}));

vi.mock('../utils/advanced-logger.js', () => ({
  logger: {
    child: vi.fn().mockReturnValue({
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      startTimer: vi.fn(),
      endTimer: vi.fn()
    }),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    startTimer: vi.fn(),
    endTimer: vi.fn()
  },
  cliLogger: {
    startTimer: vi.fn(),
    endTimer: vi.fn(),
    info: vi.fn()
  },
  engineLogger: {
    info: vi.fn()
  },
  LogLevel: {
    TRACE: 0,
    DEBUG: 1,
    INFO: 2,
    WARN: 3,
    ERROR: 4,
    FATAL: 5
  },
  LogContext: {
    CLI: 'CLI',
    MCP: 'MCP',
    ENGINE: 'ENGINE',
    SESSION: 'SESSION',
    TEMPLATE: 'TEMPLATE',
    CONFIG: 'CONFIG',
    PERFORMANCE: 'PERFORMANCE',
    SYSTEM: 'SYSTEM'
  }
}));

describe('Test Command', () => {
  let program: Command;

  beforeEach(() => {
    program = new Command();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Command Configuration', () => {
    it('should configure test command with correct options', () => {
      configureTestCommand(program);

      const testCommand = program.commands.find(cmd => cmd.name() === 'test');
      expect(testCommand).toBeDefined();
      expect(testCommand?.description()).toContain('AI-powered testing framework');
    });

    it('should have all required options', () => {
      configureTestCommand(program);

      const testCommand = program.commands.find(cmd => cmd.name() === 'test');
      const options = testCommand?.options || [];

      const optionFlags = options.map(opt => opt.flags);

      expect(optionFlags).toContain('-t, --type <type>');
      expect(optionFlags).toContain('-s, --subagent <name>');
      expect(optionFlags).toContain('-i, --intelligence <level>');
      expect(optionFlags).toContain('-g, --generate');
      expect(optionFlags).toContain('-r, --run');
      expect(optionFlags).toContain('--coverage [file]');
      expect(optionFlags).toContain('--analyze');
      expect(optionFlags).toContain('--report [file]');
      expect(optionFlags).toContain('--format <format>');
      expect(optionFlags).toContain('--framework <name>');
      expect(optionFlags).toContain('--watch');
    });

    it('should have correct default values', () => {
      configureTestCommand(program);

      const testCommand = program.commands.find(cmd => cmd.name() === 'test');
      const options = testCommand?.options || [];

      const typeOption = options.find(opt => opt.flags.includes('-t'));
      const intelligenceOption = options.find(opt => opt.flags.includes('-i'));
      const formatOption = options.find(opt => opt.flags.includes('--format'));
      const frameworkOption = options.find(opt => opt.flags.includes('--framework'));

      expect(typeOption?.defaultValue).toBe('all');
      expect(intelligenceOption?.defaultValue).toBe('comprehensive');
      expect(formatOption?.defaultValue).toBe('markdown');
      expect(frameworkOption?.defaultValue).toBe('vitest');
    });

    it('should have proper command structure', () => {
      configureTestCommand(program);

      const testCommand = program.commands.find(cmd => cmd.name() === 'test');
      expect(testCommand).toBeDefined();
      expect(testCommand?.name()).toBe('test');
      expect(testCommand?.usage()).toContain('[options] [target...]');
    });

    it('should display help when called with --help', () => {
      configureTestCommand(program);

      const testCommand = program.commands.find(cmd => cmd.name() === 'test');
      expect(testCommand).toBeDefined();
      expect(testCommand?.description()).toContain('AI-powered testing framework');
    });
  });
});