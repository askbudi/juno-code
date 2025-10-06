/**
 * Input Component for juno-task-ts TUI
 *
 * Enhanced input component built on Ink with support for validation,
 * multiline input, password masking, and real-time feedback.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import chalk from 'chalk';
import type { InputProps, InputValidation, TUITheme } from '../types.js';
import { useTUIContext } from '../apps/TUIApp.js';

/**
 * Enhanced input component with validation and rich features
 */
export const Input: React.FC<InputProps> = ({
  label,
  placeholder = '',
  value,
  onChange,
  onSubmit,
  isPassword = false,
  multiline = false,
  maxLength,
  validate,
  showCount = false,
  disabled = false,
  autoFocus = false,
  testId
}) => {
  const { theme, isHeadless } = useTUIContext();
  const [isFocused, setIsFocused] = useState(autoFocus);
  const [validation, setValidation] = useState<InputValidation>({ isValid: true });
  const [cursorPosition, setCursorPosition] = useState(value.length);

  // Validate input when value changes
  useEffect(() => {
    if (validate) {
      const error = validate(value);
      setValidation({
        isValid: !error,
        error
      });
    }
  }, [value, validate]);

  // Handle keyboard input
  useInput(
    (input, key) => {
      if (disabled) return;

      // Handle special keys
      if (key.return) {
        if (multiline && !key.ctrl) {
          // Add newline in multiline mode
          const newValue = value.slice(0, cursorPosition) + '\n' + value.slice(cursorPosition);
          onChange(newValue);
          setCursorPosition(cursorPosition + 1);
        } else {
          // Submit on Enter (or Ctrl+Enter in multiline)
          if (onSubmit && validation.isValid) {
            onSubmit(value);
          }
        }
        return;
      }

      if (key.backspace || key.delete) {
        if (key.backspace && cursorPosition > 0) {
          // Backspace - remove character before cursor
          const newValue = value.slice(0, cursorPosition - 1) + value.slice(cursorPosition);
          onChange(newValue);
          setCursorPosition(cursorPosition - 1);
        } else if (key.delete && cursorPosition < value.length) {
          // Delete - remove character after cursor
          const newValue = value.slice(0, cursorPosition) + value.slice(cursorPosition + 1);
          onChange(newValue);
        }
        return;
      }

      // Arrow key navigation
      if (key.leftArrow && cursorPosition > 0) {
        setCursorPosition(cursorPosition - 1);
        return;
      }

      if (key.rightArrow && cursorPosition < value.length) {
        setCursorPosition(cursorPosition + 1);
        return;
      }

      if (key.upArrow && multiline) {
        const lines = value.split('\n');
        const currentLineIndex = getCurrentLineIndex(value, cursorPosition);
        if (currentLineIndex > 0) {
          const newPosition = getCursorPositionForLine(value, currentLineIndex - 1, getCursorColumnPosition(value, cursorPosition));
          setCursorPosition(newPosition);
        }
        return;
      }

      if (key.downArrow && multiline) {
        const lines = value.split('\n');
        const currentLineIndex = getCurrentLineIndex(value, cursorPosition);
        if (currentLineIndex < lines.length - 1) {
          const newPosition = getCursorPositionForLine(value, currentLineIndex + 1, getCursorColumnPosition(value, cursorPosition));
          setCursorPosition(newPosition);
        }
        return;
      }

      if (key.home) {
        if (multiline) {
          const lineStart = getLineStartPosition(value, cursorPosition);
          setCursorPosition(lineStart);
        } else {
          setCursorPosition(0);
        }
        return;
      }

      if (key.end) {
        if (multiline) {
          const lineEnd = getLineEndPosition(value, cursorPosition);
          setCursorPosition(lineEnd);
        } else {
          setCursorPosition(value.length);
        }
        return;
      }

      // Handle regular character input
      if (input && (!maxLength || value.length < maxLength)) {
        const newValue = value.slice(0, cursorPosition) + input + value.slice(cursorPosition);
        onChange(newValue);
        setCursorPosition(cursorPosition + input.length);
      }
    },
    { isActive: isFocused && !disabled }
  );

  // Render display value (masked for passwords)
  const displayValue = isPassword ? '*'.repeat(value.length) : value;

  // Render placeholder if empty
  const showPlaceholder = !value && placeholder;

  // Format the display with cursor
  const formatDisplayValue = useCallback(() => {
    if (showPlaceholder) {
      return chalk.hex(theme.muted)(placeholder);
    }

    if (!isFocused) {
      return displayValue;
    }

    // Add cursor indicator when focused
    const beforeCursor = displayValue.slice(0, cursorPosition);
    const atCursor = displayValue[cursorPosition] || ' ';
    const afterCursor = displayValue.slice(cursorPosition + 1);

    return beforeCursor + chalk.inverse(atCursor) + afterCursor;
  }, [displayValue, cursorPosition, isFocused, showPlaceholder, placeholder, theme.muted]);

  // Headless mode fallback
  if (isHeadless) {
    return (
      <Box flexDirection="column">
        {label && (
          <Text>{label}:</Text>
        )}
        <Text>{displayValue || placeholder}</Text>
        {validation.error && (
          <Text color="red">Error: {validation.error}</Text>
        )}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" data-testid={testId}>
      {/* Label */}
      {label && (
        <Box marginBottom={1}>
          <Text color={theme.text}>{label}:</Text>
        </Box>
      )}

      {/* Input field */}
      <Box
        borderStyle="round"
        borderColor={
          disabled
            ? theme.muted
            : validation.isValid
            ? isFocused
              ? theme.primary
              : theme.muted
            : theme.error
        }
        paddingX={1}
        minHeight={multiline ? 3 : 1}
      >
        <Text>{formatDisplayValue()}</Text>
      </Box>

      {/* Error message */}
      {validation.error && (
        <Box marginTop={1}>
          <Text color={theme.error}>⚠ {validation.error}</Text>
        </Box>
      )}

      {/* Character count */}
      {showCount && (
        <Box marginTop={1} justifyContent="flex-end">
          <Text color={theme.muted}>
            {value.length}
            {maxLength && `/${maxLength}`}
          </Text>
        </Box>
      )}

      {/* Help text */}
      {isFocused && !disabled && (
        <Box marginTop={1}>
          <Text color={theme.muted}>
            {multiline ? 'Enter to add line • Ctrl+Enter to submit • ESC to cancel' : 'Enter to submit • ESC to cancel'}
          </Text>
        </Box>
      )}
    </Box>
  );
};

// ============================================================================
// Helper Functions for Cursor Navigation
// ============================================================================

/**
 * Get the current line index for a cursor position
 */
function getCurrentLineIndex(text: string, cursorPosition: number): number {
  const beforeCursor = text.slice(0, cursorPosition);
  return beforeCursor.split('\n').length - 1;
}

/**
 * Get the column position within the current line
 */
function getCursorColumnPosition(text: string, cursorPosition: number): number {
  const beforeCursor = text.slice(0, cursorPosition);
  const lines = beforeCursor.split('\n');
  return lines[lines.length - 1].length;
}

/**
 * Get cursor position for a specific line and column
 */
function getCursorPositionForLine(text: string, lineIndex: number, columnPosition: number): number {
  const lines = text.split('\n');
  if (lineIndex >= lines.length) return text.length;

  let position = 0;
  for (let i = 0; i < lineIndex; i++) {
    position += lines[i].length + 1; // +1 for newline
  }

  const targetLine = lines[lineIndex];
  position += Math.min(columnPosition, targetLine.length);

  return position;
}

/**
 * Get the start position of the line containing the cursor
 */
function getLineStartPosition(text: string, cursorPosition: number): number {
  const beforeCursor = text.slice(0, cursorPosition);
  const lastNewlineIndex = beforeCursor.lastIndexOf('\n');
  return lastNewlineIndex === -1 ? 0 : lastNewlineIndex + 1;
}

/**
 * Get the end position of the line containing the cursor
 */
function getLineEndPosition(text: string, cursorPosition: number): number {
  const afterCursor = text.slice(cursorPosition);
  const nextNewlineIndex = afterCursor.indexOf('\n');
  return nextNewlineIndex === -1 ? text.length : cursorPosition + nextNewlineIndex;
}

// ============================================================================
// Predefined Validation Functions
// ============================================================================

/**
 * Common validation functions for input components
 */
export const Validators = {
  required: (value: string) => (!value.trim() ? 'This field is required' : null),

  minLength: (min: number) => (value: string) =>
    value.length < min ? `Minimum length is ${min} characters` : null,

  maxLength: (max: number) => (value: string) =>
    value.length > max ? `Maximum length is ${max} characters` : null,

  email: (value: string) => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return !emailRegex.test(value) ? 'Please enter a valid email address' : null;
  },

  url: (value: string) => {
    try {
      new URL(value);
      return null;
    } catch {
      return 'Please enter a valid URL';
    }
  },

  noEmpty: (value: string) => (!value || !value.trim() ? 'Value cannot be empty' : null),

  combine: (...validators: Array<(value: string) => string | null>) =>
    (value: string) => {
      for (const validator of validators) {
        const error = validator(value);
        if (error) return error;
      }
      return null;
    }
};

export default Input;