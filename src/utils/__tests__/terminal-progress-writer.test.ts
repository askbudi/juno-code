/**
 * Tests for Terminal Progress Writer Utility
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TerminalProgressWriter, getTerminalProgressWriter, resetTerminalProgressWriter, writeTerminalProgress, writeTerminalProgressWithPrefix } from '../terminal-progress-writer.js';
import { Writable } from 'node:stream';

describe('TerminalProgressWriter', () => {
  let mockStream: Writable & { isTTY?: boolean };
  let writtenData: string[];

  beforeEach(() => {
    writtenData = [];
    mockStream = new Writable({
      write(chunk: any, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
        writtenData.push(chunk.toString());
        callback();
        return true;
      }
    }) as Writable & { isTTY?: boolean };
  });

  afterEach(() => {
    resetTerminalProgressWriter();
  });

  describe('Non-TTY Mode', () => {
    it('should write simple string without ANSI codes in non-TTY mode', () => {
      mockStream.isTTY = false;
      const writer = new TerminalProgressWriter({ terminalAware: false, stream: mockStream });

      writer.write('Test message');

      // Stream writes message and newline separately
      const fullOutput = writtenData.join('');
      expect(fullOutput).toBe('Test message\n');
      expect(fullOutput).not.toContain('\r');
      expect(fullOutput).not.toContain('\x1b[K');
    });

    it('should not add extra newline if message already has one', () => {
      mockStream.isTTY = false;
      const writer = new TerminalProgressWriter({ terminalAware: false, stream: mockStream });

      writer.write('Test message\n');

      const fullOutput = writtenData.join('');
      expect(fullOutput).toBe('Test message\n');
    });

    it('should use console.error for objects in non-TTY mode', () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockStream.isTTY = false;
      const writer = new TerminalProgressWriter({ terminalAware: false, stream: mockStream });

      const testObj = { progress: 1, message: 'test' };
      writer.write(testObj);

      expect(consoleErrorSpy).toHaveBeenCalledWith(testObj);
      consoleErrorSpy.mockRestore();
    });
  });

  describe('TTY Mode (Terminal-Aware)', () => {
    it('should write string with ANSI codes in TTY mode', () => {
      mockStream.isTTY = true;
      const writer = new TerminalProgressWriter({ terminalAware: true, stream: mockStream });

      writer.write('Test message');

      expect(writtenData.length).toBeGreaterThan(0);
      // Should start with \r\x1b[K to clear the line
      expect(writtenData[0]).toBe('\r\x1b[K');
      // Should contain the message
      expect(writtenData.join('')).toContain('Test message');
    });

    it('should clear line before writing in TTY mode', () => {
      mockStream.isTTY = true;
      const writer = new TerminalProgressWriter({ terminalAware: true, stream: mockStream });

      writer.write('Progress update');

      // First write should be the line clear sequence
      expect(writtenData[0]).toBe('\r\x1b[K');
    });

    it('should use console.error for objects in TTY mode', () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockStream.isTTY = true;
      const writer = new TerminalProgressWriter({ terminalAware: true, stream: mockStream });

      const testObj = { progress: 2, message: 'test progress' };
      writer.write(testObj);

      // Should clear line first
      expect(writtenData[0]).toBe('\r\x1b[K');
      // Should call console.error with the object
      expect(consoleErrorSpy).toHaveBeenCalledWith(testObj);
      consoleErrorSpy.mockRestore();
    });

    it('should handle writeWithPrefix correctly in TTY mode', () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockStream.isTTY = true;
      const writer = new TerminalProgressWriter({ terminalAware: true, stream: mockStream });

      writer.writeWithPrefix('[MCP]', 'Progress event');

      // Should clear line first
      expect(writtenData[0]).toBe('\r\x1b[K');
      // Should call console.error with prefix and message
      expect(consoleErrorSpy).toHaveBeenCalledWith('[MCP]', 'Progress event');
      consoleErrorSpy.mockRestore();
    });
  });

  describe('Global Singleton', () => {
    it('should return same instance from getTerminalProgressWriter', () => {
      const writer1 = getTerminalProgressWriter();
      const writer2 = getTerminalProgressWriter();

      expect(writer1).toBe(writer2);
    });

    it('should reset global instance with resetTerminalProgressWriter', () => {
      const writer1 = getTerminalProgressWriter();
      resetTerminalProgressWriter();
      const writer2 = getTerminalProgressWriter();

      expect(writer1).not.toBe(writer2);
    });

    it('should write using global function writeTerminalProgress', () => {
      const stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      writeTerminalProgress('Test message');

      // Should have been called to write the message
      expect(stderrWriteSpy).toHaveBeenCalled();
      stderrWriteSpy.mockRestore();
    });

    it('should write with prefix using global function', () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      writeTerminalProgressWithPrefix('[TEST]', 'Test message');

      // Should have been called with prefix and message
      expect(consoleErrorSpy).toHaveBeenCalledWith('[TEST]', 'Test message');
      consoleErrorSpy.mockRestore();
    });
  });

  describe('Terminal Awareness Detection', () => {
    it('should auto-detect TTY mode based on stderr', () => {
      const originalIsTTY = process.stderr.isTTY;

      // Test with TTY
      Object.defineProperty(process.stderr, 'isTTY', { value: true, writable: true, configurable: true });
      let writer = new TerminalProgressWriter();
      expect(writer.isTerminalAware()).toBe(true);

      // Test without TTY
      Object.defineProperty(process.stderr, 'isTTY', { value: false, writable: true, configurable: true });
      resetTerminalProgressWriter();
      writer = new TerminalProgressWriter();
      expect(writer.isTerminalAware()).toBe(false);

      // Restore original value
      Object.defineProperty(process.stderr, 'isTTY', { value: originalIsTTY, writable: true, configurable: true });
    });

    it('should allow manual override of terminal awareness', () => {
      const writer = new TerminalProgressWriter({ terminalAware: true });
      expect(writer.isTerminalAware()).toBe(true);

      const writer2 = new TerminalProgressWriter({ terminalAware: false });
      expect(writer2.isTerminalAware()).toBe(false);
    });
  });
});
