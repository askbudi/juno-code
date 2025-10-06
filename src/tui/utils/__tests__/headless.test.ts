/**
 * @fileoverview Tests for headless TUI utilities
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  headlessPromptEditor,
  headlessConfirmation,
  headlessSelection,
  headlessAlert,
  getTUICapabilities,
  enhanceForTerminal,
  safeConsoleOutput,
  createHeadlessProgress,
  getEnvironmentType
} from '../headless.js';

// Mock dependencies
vi.mock('../../../utils/environment.js', () => ({
  isHeadlessEnvironment: vi.fn().mockReturnValue(false)
}));

// Mock readline
const mockReadline = {
  createInterface: vi.fn().mockReturnValue({
    question: vi.fn(),
    close: vi.fn()
  })
};

vi.mock('readline', () => mockReadline);

// Mock chalk
const mockChalk = {
  bold: vi.fn((text) => `bold(${text})`),
  red: vi.fn((text) => `red(${text})`),
  green: vi.fn((text) => `green(${text})`)
};

vi.mock('chalk', () => mockChalk);

describe('Headless TUI Utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Mock console methods
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('headlessPromptEditor', () => {
    beforeEach(() => {
      // Mock process.stdin
      const mockStdin = {
        setEncoding: vi.fn(),
        resume: vi.fn(),
        on: vi.fn(),
        end: vi.fn()
      };

      Object.defineProperty(process, 'stdin', {
        value: mockStdin,
        writable: true
      });
    });

    it('should display prompt title and instructions', async () => {
      const options = {
        title: 'Test Prompt',
        maxLength: 500
      };

      // Setup promise to resolve immediately
      const mockStdin = process.stdin as any;
      mockStdin.on.mockImplementation((event: string, callback: Function) => {
        if (event === 'end') {
          // Simulate immediate end
          setTimeout(() => callback(), 0);
        }
      });

      const promise = headlessPromptEditor(options);

      expect(console.log).toHaveBeenCalledWith('\nTest Prompt:');
      expect(console.log).toHaveBeenCalledWith('Maximum length: 500 characters');

      await promise;
    });

    it('should handle initial value', async () => {
      const options = {
        initialValue: 'Initial text',
        title: 'Test'
      };

      const mockStdin = process.stdin as any;
      mockStdin.on.mockImplementation((event: string, callback: Function) => {
        if (event === 'end') {
          setTimeout(() => callback(), 0);
        }
      });

      const promise = headlessPromptEditor(options);

      expect(console.log).toHaveBeenCalledWith('Initial value: Initial text');

      await promise;
    });

    it('should handle input data and return result', async () => {
      const mockStdin = process.stdin as any;
      let dataCallback: Function;
      let endCallback: Function;

      mockStdin.on.mockImplementation((event: string, callback: Function) => {
        if (event === 'data') {
          dataCallback = callback;
        } else if (event === 'end') {
          endCallback = callback;
        }
      });

      const promise = headlessPromptEditor({ initialValue: 'start' });

      // Simulate input
      dataCallback('additional text');
      endCallback();

      const result = await promise;
      expect(result).toBe('startadditional text');
    });

    it('should reject input that exceeds max length', async () => {
      const mockStdin = process.stdin as any;
      let endCallback: Function;

      mockStdin.on.mockImplementation((event: string, callback: Function) => {
        if (event === 'end') {
          endCallback = callback;
        }
      });

      const promise = headlessPromptEditor({
        initialValue: 'verylongtext',
        maxLength: 5
      });

      endCallback();

      const result = await promise;
      expect(result).toBeNull();
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Prompt too long')
      );
    });

    it('should handle input errors', async () => {
      const mockStdin = process.stdin as any;
      let errorCallback: Function;

      mockStdin.on.mockImplementation((event: string, callback: Function) => {
        if (event === 'error') {
          errorCallback = callback;
        }
      });

      const promise = headlessPromptEditor({});

      errorCallback(new Error('Input error'));

      const result = await promise;
      expect(result).toBeNull();
      expect(console.error).toHaveBeenCalledWith(
        '\nError reading input:',
        expect.any(Error)
      );
    });

    it('should return null for empty input', async () => {
      const mockStdin = process.stdin as any;
      let endCallback: Function;

      mockStdin.on.mockImplementation((event: string, callback: Function) => {
        if (event === 'end') {
          endCallback = callback;
        }
      });

      const promise = headlessPromptEditor({ initialValue: '   ' });

      endCallback();

      const result = await promise;
      expect(result).toBeNull();
    });
  });

  describe('headlessConfirmation', () => {
    it('should display confirmation message', async () => {
      const mockRl = {
        question: vi.fn(),
        close: vi.fn()
      };

      mockReadline.createInterface.mockReturnValue(mockRl);

      headlessConfirmation({
        message: 'Are you sure?',
        defaultValue: true
      });

      expect(console.log).toHaveBeenCalledWith('\nAre you sure?');
      expect(console.log).toHaveBeenCalledWith(
        "Enter 'y' for yes, 'n' for no (default: y):"
      );
    });

    it('should return true for yes answers', async () => {
      const mockRl = {
        question: vi.fn((prompt, callback) => {
          // Make callback async to avoid hanging
          setTimeout(() => callback('y'), 0);
        }),
        close: vi.fn()
      };

      mockReadline.createInterface.mockReturnValue(mockRl);

      const result = await headlessConfirmation({
        message: 'Confirm?'
      });

      expect(result).toBe(true);
      expect(mockRl.close).toHaveBeenCalled();
    });

    it('should return false for no answers', async () => {
      const mockRl = {
        question: vi.fn((prompt, callback) => setTimeout(() => callback('n'), 0)),
        close: vi.fn()
      };

      mockReadline.createInterface.mockReturnValue(mockRl);

      const result = await headlessConfirmation({
        message: 'Confirm?'
      });

      expect(result).toBe(false);
    });

    it('should return default value for empty answer', async () => {
      const mockRl = {
        question: vi.fn((prompt, callback) => setTimeout(() => callback(''), 0)),
        close: vi.fn()
      };

      mockReadline.createInterface.mockReturnValue(mockRl);

      const result = await headlessConfirmation({
        message: 'Confirm?',
        defaultValue: true
      });

      expect(result).toBe(true);
    });

    it('should handle various yes/no formats', async () => {
      const testCases = [
        { input: 'yes', expected: true },
        { input: 'YES', expected: true },
        { input: 'Y', expected: true },
        { input: 'no', expected: false },
        { input: 'NO', expected: false },
        { input: 'N', expected: false }
      ];

      for (const testCase of testCases) {
        const mockRl = {
          question: vi.fn((prompt, callback) => setTimeout(() => callback(testCase.input), 0)),
          close: vi.fn()
        };

        mockReadline.createInterface.mockReturnValue(mockRl);

        const result = await headlessConfirmation({
          message: 'Test?'
        });

        expect(result).toBe(testCase.expected);
      }
    });
  });

  describe('headlessSelection', () => {
    const choices = [
      { label: 'Option A', value: 'a', description: 'First option' },
      { label: 'Option B', value: 'b' },
      { label: 'Option C', value: 'c' }
    ];

    it('should display selection options', async () => {
      const mockRl = {
        question: vi.fn(),
        close: vi.fn()
      };

      mockReadline.createInterface.mockReturnValue(mockRl);

      headlessSelection({
        message: 'Choose option:',
        choices
      });

      expect(console.log).toHaveBeenCalledWith('\nChoose option:');
      expect(console.log).toHaveBeenCalledWith('Available options:');
      expect(console.log).toHaveBeenCalledWith('  1. Option A - First option');
      expect(console.log).toHaveBeenCalledWith('  2. Option B');
      expect(console.log).toHaveBeenCalledWith('  3. Option C');
    });

    it('should return selected value for single selection', async () => {
      const mockRl = {
        question: vi.fn((prompt, callback) => setTimeout(() => callback('2'), 0)),
        close: vi.fn()
      };

      mockReadline.createInterface.mockReturnValue(mockRl);

      const result = await headlessSelection({
        message: 'Choose:',
        choices
      });

      expect(result).toBe('b');
    });

    it('should return multiple selected values', async () => {
      const mockRl = {
        question: vi.fn((prompt, callback) => setTimeout(() => callback('1,3'), 0)),
        close: vi.fn()
      };

      mockReadline.createInterface.mockReturnValue(mockRl);

      const result = await headlessSelection({
        message: 'Choose:',
        choices,
        multiple: true
      });

      expect(result).toEqual(['a', 'c']);
    });

    it('should handle invalid selections', async () => {
      const mockRl = {
        question: vi.fn((prompt, callback) => setTimeout(() => callback('5'), 0)),
        close: vi.fn()
      };

      mockReadline.createInterface.mockReturnValue(mockRl);

      const result = await headlessSelection({
        message: 'Choose:',
        choices
      });

      expect(result).toBeNull();
    });

    it('should handle multiple selection with mixed valid/invalid indexes', async () => {
      const mockRl = {
        question: vi.fn((prompt, callback) => setTimeout(() => callback('1,5,2'), 0)),
        close: vi.fn()
      };

      mockReadline.createInterface.mockReturnValue(mockRl);

      const result = await headlessSelection({
        message: 'Choose:',
        choices,
        multiple: true
      });

      expect(result).toEqual(['a', 'b']); // Only valid selections
    });

    it('should return null for empty multiple selection', async () => {
      const mockRl = {
        question: vi.fn((prompt, callback) => setTimeout(() => callback('5,6'), 0)),
        close: vi.fn()
      };

      mockReadline.createInterface.mockReturnValue(mockRl);

      const result = await headlessSelection({
        message: 'Choose:',
        choices,
        multiple: true
      });

      expect(result).toBeNull();
    });

    it('should handle parse errors gracefully', async () => {
      const mockRl = {
        question: vi.fn((prompt, callback) => setTimeout(() => callback('abc'), 0)),
        close: vi.fn()
      };

      mockReadline.createInterface.mockReturnValue(mockRl);

      const result = await headlessSelection({
        message: 'Choose:',
        choices
      });

      expect(result).toBeNull();
    });
  });

  describe('headlessAlert', () => {
    it('should display alert with default info type', () => {
      headlessAlert({
        message: 'This is an alert'
      });

      expect(console.log).toHaveBeenCalledWith('\nℹ This is an alert\n');
    });

    it('should display alert with title', () => {
      headlessAlert({
        title: 'Important',
        message: 'This is important'
      });

      expect(console.log).toHaveBeenCalledWith('\nℹ Important: This is important\n');
    });

    it('should use correct icons for different types', () => {
      const types = [
        { type: 'info' as const, icon: 'ℹ' },
        { type: 'success' as const, icon: '✓' },
        { type: 'warning' as const, icon: '⚠' },
        { type: 'error' as const, icon: '✗' }
      ];

      types.forEach(({ type, icon }) => {
        headlessAlert({
          message: 'Test message',
          type
        });

        expect(console.log).toHaveBeenCalledWith(`\n${icon} Test message\n`);
      });
    });
  });

  describe('getTUICapabilities', () => {
    it('should detect terminal capabilities', () => {
      // Mock process.stdout
      Object.defineProperty(process.stdout, 'isTTY', {
        value: true,
        writable: true
      });
      Object.defineProperty(process.stdout, 'columns', {
        value: 120,
        writable: true
      });
      Object.defineProperty(process.stdout, 'rows', {
        value: 30,
        writable: true
      });

      const capabilities = getTUICapabilities();

      expect(capabilities).toEqual({
        hasColors: true,
        hasUnicode: true,
        terminalWidth: 120,
        terminalHeight: 30,
        isInteractive: true,
        supportsRichText: true
      });
    });

    it('should handle non-TTY environment', () => {
      Object.defineProperty(process.stdout, 'isTTY', {
        value: false,
        writable: true
      });

      const capabilities = getTUICapabilities();

      expect(capabilities.isInteractive).toBe(false);
      expect(capabilities.hasColors).toBe(false);
      expect(capabilities.supportsRichText).toBe(false);
    });

    it('should respect environment variables', () => {
      const originalEnv = process.env;

      process.env.TERM = 'dumb';
      process.env.ASCII_ONLY = '1';
      process.env.NO_RICH_TEXT = '1';

      Object.defineProperty(process.stdout, 'isTTY', {
        value: true,
        writable: true
      });

      const capabilities = getTUICapabilities();

      expect(capabilities.hasColors).toBe(false);
      expect(capabilities.hasUnicode).toBe(false);
      expect(capabilities.supportsRichText).toBe(false);

      process.env = originalEnv;
    });

    it('should provide default dimensions', () => {
      Object.defineProperty(process.stdout, 'columns', {
        value: undefined,
        writable: true
      });
      Object.defineProperty(process.stdout, 'rows', {
        value: undefined,
        writable: true
      });

      const capabilities = getTUICapabilities();

      expect(capabilities.terminalWidth).toBe(80);
      expect(capabilities.terminalHeight).toBe(24);
    });
  });

  describe('enhanceForTerminal', () => {
    it('should use rich content when supported', () => {
      const content = {
        plain: 'plain text',
        colored: 'colored text',
        unicode: 'unicode text',
        rich: 'rich text'
      };

      vi.spyOn(require('../headless.js'), 'getTUICapabilities').mockReturnValue({
        supportsRichText: true,
        hasUnicode: true,
        hasColors: true
      });

      const result = enhanceForTerminal(content);
      expect(result).toBe('rich text');
    });

    it('should fall back to unicode when rich text not supported', () => {
      const content = {
        plain: 'plain text',
        colored: 'colored text',
        unicode: 'unicode text',
        rich: 'rich text'
      };

      vi.spyOn(require('../headless.js'), 'getTUICapabilities').mockReturnValue({
        supportsRichText: false,
        hasUnicode: true,
        hasColors: true
      });

      const result = enhanceForTerminal(content);
      expect(result).toBe('unicode text');
    });

    it('should fall back to colored when unicode not supported', () => {
      const content = {
        plain: 'plain text',
        colored: 'colored text'
      };

      vi.spyOn(require('../headless.js'), 'getTUICapabilities').mockReturnValue({
        supportsRichText: false,
        hasUnicode: false,
        hasColors: true
      });

      const result = enhanceForTerminal(content);
      expect(result).toBe('colored text');
    });

    it('should use plain text as final fallback', () => {
      const content = {
        plain: 'plain text'
      };

      vi.spyOn(require('../headless.js'), 'getTUICapabilities').mockReturnValue({
        supportsRichText: false,
        hasUnicode: false,
        hasColors: false
      });

      const result = enhanceForTerminal(content);
      expect(result).toBe('plain text');
    });
  });

  describe('safeConsoleOutput', () => {
    it('should output plain text without styling', () => {
      vi.spyOn(require('../headless.js'), 'getTUICapabilities').mockReturnValue({
        hasColors: false
      });

      safeConsoleOutput('test message');

      expect(console.log).toHaveBeenCalledWith('test message');
    });

    it('should apply colors when supported', () => {
      vi.spyOn(require('../headless.js'), 'getTUICapabilities').mockReturnValue({
        hasColors: true
      });

      safeConsoleOutput('test message', { color: 'red' });

      expect(console.log).toHaveBeenCalledWith('red(test message)');
    });

    it('should apply bold when supported', () => {
      vi.spyOn(require('../headless.js'), 'getTUICapabilities').mockReturnValue({
        hasColors: true
      });

      safeConsoleOutput('test message', { bold: true });

      expect(console.log).toHaveBeenCalledWith('bold(test message)');
    });

    it('should use different console methods', () => {
      safeConsoleOutput('error message', { type: 'error' });
      safeConsoleOutput('warning message', { type: 'warn' });
      safeConsoleOutput('info message', { type: 'info' });

      expect(console.error).toHaveBeenCalledWith('error message');
      expect(console.warn).toHaveBeenCalledWith('warning message');
      expect(console.info).toHaveBeenCalledWith('info message');
    });
  });

  describe('createHeadlessProgress', () => {
    beforeEach(() => {
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    });

    it('should create progress indicator with default options', () => {
      const progress = createHeadlessProgress({});

      expect(progress).toHaveProperty('update');
      expect(progress).toHaveProperty('complete');
      expect(progress).toHaveProperty('fail');
    });

    it('should update progress with percentage', () => {
      const progress = createHeadlessProgress({
        total: 100,
        label: 'Processing'
      });

      progress.update(50, 'halfway done');

      expect(process.stdout.write).toHaveBeenCalledWith(
        expect.stringContaining('Processing: 50%')
      );
    });

    it('should update progress without percentage', () => {
      const progress = createHeadlessProgress({
        label: 'Processing',
        showPercentage: false
      });

      progress.update(50);

      expect(process.stdout.write).toHaveBeenCalledWith(
        expect.stringContaining('Processing: 50')
      );
    });

    it('should complete progress', () => {
      const progress = createHeadlessProgress({
        label: 'Processing'
      });

      progress.complete('Done!');

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Done!')
      );
    });

    it('should handle progress failure', () => {
      const progress = createHeadlessProgress({
        label: 'Processing'
      });

      progress.fail('Failed!');

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed!')
      );
    });

    it('should throttle updates', () => {
      vi.useFakeTimers();

      const progress = createHeadlessProgress({
        total: 100
      });

      progress.update(10);
      progress.update(20);
      progress.update(30);

      // Only first update should go through due to throttling
      expect(process.stdout.write).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });
  });

  describe('getEnvironmentType', () => {
    it('should detect CI environment', () => {
      const originalEnv = process.env;
      process.env.CI = 'true';

      const type = getEnvironmentType();
      expect(type).toBe('ci');

      process.env = originalEnv;
    });

    it('should detect headless environment', () => {
      const { isHeadlessEnvironment } = require('../../../utils/environment.js');
      isHeadlessEnvironment.mockReturnValue(true);

      const type = getEnvironmentType();
      expect(type).toBe('headless');
    });

    it('should detect TUI environment', () => {
      const { isHeadlessEnvironment } = require('../../../utils/environment.js');
      isHeadlessEnvironment.mockReturnValue(false);

      Object.defineProperty(process.stdout, 'isTTY', {
        value: true,
        writable: true
      });

      const originalEnv = process.env;
      delete process.env.TERM;

      const type = getEnvironmentType();
      expect(type).toBe('tui');

      process.env = originalEnv;
    });

    it('should default to CLI environment', () => {
      const { isHeadlessEnvironment } = require('../../../utils/environment.js');
      isHeadlessEnvironment.mockReturnValue(false);

      Object.defineProperty(process.stdout, 'isTTY', {
        value: false,
        writable: true
      });

      const type = getEnvironmentType();
      expect(type).toBe('cli');
    });

    it('should handle dumb terminal', () => {
      const { isHeadlessEnvironment } = require('../../../utils/environment.js');
      isHeadlessEnvironment.mockReturnValue(false);

      Object.defineProperty(process.stdout, 'isTTY', {
        value: true,
        writable: true
      });

      const originalEnv = process.env;
      process.env.TERM = 'dumb';

      const type = getEnvironmentType();
      expect(type).toBe('cli');

      process.env = originalEnv;
    });
  });
});