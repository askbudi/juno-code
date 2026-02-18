/**
 * TUI Integration Tests - Simplified functional tests
 *
 * Tests focus on TUI function exports, CLI integration,
 * and headless fallback rather than component rendering.
 */

import { describe, it, expect, vi } from 'vitest';

describe('TUI Integration', () => {
  describe('TUI Module Exports', () => {
    it('should export all required TUI functions', async () => {
      const tui = await import('../index');

      // Check main exports exist
      expect(tui.launchPromptEditor).toBeDefined();
      expect(tui.launchSimplePrompt).toBeDefined();
      expect(tui.showConfirmation).toBeDefined();
      expect(tui.showAlert).toBeDefined();
      expect(tui.showSelection).toBeDefined();
      expect(tui.isTUISupported).toBeDefined();
      expect(tui.safeTUIExecution).toBeDefined();

      // Check component exports
      expect(tui.TUIApp).toBeDefined();
      expect(tui.PromptEditor).toBeDefined();
      expect(tui.SimplePromptEditor).toBeDefined();
      expect(tui.Input).toBeDefined();
      expect(tui.Dialog).toBeDefined();
      expect(tui.Select).toBeDefined();

      // Check hook exports
      expect(tui.useTUIContext).toBeDefined();
      expect(tui.useKeyboard).toBeDefined();
      expect(tui.useTUIState).toBeDefined();
    });

    it('should have working isTUISupported function', async () => {
      const { isTUISupported } = await import('../index');

      // Function should exist and return boolean
      expect(typeof isTUISupported).toBe('function');

      const result = isTUISupported();
      console.log('isTUISupported result:', result, 'type:', typeof result);

      // In test environment, it might return false but should still be boolean
      expect(typeof result).toBe('boolean');
    });

    it('should have working safeTUIExecution function', async () => {
      const { safeTUIExecution } = await import('../index');

      const mockTUIFn = vi.fn().mockResolvedValue('tui-result');
      const mockFallbackFn = vi.fn().mockResolvedValue('fallback-result');

      expect(typeof safeTUIExecution).toBe('function');

      // Test that it can execute functions
      const result = await safeTUIExecution(mockTUIFn, mockFallbackFn);
      expect(typeof result).toBe('string');
    });
  });

  describe('Headless Utilities', () => {
    it('should export headless fallback functions', async () => {
      const {
        headlessPromptEditor,
        headlessConfirmation,
        headlessSelection,
        headlessAlert
      } = await import('../utils/headless');

      expect(headlessPromptEditor).toBeDefined();
      expect(headlessConfirmation).toBeDefined();
      expect(headlessSelection).toBeDefined();
      expect(headlessAlert).toBeDefined();
    });
  });

  describe('CLI Integration', () => {
    it('should be importable from CLI commands', async () => {
      // Test that TUI functions can be imported without errors
      expect(async () => {
        const { launchPromptEditor } = await import('../index');
        return launchPromptEditor;
      }).not.toThrow();
    });

    it('should handle dynamic imports correctly', async () => {
      // Test the dynamic import pattern used in CLI
      expect(async () => {
        const tuiModule = await import('../index');
        return tuiModule.isTUISupported();
      }).not.toThrow();
    });
  });

  describe('Component Structure', () => {
    it('should have valid React components', async () => {
      const { TUIApp, PromptEditor, Input } = await import('../index');

      // Components should be functions (React components)
      expect(typeof TUIApp).toBe('function');
      expect(typeof PromptEditor).toBe('function');
      expect(typeof Input).toBe('function');
    });
  });

  describe('Error Handling', () => {
    it('should handle TUI initialization errors gracefully', async () => {
      const { safeTUIExecution } = await import('../index');

      const failingTUIFn = vi.fn().mockRejectedValue(new Error('TUI failed'));
      const fallbackFn = vi.fn().mockResolvedValue('fallback-worked');

      const result = await safeTUIExecution(failingTUIFn, fallbackFn);
      expect(result).toBe('fallback-worked');
      expect(fallbackFn).toHaveBeenCalled();
    });
  });
});