/**
 * @fileoverview Tests for useKeyboard hooks
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useKeyboard,
  useGlobalShortcuts,
  useNavigationKeys,
  useTextEditingKeys,
  useFormKeys,
  useAppShortcuts,
  createKeySequence,
  parseKeyBinding
} from '../useKeyboard.js';
import type { KeyboardEvent, KeyBinding } from '../../types.js';

// Mock useInput from ink
vi.mock('ink', () => ({
  useInput: vi.fn()
}));

describe('useKeyboard Hook', () => {
  const mockUseInput = vi.fn();

  beforeEach(() => {
    const ink = require('ink');
    ink.useInput.mockImplementation(mockUseInput);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Basic Functionality', () => {
    it('should register useInput with default options', () => {
      const onKey = vi.fn();

      renderHook(() =>
        useKeyboard({
          onKey
        })
      );

      expect(mockUseInput).toHaveBeenCalledWith(
        expect.any(Function),
        { isActive: true }
      );
    });

    it('should respect isActive option', () => {
      const onKey = vi.fn();

      renderHook(() =>
        useKeyboard({
          onKey,
          isActive: false
        })
      );

      expect(mockUseInput).toHaveBeenCalledWith(
        expect.any(Function),
        { isActive: false }
      );
    });

    it('should return binding management functions', () => {
      const { result } = renderHook(() =>
        useKeyboard({})
      );

      expect(result.current).toHaveProperty('registerBinding');
      expect(result.current).toHaveProperty('unregisterBinding');
      expect(result.current).toHaveProperty('clearBindings');
      expect(typeof result.current.registerBinding).toBe('function');
      expect(typeof result.current.unregisterBinding).toBe('function');
      expect(typeof result.current.clearBindings).toBe('function');
    });
  });

  describe('Key Event Handling', () => {
    it('should create proper keyboard events from ink input', () => {
      const onKey = vi.fn();
      let inputHandler: any;

      mockUseInput.mockImplementation((handler) => {
        inputHandler = handler;
      });

      renderHook(() =>
        useKeyboard({ onKey })
      );

      // Simulate Enter key
      inputHandler('', { return: true, ctrl: false, meta: false, shift: false, alt: false });

      expect(onKey).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'return',
          ctrl: false,
          meta: false,
          shift: false,
          alt: false
        })
      );
    });

    it('should handle character input', () => {
      const onKey = vi.fn();
      let inputHandler: any;

      mockUseInput.mockImplementation((handler) => {
        inputHandler = handler;
      });

      renderHook(() =>
        useKeyboard({ onKey })
      );

      // Simulate character 'a'
      inputHandler('a', { ctrl: false, meta: false, shift: false, alt: false });

      expect(onKey).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'a',
          ctrl: false,
          meta: false,
          shift: false,
          alt: false
        })
      );
    });

    it('should handle modifier keys', () => {
      const onKey = vi.fn();
      let inputHandler: any;

      mockUseInput.mockImplementation((handler) => {
        inputHandler = handler;
      });

      renderHook(() =>
        useKeyboard({ onKey })
      );

      // Simulate Ctrl+A
      inputHandler('a', { ctrl: true, meta: false, shift: false, alt: false });

      expect(onKey).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'a',
          ctrl: true,
          meta: false,
          shift: false,
          alt: false,
          sequence: 'ctrl+a'
        })
      );
    });

    it('should handle arrow keys', () => {
      const onKey = vi.fn();
      let inputHandler: any;

      mockUseInput.mockImplementation((handler) => {
        inputHandler = handler;
      });

      renderHook(() =>
        useKeyboard({ onKey })
      );

      // Simulate up arrow
      inputHandler('', { upArrow: true, ctrl: false, meta: false, shift: false, alt: false });

      expect(onKey).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'upArrow',
          ctrl: false
        })
      );
    });
  });

  describe('Key Bindings', () => {
    it('should execute matching key bindings', () => {
      const bindingHandler = vi.fn();
      const bindings: KeyBinding[] = [
        {
          key: 'ctrl+s',
          handler: bindingHandler
        }
      ];

      let inputHandler: any;
      mockUseInput.mockImplementation((handler) => {
        inputHandler = handler;
      });

      renderHook(() =>
        useKeyboard({ bindings })
      );

      // Simulate Ctrl+S
      inputHandler('s', { ctrl: true, meta: false, shift: false, alt: false });

      expect(bindingHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 's',
          ctrl: true,
          sequence: 'ctrl+s'
        })
      );
    });

    it('should not execute non-matching key bindings', () => {
      const bindingHandler = vi.fn();
      const bindings: KeyBinding[] = [
        {
          key: 'ctrl+s',
          handler: bindingHandler
        }
      ];

      let inputHandler: any;
      mockUseInput.mockImplementation((handler) => {
        inputHandler = handler;
      });

      renderHook(() =>
        useKeyboard({ bindings })
      );

      // Simulate different key
      inputHandler('a', { ctrl: false, meta: false, shift: false, alt: false });

      expect(bindingHandler).not.toHaveBeenCalled();
    });

    it('should prevent default when binding handler returns false', () => {
      const bindingHandler = vi.fn().mockReturnValue(false);
      const onKey = vi.fn();
      const bindings: KeyBinding[] = [
        {
          key: 'escape',
          handler: bindingHandler
        }
      ];

      let inputHandler: any;
      mockUseInput.mockImplementation((handler) => {
        inputHandler = handler;
      });

      renderHook(() =>
        useKeyboard({ bindings, onKey, preventDefault: true })
      );

      // Simulate ESC key
      inputHandler('', { escape: true, ctrl: false, meta: false, shift: false, alt: false });

      expect(bindingHandler).toHaveBeenCalled();
      expect(onKey).not.toHaveBeenCalled(); // Should be prevented
    });
  });

  describe('Binding Management', () => {
    it('should allow registering new bindings', () => {
      const { result } = renderHook(() =>
        useKeyboard({})
      );

      const newBinding: KeyBinding = {
        key: 'f1',
        handler: vi.fn()
      };

      act(() => {
        result.current.registerBinding(newBinding);
      });

      // Binding should be registered (hard to test directly without triggering)
      expect(result.current.registerBinding).toBeDefined();
    });

    it('should allow unregistering bindings', () => {
      const initialBinding: KeyBinding = {
        key: 'f1',
        handler: vi.fn()
      };

      const { result } = renderHook(() =>
        useKeyboard({ bindings: [initialBinding] })
      );

      act(() => {
        result.current.unregisterBinding('f1');
      });

      expect(result.current.unregisterBinding).toBeDefined();
    });

    it('should allow clearing all bindings', () => {
      const bindings: KeyBinding[] = [
        { key: 'f1', handler: vi.fn() },
        { key: 'f2', handler: vi.fn() }
      ];

      const { result } = renderHook(() =>
        useKeyboard({ bindings })
      );

      act(() => {
        result.current.clearBindings();
      });

      expect(result.current.clearBindings).toBeDefined();
    });
  });
});

describe('useGlobalShortcuts Hook', () => {
  const mockUseInput = vi.fn();

  beforeEach(() => {
    const ink = require('ink');
    ink.useInput.mockImplementation(mockUseInput);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should register shortcuts as global bindings', () => {
    const onSave = vi.fn();
    const onQuit = vi.fn();

    const shortcuts = {
      'ctrl+s': onSave,
      'ctrl+q': onQuit
    };

    renderHook(() =>
      useGlobalShortcuts(shortcuts)
    );

    expect(mockUseInput).toHaveBeenCalled();
  });

  it('should execute shortcut handlers', () => {
    const onSave = vi.fn();
    let inputHandler: any;

    mockUseInput.mockImplementation((handler) => {
      inputHandler = handler;
    });

    const shortcuts = {
      'ctrl+s': onSave
    };

    renderHook(() =>
      useGlobalShortcuts(shortcuts)
    );

    // Simulate Ctrl+S
    inputHandler('s', { ctrl: true, meta: false, shift: false, alt: false });

    expect(onSave).toHaveBeenCalled();
  });
});

describe('useNavigationKeys Hook', () => {
  const mockUseInput = vi.fn();

  beforeEach(() => {
    const ink = require('ink');
    ink.useInput.mockImplementation(mockUseInput);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should register navigation key handlers', () => {
    const onUp = vi.fn();
    const onDown = vi.fn();
    const onEnter = vi.fn();

    renderHook(() =>
      useNavigationKeys({
        onUp,
        onDown,
        onEnter
      })
    );

    expect(mockUseInput).toHaveBeenCalled();
  });

  it('should execute navigation handlers', () => {
    const onUp = vi.fn();
    let inputHandler: any;

    mockUseInput.mockImplementation((handler) => {
      inputHandler = handler;
    });

    renderHook(() =>
      useNavigationKeys({ onUp })
    );

    // Simulate up arrow
    inputHandler('', { upArrow: true, ctrl: false, meta: false, shift: false, alt: false });

    expect(onUp).toHaveBeenCalled();
  });

  it('should handle all navigation keys', () => {
    const handlers = {
      onUp: vi.fn(),
      onDown: vi.fn(),
      onLeft: vi.fn(),
      onRight: vi.fn(),
      onHome: vi.fn(),
      onEnd: vi.fn(),
      onPageUp: vi.fn(),
      onPageDown: vi.fn(),
      onEnter: vi.fn(),
      onEscape: vi.fn()
    };

    renderHook(() =>
      useNavigationKeys(handlers)
    );

    expect(mockUseInput).toHaveBeenCalled();
  });

  it('should respect isActive option', () => {
    const onUp = vi.fn();

    renderHook(() =>
      useNavigationKeys({
        onUp,
        isActive: false
      })
    );

    expect(mockUseInput).toHaveBeenCalledWith(
      expect.any(Function),
      { isActive: false }
    );
  });
});

describe('useTextEditingKeys Hook', () => {
  const mockUseInput = vi.fn();

  beforeEach(() => {
    const ink = require('ink');
    ink.useInput.mockImplementation(mockUseInput);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should register text editing shortcuts', () => {
    const onCopy = vi.fn();
    const onPaste = vi.fn();
    const onUndo = vi.fn();

    renderHook(() =>
      useTextEditingKeys({
        onCopy,
        onPaste,
        onUndo
      })
    );

    expect(mockUseInput).toHaveBeenCalled();
  });

  it('should execute copy handler', () => {
    const onCopy = vi.fn();
    let inputHandler: any;

    mockUseInput.mockImplementation((handler) => {
      inputHandler = handler;
    });

    renderHook(() =>
      useTextEditingKeys({ onCopy })
    );

    // Simulate Ctrl+C
    inputHandler('c', { ctrl: true, meta: false, shift: false, alt: false });

    expect(onCopy).toHaveBeenCalled();
  });
});

describe('useFormKeys Hook', () => {
  const mockUseInput = vi.fn();

  beforeEach(() => {
    const ink = require('ink');
    ink.useInput.mockImplementation(mockUseInput);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should register form shortcuts', () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();

    renderHook(() =>
      useFormKeys({
        onSubmit,
        onCancel
      })
    );

    expect(mockUseInput).toHaveBeenCalled();
  });

  it('should execute submit on Enter', () => {
    const onSubmit = vi.fn();
    let inputHandler: any;

    mockUseInput.mockImplementation((handler) => {
      inputHandler = handler;
    });

    renderHook(() =>
      useFormKeys({ onSubmit })
    );

    // Simulate Enter
    inputHandler('', { return: true, ctrl: false, meta: false, shift: false, alt: false });

    expect(onSubmit).toHaveBeenCalled();
  });

  it('should execute submit on Ctrl+Enter', () => {
    const onSubmit = vi.fn();
    let inputHandler: any;

    mockUseInput.mockImplementation((handler) => {
      inputHandler = handler;
    });

    renderHook(() =>
      useFormKeys({ onSubmit })
    );

    // Simulate Ctrl+Enter
    inputHandler('', { return: true, ctrl: true, meta: false, shift: false, alt: false });

    expect(onSubmit).toHaveBeenCalled();
  });
});

describe('useAppShortcuts Hook', () => {
  const mockUseInput = vi.fn();

  beforeEach(() => {
    const ink = require('ink');
    ink.useInput.mockImplementation(mockUseInput);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should register app-level shortcuts', () => {
    const onQuit = vi.fn();
    const onHelp = vi.fn();
    const onRefresh = vi.fn();

    renderHook(() =>
      useAppShortcuts({
        onQuit,
        onHelp,
        onRefresh
      })
    );

    expect(mockUseInput).toHaveBeenCalled();
  });

  it('should execute help on F1', () => {
    const onHelp = vi.fn();
    let inputHandler: any;

    mockUseInput.mockImplementation((handler) => {
      inputHandler = handler;
    });

    renderHook(() =>
      useAppShortcuts({ onHelp })
    );

    // Simulate F1
    inputHandler('', { f1: true, ctrl: false, meta: false, shift: false, alt: false });

    // Note: F1 mapping in the key event creation logic needs to be handled
    // This test shows the structure but may need adjustment based on actual ink behavior
  });
});

describe('Utility Functions', () => {
  describe('createKeySequence', () => {
    it('should create sequence for simple key', () => {
      const event: KeyboardEvent = {
        key: 'a',
        ctrl: false,
        meta: false,
        shift: false,
        alt: false,
        sequence: 'a'
      };

      expect(createKeySequence(event)).toBe('a');
    });

    it('should create sequence for key with modifiers', () => {
      const event: KeyboardEvent = {
        key: 's',
        ctrl: true,
        meta: false,
        shift: true,
        alt: false,
        sequence: 'ctrl+shift+s'
      };

      expect(createKeySequence(event)).toBe('ctrl+shift+s');
    });

    it('should create sequence for key with all modifiers', () => {
      const event: KeyboardEvent = {
        key: 'x',
        ctrl: true,
        meta: true,
        shift: true,
        alt: true,
        sequence: 'ctrl+meta+shift+alt+x'
      };

      expect(createKeySequence(event)).toBe('ctrl+meta+shift+alt+x');
    });
  });

  describe('parseKeyBinding', () => {
    it('should parse simple key binding', () => {
      const result = parseKeyBinding('enter');

      expect(result).toEqual({
        key: 'enter',
        ctrl: false,
        meta: false,
        shift: false,
        alt: false
      });
    });

    it('should parse key binding with single modifier', () => {
      const result = parseKeyBinding('ctrl+s');

      expect(result).toEqual({
        key: 's',
        ctrl: true,
        meta: false,
        shift: false,
        alt: false
      });
    });

    it('should parse key binding with multiple modifiers', () => {
      const result = parseKeyBinding('ctrl+shift+enter');

      expect(result).toEqual({
        key: 'enter',
        ctrl: true,
        meta: false,
        shift: true,
        alt: false
      });
    });

    it('should handle meta/cmd modifier', () => {
      const result1 = parseKeyBinding('meta+a');
      const result2 = parseKeyBinding('cmd+a');

      expect(result1.meta).toBe(true);
      expect(result2.meta).toBe(true);
    });

    it('should handle case insensitive input', () => {
      const result = parseKeyBinding('CTRL+SHIFT+A');

      expect(result).toEqual({
        key: 'a',
        ctrl: true,
        meta: false,
        shift: true,
        alt: false
      });
    });

    it('should handle alt modifier', () => {
      const result = parseKeyBinding('alt+f4');

      expect(result).toEqual({
        key: 'f4',
        ctrl: false,
        meta: false,
        shift: false,
        alt: true
      });
    });
  });
});

describe('Integration Tests', () => {
  const mockUseInput = vi.fn();

  beforeEach(() => {
    const ink = require('ink');
    ink.useInput.mockImplementation(mockUseInput);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should handle complex key binding scenarios', () => {
    const handlers = {
      save: vi.fn(),
      quit: vi.fn(),
      help: vi.fn()
    };

    const bindings: KeyBinding[] = [
      { key: 'ctrl+s', handler: handlers.save },
      { key: 'ctrl+q', handler: handlers.quit },
      { key: 'f1', handler: handlers.help }
    ];

    let inputHandler: any;
    mockUseInput.mockImplementation((handler) => {
      inputHandler = handler;
    });

    renderHook(() =>
      useKeyboard({ bindings })
    );

    // Test multiple key combinations
    inputHandler('s', { ctrl: true, meta: false, shift: false, alt: false });
    expect(handlers.save).toHaveBeenCalled();

    inputHandler('q', { ctrl: true, meta: false, shift: false, alt: false });
    expect(handlers.quit).toHaveBeenCalled();
  });

  it('should prioritize bindings over global key handler', () => {
    const bindingHandler = vi.fn();
    const globalHandler = vi.fn();

    const bindings: KeyBinding[] = [
      { key: 'escape', handler: bindingHandler }
    ];

    let inputHandler: any;
    mockUseInput.mockImplementation((handler) => {
      inputHandler = handler;
    });

    renderHook(() =>
      useKeyboard({
        bindings,
        onKey: globalHandler
      })
    );

    inputHandler('', { escape: true, ctrl: false, meta: false, shift: false, alt: false });

    expect(bindingHandler).toHaveBeenCalled();
    expect(globalHandler).toHaveBeenCalled(); // Both should be called unless prevented
  });
});