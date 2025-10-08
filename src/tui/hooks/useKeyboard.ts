/**
 * Keyboard Hook for juno-task-ts TUI
 *
 * Custom hook for managing keyboard input, key bindings, and shortcuts
 * across TUI components with proper cleanup and context handling.
 */

import { useEffect, useCallback, useRef } from 'react';
import { useInput } from 'ink';
import type { KeyBinding, KeyboardEvent } from '../types.js';

/**
 * Enhanced keyboard management hook
 */
export function useKeyboard(options: {
  /** Whether keyboard input is active */
  isActive?: boolean;
  /** Key bindings to register */
  bindings?: KeyBinding[];
  /** Global key handler */
  onKey?: (event: KeyboardEvent) => boolean | void;
  /** Whether to prevent default behavior */
  preventDefault?: boolean;
}) {
  const {
    isActive = true,
    bindings = [],
    onKey,
    preventDefault = false
  } = options;

  const bindingsRef = useRef(bindings);
  const onKeyRef = useRef(onKey);

  // Update refs when props change
  useEffect(() => {
    bindingsRef.current = bindings;
    onKeyRef.current = onKey;
  }, [bindings, onKey]);

  // Main keyboard handler
  useInput(
    (input, key) => {
      const keyName = key.return ? 'return' :
                      key.escape ? 'escape' :
                      key.tab ? 'tab' :
                      key.backspace ? 'backspace' :
                      key.delete ? 'delete' :
                      key.upArrow ? 'upArrow' :
                      key.downArrow ? 'downArrow' :
                      key.leftArrow ? 'leftArrow' :
                      key.rightArrow ? 'rightArrow' :
                      key.pageUp ? 'pageUp' :
                      key.pageDown ? 'pageDown' :
                      key.home ? 'home' :
                      key.end ? 'end' :
                      input || 'unknown';

      const keyEvent: KeyboardEvent = {
        key: keyName,
        ctrl: key.ctrl || false,
        meta: key.meta || false,
        shift: key.shift || false,
        alt: key.alt || false,
        sequence: `${key.ctrl ? 'ctrl+' : ''}${key.meta ? 'meta+' : ''}${key.shift ? 'shift+' : ''}${key.alt ? 'alt+' : ''}${input || keyName}`
      };

      // Try key bindings first
      for (const binding of bindingsRef.current) {
        if (matchesKeyBinding(keyEvent, binding)) {
          const result = binding.handler(keyEvent);
          if (result !== false && preventDefault) {
            return; // Prevent further processing
          }
        }
      }

      // Call global key handler
      if (onKeyRef.current) {
        const result = onKeyRef.current(keyEvent);
        if (result === false) {
          return; // Handler explicitly prevented default
        }
      }
    },
    { isActive }
  );

  // Register a new key binding
  const registerBinding = useCallback((binding: KeyBinding) => {
    bindingsRef.current = [...bindingsRef.current, binding];
  }, []);

  // Unregister a key binding
  const unregisterBinding = useCallback((key: string) => {
    bindingsRef.current = bindingsRef.current.filter(b => b.key !== key);
  }, []);

  // Clear all bindings
  const clearBindings = useCallback(() => {
    bindingsRef.current = [];
  }, []);

  return {
    registerBinding,
    unregisterBinding,
    clearBindings
  };
}

/**
 * Hook for managing global keyboard shortcuts
 */
export function useGlobalShortcuts(shortcuts: Record<string, () => void>) {
  const bindings: KeyBinding[] = Object.entries(shortcuts).map(([key, handler]) => ({
    key,
    handler: () => {
      handler();
      return false; // Prevent further processing
    },
    global: true
  }));

  useKeyboard({ bindings });
}

/**
 * Hook for navigation keyboard shortcuts
 */
export function useNavigationKeys(options: {
  onUp?: () => void;
  onDown?: () => void;
  onLeft?: () => void;
  onRight?: () => void;
  onHome?: () => void;
  onEnd?: () => void;
  onPageUp?: () => void;
  onPageDown?: () => void;
  onEnter?: () => void;
  onEscape?: () => void;
  isActive?: boolean;
}) {
  const {
    onUp,
    onDown,
    onLeft,
    onRight,
    onHome,
    onEnd,
    onPageUp,
    onPageDown,
    onEnter,
    onEscape,
    isActive = true
  } = options;

  const bindings: KeyBinding[] = [
    onUp && { key: 'upArrow', handler: onUp },
    onDown && { key: 'downArrow', handler: onDown },
    onLeft && { key: 'leftArrow', handler: onLeft },
    onRight && { key: 'rightArrow', handler: onRight },
    onHome && { key: 'home', handler: onHome },
    onEnd && { key: 'end', handler: onEnd },
    onPageUp && { key: 'pageUp', handler: onPageUp },
    onPageDown && { key: 'pageDown', handler: onPageDown },
    onEnter && { key: 'return', handler: onEnter },
    onEscape && { key: 'escape', handler: onEscape }
  ].filter(Boolean) as KeyBinding[];

  useKeyboard({ bindings, isActive });
}

/**
 * Hook for text editing keyboard shortcuts
 */
export function useTextEditingKeys(options: {
  onCopy?: () => void;
  onPaste?: () => void;
  onCut?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  onSelectAll?: () => void;
  isActive?: boolean;
}) {
  const {
    onCopy,
    onPaste,
    onCut,
    onUndo,
    onRedo,
    onSelectAll,
    isActive = true
  } = options;

  const bindings: KeyBinding[] = [
    onCopy && { key: 'ctrl+c', handler: onCopy },
    onPaste && { key: 'ctrl+v', handler: onPaste },
    onCut && { key: 'ctrl+x', handler: onCut },
    onUndo && { key: 'ctrl+z', handler: onUndo },
    onRedo && { key: 'ctrl+y', handler: onRedo },
    onSelectAll && { key: 'ctrl+a', handler: onSelectAll }
  ].filter(Boolean) as KeyBinding[];

  useKeyboard({ bindings, isActive });
}

/**
 * Hook for form keyboard shortcuts
 */
export function useFormKeys(options: {
  onSubmit?: () => void;
  onCancel?: () => void;
  onNext?: () => void;
  onPrevious?: () => void;
  isActive?: boolean;
}) {
  const {
    onSubmit,
    onCancel,
    onNext,
    onPrevious,
    isActive = true
  } = options;

  const bindings: KeyBinding[] = [
    onSubmit && { key: 'return', handler: onSubmit },
    onSubmit && { key: 'ctrl+return', handler: onSubmit },
    onCancel && { key: 'escape', handler: onCancel },
    onNext && { key: 'tab', handler: onNext },
    onPrevious && { key: 'shift+tab', handler: onPrevious }
  ].filter(Boolean) as KeyBinding[];

  useKeyboard({ bindings, isActive });
}

/**
 * Hook for application-level keyboard shortcuts
 */
export function useAppShortcuts(options: {
  onQuit?: () => void;
  onHelp?: () => void;
  onRefresh?: () => void;
  onSettings?: () => void;
  onFullscreen?: () => void;
  isActive?: boolean;
}) {
  const {
    onQuit,
    onHelp,
    onRefresh,
    onSettings,
    onFullscreen,
    isActive = true
  } = options;

  const bindings: KeyBinding[] = [
    onQuit && { key: 'ctrl+q', handler: onQuit },
    onQuit && { key: 'ctrl+c', handler: onQuit },
    onHelp && { key: 'f1', handler: onHelp },
    onHelp && { key: 'ctrl+h', handler: onHelp },
    onRefresh && { key: 'f5', handler: onRefresh },
    onRefresh && { key: 'ctrl+r', handler: onRefresh },
    onSettings && { key: 'ctrl+comma', handler: onSettings },
    onFullscreen && { key: 'f11', handler: onFullscreen }
  ].filter(Boolean) as KeyBinding[];

  useKeyboard({ bindings, isActive });
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check if a keyboard event matches a key binding
 */
function matchesKeyBinding(event: KeyboardEvent, binding: KeyBinding): boolean {
  const bindingParts = binding.key.toLowerCase().split('+');
  const keyPart = bindingParts[bindingParts.length - 1];
  const modifiers = bindingParts.slice(0, -1);

  // Check main key
  if (event.key.toLowerCase() !== keyPart) {
    return false;
  }

  // Check modifiers
  const hasCtrl = modifiers.includes('ctrl');
  const hasMeta = modifiers.includes('meta') || modifiers.includes('cmd');
  const hasShift = modifiers.includes('shift');
  const hasAlt = modifiers.includes('alt');

  return (
    event.ctrl === hasCtrl &&
    event.meta === hasMeta &&
    event.shift === hasShift &&
    event.alt === hasAlt
  );
}

/**
 * Create a key sequence string from a keyboard event
 */
export function createKeySequence(event: KeyboardEvent): string {
  const parts: string[] = [];

  if (event.ctrl) parts.push('ctrl');
  if (event.meta) parts.push('meta');
  if (event.shift) parts.push('shift');
  if (event.alt) parts.push('alt');
  parts.push(event.key);

  return parts.join('+');
}

/**
 * Parse a key binding string into components
 */
export function parseKeyBinding(binding: string): {
  key: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
} {
  const parts = binding.toLowerCase().split('+');
  const key = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1);

  return {
    key,
    ctrl: modifiers.includes('ctrl'),
    meta: modifiers.includes('meta') || modifiers.includes('cmd'),
    shift: modifiers.includes('shift'),
    alt: modifiers.includes('alt')
  };
}