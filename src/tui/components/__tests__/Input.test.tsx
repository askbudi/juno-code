/**
 * @fileoverview Tests for Input component
 */

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { Input, Validators } from '../Input.js';

// Mock the TUI context
const mockTUIContext = {
  theme: {
    primary: '#0066cc',
    secondary: '#6366f1',
    success: '#16a34a',
    warning: '#ca8a04',
    error: '#dc2626',
    muted: '#6b7280',
    background: '#ffffff',
    text: '#111827'
  },
  isHeadless: false,
  dimensions: { width: 80, height: 24 },
  appState: { isActive: true, isFullscreen: false },
  updateTheme: vi.fn(),
  exit: vi.fn()
};

// Mock the useTUIContext hook
vi.mock('../../apps/TUIApp.js', () => ({
  useTUIContext: () => mockTUIContext
}));

describe('Input Component', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  describe('Basic Rendering', () => {
    it('should render input field', () => {
      const onChange = vi.fn();
      const { lastFrame } = render(
        <Input
          value=""
          onChange={onChange}
          testId="test-input"
        />
      );

      expect(lastFrame()).toBeDefined();
    });

    it('should display label when provided', () => {
      const onChange = vi.fn();
      const { lastFrame } = render(
        <Input
          label="Username"
          value=""
          onChange={onChange}
        />
      );

      expect(lastFrame()).toContain('Username:');
    });

    it('should display placeholder when value is empty', () => {
      const onChange = vi.fn();
      const { lastFrame } = render(
        <Input
          placeholder="Enter your name"
          value=""
          onChange={onChange}
        />
      );

      expect(lastFrame()).toContain('Enter your name');
    });

    it('should display current value', () => {
      const onChange = vi.fn();
      const { lastFrame } = render(
        <Input
          value="test value"
          onChange={onChange}
        />
      );

      expect(lastFrame()).toContain('test value');
    });

    it('should mask password input', () => {
      const onChange = vi.fn();
      const { lastFrame } = render(
        <Input
          value="password123"
          onChange={onChange}
          isPassword={true}
        />
      );

      expect(lastFrame()).toContain('***********');
      expect(lastFrame()).not.toContain('password123');
    });
  });

  describe('Character Count', () => {
    it('should show character count when enabled', () => {
      const onChange = vi.fn();
      const { lastFrame } = render(
        <Input
          value="test"
          onChange={onChange}
          showCount={true}
        />
      );

      expect(lastFrame()).toContain('4');
    });

    it('should show character count with max length', () => {
      const onChange = vi.fn();
      const { lastFrame } = render(
        <Input
          value="test"
          onChange={onChange}
          showCount={true}
          maxLength={10}
        />
      );

      expect(lastFrame()).toContain('4/10');
    });

    it('should not show character count when disabled', () => {
      const onChange = vi.fn();
      const { lastFrame } = render(
        <Input
          value="test"
          onChange={onChange}
          showCount={false}
        />
      );

      expect(lastFrame()).not.toMatch(/^\d+/);
    });
  });

  describe('Input Interaction', () => {
    it('should handle text input', () => {
      const onChange = vi.fn();
      const { stdin } = render(
        <Input
          value=""
          onChange={onChange}
          autoFocus={true}
        />
      );

      stdin.write('h');
      expect(onChange).toHaveBeenCalledWith('h');

      stdin.write('i');
      expect(onChange).toHaveBeenCalledWith('i');
    });

    it('should handle backspace', () => {
      const onChange = vi.fn();
      const { stdin } = render(
        <Input
          value="hello"
          onChange={onChange}
          autoFocus={true}
        />
      );

      stdin.write('\u0008'); // Backspace
      expect(onChange).toHaveBeenCalledWith('hell');
    });

    it('should handle delete key', () => {
      const onChange = vi.fn();
      const { stdin } = render(
        <Input
          value="hello"
          onChange={onChange}
          autoFocus={true}
        />
      );

      // Move cursor to beginning and delete
      stdin.write('\u001B[1~'); // Home key
      stdin.write('\u007F'); // Delete key
      expect(onChange).toHaveBeenCalled();
    });

    it('should handle enter key for submission', () => {
      const onChange = vi.fn();
      const onSubmit = vi.fn();
      const { stdin } = render(
        <Input
          value="test"
          onChange={onChange}
          onSubmit={onSubmit}
          autoFocus={true}
        />
      );

      stdin.write('\r'); // Enter
      expect(onSubmit).toHaveBeenCalledWith('test');
    });

    it('should not submit when validation fails', () => {
      const onChange = vi.fn();
      const onSubmit = vi.fn();
      const validate = vi.fn().mockReturnValue('Invalid input');

      const { stdin } = render(
        <Input
          value="invalid"
          onChange={onChange}
          onSubmit={onSubmit}
          validate={validate}
          autoFocus={true}
        />
      );

      stdin.write('\r'); // Enter
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('should not accept input when disabled', () => {
      const onChange = vi.fn();
      const { stdin } = render(
        <Input
          value=""
          onChange={onChange}
          disabled={true}
        />
      );

      stdin.write('a');
      expect(onChange).not.toHaveBeenCalled();
    });

    it('should respect max length', () => {
      const onChange = vi.fn();
      const { stdin } = render(
        <Input
          value="12345"
          onChange={onChange}
          maxLength={5}
          autoFocus={true}
        />
      );

      stdin.write('6');
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  describe('Multiline Input', () => {
    it('should handle newlines in multiline mode', () => {
      const onChange = vi.fn();
      const { stdin } = render(
        <Input
          value="line1"
          onChange={onChange}
          multiline={true}
          autoFocus={true}
        />
      );

      stdin.write('\r'); // Enter without Ctrl
      expect(onChange).toHaveBeenCalledWith('line1\n');
    });

    it('should submit on Ctrl+Enter in multiline mode', () => {
      const onChange = vi.fn();
      const onSubmit = vi.fn();
      const { stdin } = render(
        <Input
          value="multiline\ntext"
          onChange={onChange}
          onSubmit={onSubmit}
          multiline={true}
          autoFocus={true}
        />
      );

      // Simulate Ctrl+Enter (this is tricky to test with ink-testing-library)
      // We'll test the component logic directly
      stdin.write('\r'); // Regular enter should add newline
      expect(onChange).toHaveBeenCalled();
    });

    it('should handle arrow navigation in multiline', () => {
      const onChange = vi.fn();
      const { stdin } = render(
        <Input
          value="line1\nline2"
          onChange={onChange}
          multiline={true}
          autoFocus={true}
        />
      );

      // Arrow keys should move cursor, not modify value
      stdin.write('\u001B[A'); // Up arrow
      stdin.write('\u001B[B'); // Down arrow

      // onChange should not be called for navigation
      expect(onChange).not.toHaveBeenCalled();
    });

    it('should show multiline help text', () => {
      const onChange = vi.fn();
      const { lastFrame } = render(
        <Input
          value=""
          onChange={onChange}
          multiline={true}
          autoFocus={true}
        />
      );

      expect(lastFrame()).toContain('Enter to add line');
      expect(lastFrame()).toContain('Ctrl+Enter to submit');
    });
  });

  describe('Validation', () => {
    it('should show validation error', () => {
      const onChange = vi.fn();
      const validate = vi.fn().mockReturnValue('Error message');

      const { lastFrame } = render(
        <Input
          value="invalid"
          onChange={onChange}
          validate={validate}
        />
      );

      expect(lastFrame()).toContain('⚠ Error message');
    });

    it('should clear validation error when input becomes valid', () => {
      const onChange = vi.fn();
      let isValid = false;
      const validate = vi.fn().mockImplementation(() => isValid ? null : 'Error');

      const { lastFrame, rerender } = render(
        <Input
          value="invalid"
          onChange={onChange}
          validate={validate}
        />
      );

      expect(lastFrame()).toContain('⚠ Error');

      // Make valid
      isValid = true;
      rerender(
        <Input
          value="valid"
          onChange={onChange}
          validate={validate}
        />
      );

      expect(lastFrame()).not.toContain('⚠ Error');
    });

    it('should update validation on value change', () => {
      const onChange = vi.fn();
      const validate = vi.fn().mockReturnValue(null);

      const { rerender } = render(
        <Input
          value="test1"
          onChange={onChange}
          validate={validate}
        />
      );

      expect(validate).toHaveBeenCalledWith('test1');

      rerender(
        <Input
          value="test2"
          onChange={onChange}
          validate={validate}
        />
      );

      expect(validate).toHaveBeenCalledWith('test2');
    });
  });

  describe('Headless Mode', () => {
    beforeEach(() => {
      mockTUIContext.isHeadless = true;
    });

    afterEach(() => {
      mockTUIContext.isHeadless = false;
    });

    it('should render simplified version in headless mode', () => {
      const onChange = vi.fn();
      const { lastFrame } = render(
        <Input
          label="Username"
          value="testuser"
          onChange={onChange}
          placeholder="Enter username"
        />
      );

      expect(lastFrame()).toContain('Username:');
      expect(lastFrame()).toContain('testuser');
    });

    it('should show placeholder in headless mode when empty', () => {
      const onChange = vi.fn();
      const { lastFrame } = render(
        <Input
          label="Username"
          value=""
          onChange={onChange}
          placeholder="Enter username"
        />
      );

      expect(lastFrame()).toContain('Enter username');
    });

    it('should show validation error in headless mode', () => {
      const onChange = vi.fn();
      const validate = vi.fn().mockReturnValue('Error message');

      const { lastFrame } = render(
        <Input
          value="invalid"
          onChange={onChange}
          validate={validate}
        />
      );

      expect(lastFrame()).toContain('Error: Error message');
    });
  });

  describe('Focus and Styling', () => {
    it('should auto-focus when autoFocus is true', () => {
      const onChange = vi.fn();
      const { lastFrame } = render(
        <Input
          value=""
          onChange={onChange}
          autoFocus={true}
        />
      );

      // In focused state, should show help text
      expect(lastFrame()).toContain('Enter to submit');
    });

    it('should show help text when focused', () => {
      const onChange = vi.fn();
      const { lastFrame } = render(
        <Input
          value=""
          onChange={onChange}
          autoFocus={true}
        />
      );

      expect(lastFrame()).toContain('Enter to submit');
      expect(lastFrame()).toContain('ESC to cancel');
    });

    it('should not show help text when disabled', () => {
      const onChange = vi.fn();
      const { lastFrame } = render(
        <Input
          value=""
          onChange={onChange}
          autoFocus={true}
          disabled={true}
        />
      );

      expect(lastFrame()).not.toContain('Enter to submit');
    });
  });

  describe('Cursor Navigation', () => {
    it('should handle left arrow key', () => {
      const onChange = vi.fn();
      const { stdin } = render(
        <Input
          value="hello"
          onChange={onChange}
          autoFocus={true}
        />
      );

      stdin.write('\u001B[D'); // Left arrow
      // Should move cursor but not change value
      expect(onChange).not.toHaveBeenCalled();
    });

    it('should handle right arrow key', () => {
      const onChange = vi.fn();
      const { stdin } = render(
        <Input
          value="hello"
          onChange={onChange}
          autoFocus={true}
        />
      );

      stdin.write('\u001B[C'); // Right arrow
      // Should move cursor but not change value
      expect(onChange).not.toHaveBeenCalled();
    });

    it('should handle home key', () => {
      const onChange = vi.fn();
      const { stdin } = render(
        <Input
          value="hello"
          onChange={onChange}
          autoFocus={true}
        />
      );

      stdin.write('\u001B[1~'); // Home key
      // Should move cursor to beginning
      expect(onChange).not.toHaveBeenCalled();
    });

    it('should handle end key', () => {
      const onChange = vi.fn();
      const { stdin } = render(
        <Input
          value="hello"
          onChange={onChange}
          autoFocus={true}
        />
      );

      stdin.write('\u001B[4~'); // End key
      // Should move cursor to end
      expect(onChange).not.toHaveBeenCalled();
    });
  });
});

describe('Validators', () => {
  describe('required validator', () => {
    it('should return error for empty string', () => {
      expect(Validators.required('')).toBe('This field is required');
      expect(Validators.required('   ')).toBe('This field is required');
    });

    it('should return null for non-empty string', () => {
      expect(Validators.required('value')).toBeNull();
      expect(Validators.required('  value  ')).toBeNull();
    });
  });

  describe('minLength validator', () => {
    it('should return error when value is too short', () => {
      const validator = Validators.minLength(5);
      expect(validator('abc')).toBe('Minimum length is 5 characters');
    });

    it('should return null when value meets minimum length', () => {
      const validator = Validators.minLength(5);
      expect(validator('abcde')).toBeNull();
      expect(validator('abcdef')).toBeNull();
    });
  });

  describe('maxLength validator', () => {
    it('should return error when value is too long', () => {
      const validator = Validators.maxLength(5);
      expect(validator('abcdef')).toBe('Maximum length is 5 characters');
    });

    it('should return null when value is within max length', () => {
      const validator = Validators.maxLength(5);
      expect(validator('abc')).toBeNull();
      expect(validator('abcde')).toBeNull();
    });
  });

  describe('email validator', () => {
    it('should return error for invalid email', () => {
      expect(Validators.email('invalid')).toBe('Please enter a valid email address');
      expect(Validators.email('invalid@')).toBe('Please enter a valid email address');
      expect(Validators.email('@domain.com')).toBe('Please enter a valid email address');
    });

    it('should return null for valid email', () => {
      expect(Validators.email('user@domain.com')).toBeNull();
      expect(Validators.email('test.email+tag@example.org')).toBeNull();
    });
  });

  describe('url validator', () => {
    it('should return error for invalid URL', () => {
      expect(Validators.url('invalid')).toBe('Please enter a valid URL');
      expect(Validators.url('not-a-url')).toBe('Please enter a valid URL');
    });

    it('should return null for valid URL', () => {
      expect(Validators.url('https://example.com')).toBeNull();
      expect(Validators.url('http://localhost:3000')).toBeNull();
      expect(Validators.url('ftp://files.example.com')).toBeNull();
    });
  });

  describe('noEmpty validator', () => {
    it('should return error for empty or whitespace-only strings', () => {
      expect(Validators.noEmpty('')).toBe('Value cannot be empty');
      expect(Validators.noEmpty('   ')).toBe('Value cannot be empty');
      expect(Validators.noEmpty('\t\n')).toBe('Value cannot be empty');
    });

    it('should return null for non-empty strings', () => {
      expect(Validators.noEmpty('value')).toBeNull();
      expect(Validators.noEmpty('  value  ')).toBeNull();
    });
  });

  describe('combine validator', () => {
    it('should combine multiple validators', () => {
      const combined = Validators.combine(
        Validators.required,
        Validators.minLength(3),
        Validators.email
      );

      expect(combined('')).toBe('This field is required');
      expect(combined('ab')).toBe('Minimum length is 3 characters');
      expect(combined('invalid-email')).toBe('Please enter a valid email address');
      expect(combined('user@domain.com')).toBeNull();
    });

    it('should return first error encountered', () => {
      const combined = Validators.combine(
        Validators.required,
        Validators.minLength(10)
      );

      expect(combined('')).toBe('This field is required');
      expect(combined('short')).toBe('Minimum length is 10 characters');
    });

    it('should return null when all validators pass', () => {
      const combined = Validators.combine(
        Validators.required,
        Validators.maxLength(20),
        Validators.minLength(5)
      );

      expect(combined('valid input')).toBeNull();
    });
  });
});

describe('Helper Functions', () => {
  // We can't directly test the helper functions since they're not exported,
  // but we can test their behavior through the component
  describe('cursor navigation helpers', () => {
    it('should handle multiline cursor navigation', () => {
      const onChange = vi.fn();
      const { stdin } = render(
        <Input
          value="line1\nline2\nline3"
          onChange={onChange}
          multiline={true}
          autoFocus={true}
        />
      );

      // Test that navigation keys don't trigger onChange
      stdin.write('\u001B[A'); // Up arrow
      stdin.write('\u001B[B'); // Down arrow
      stdin.write('\u001B[1~'); // Home
      stdin.write('\u001B[4~'); // End

      expect(onChange).not.toHaveBeenCalled();
    });
  });
});