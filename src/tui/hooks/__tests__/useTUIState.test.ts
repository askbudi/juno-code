/**
 * @fileoverview Tests for useTUIState hooks
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useTUIState,
  useFormState,
  useListState
} from '../useTUIState.js';

// Mock localStorage
const localStorageMock = {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn()
};

Object.defineProperty(window, 'localStorage', {
  value: localStorageMock
});

describe('useTUIState Hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Basic Functionality', () => {
    it('should initialize with initial value', () => {
      const { result } = renderHook(() =>
        useTUIState('initial value')
      );

      expect(result.current.value).toBe('initial value');
      expect(result.current.isDirty).toBe(false);
      expect(result.current.isValid).toBe(true);
    });

    it('should update value and mark as dirty', () => {
      const { result } = renderHook(() =>
        useTUIState('initial')
      );

      act(() => {
        result.current.setValue('updated');
      });

      expect(result.current.value).toBe('updated');
      expect(result.current.isDirty).toBe(true);
    });

    it('should support functional updates', () => {
      const { result } = renderHook(() =>
        useTUIState(5)
      );

      act(() => {
        result.current.setValue(prev => prev + 3);
      });

      expect(result.current.value).toBe(8);
      expect(result.current.isDirty).toBe(true);
    });

    it('should reset to initial value', () => {
      const { result } = renderHook(() =>
        useTUIState('initial')
      );

      act(() => {
        result.current.setValue('changed');
      });

      expect(result.current.isDirty).toBe(true);

      act(() => {
        result.current.reset();
      });

      expect(result.current.value).toBe('initial');
      expect(result.current.isDirty).toBe(false);
      expect(result.current.isValid).toBe(true);
    });
  });

  describe('Validation', () => {
    it('should validate value with custom validator', () => {
      const validate = vi.fn().mockReturnValue(null);

      const { result } = renderHook(() =>
        useTUIState('test', { validate })
      );

      act(() => {
        vi.advanceTimersByTime(300); // Trigger debounced validation
      });

      expect(validate).toHaveBeenCalledWith('test');
      expect(result.current.isValid).toBe(true);
    });

    it('should handle validation errors', () => {
      const validate = vi.fn().mockReturnValue('Invalid value');

      const { result } = renderHook(() =>
        useTUIState('test', { validate })
      );

      act(() => {
        vi.advanceTimersByTime(300);
      });

      expect(result.current.isValid).toBe(false);
      expect(result.current.validation.error).toBe('Invalid value');
    });

    it('should debounce validation', () => {
      const validate = vi.fn().mockReturnValue(null);

      const { result } = renderHook(() =>
        useTUIState('initial', { validate, debounceMs: 500 })
      );

      act(() => {
        result.current.setValue('changed1');
      });

      act(() => {
        vi.advanceTimersByTime(200); // Less than debounce time
      });

      expect(validate).not.toHaveBeenCalledWith('changed1');

      act(() => {
        result.current.setValue('changed2');
      });

      act(() => {
        vi.advanceTimersByTime(500); // Full debounce time
      });

      expect(validate).toHaveBeenCalledWith('changed2');
      expect(validate).toHaveBeenCalledTimes(2); // Initial + final
    });

    it('should call onValidationChange callback', () => {
      const onValidationChange = vi.fn();
      const validate = vi.fn().mockReturnValue('Error');

      renderHook(() =>
        useTUIState('test', { validate, onValidationChange })
      );

      act(() => {
        vi.advanceTimersByTime(300);
      });

      expect(onValidationChange).toHaveBeenCalledWith({
        isValid: false,
        error: 'Error'
      });
    });
  });

  describe('Persistence', () => {
    it('should load initial value from localStorage', () => {
      localStorageMock.getItem.mockReturnValue(JSON.stringify('stored value'));

      const { result } = renderHook(() =>
        useTUIState('default', { persistKey: 'test-key' })
      );

      expect(localStorageMock.getItem).toHaveBeenCalledWith('test-key');
      expect(result.current.value).toBe('stored value');
    });

    it('should save value to localStorage when dirty', () => {
      const { result } = renderHook(() =>
        useTUIState('initial', { persistKey: 'test-key' })
      );

      act(() => {
        result.current.setValue('new value');
      });

      expect(localStorageMock.setItem).toHaveBeenCalledWith(
        'test-key',
        JSON.stringify('new value')
      );
    });

    it('should handle localStorage errors gracefully', () => {
      localStorageMock.getItem.mockImplementation(() => {
        throw new Error('Storage error');
      });

      const { result } = renderHook(() =>
        useTUIState('default', { persistKey: 'test-key' })
      );

      expect(result.current.value).toBe('default');
    });

    it('should clear persistence', () => {
      const { result } = renderHook(() =>
        useTUIState('test', { persistKey: 'test-key' })
      );

      act(() => {
        result.current.clearPersistence();
      });

      expect(localStorageMock.removeItem).toHaveBeenCalledWith('test-key');
    });
  });

  describe('Callbacks', () => {
    it('should call onChange when value changes', () => {
      const onChange = vi.fn();

      const { result } = renderHook(() =>
        useTUIState('initial', { onChange })
      );

      act(() => {
        result.current.setValue('changed');
      });

      expect(onChange).toHaveBeenCalledWith('changed');
    });

    it('should not call onChange for initial value', () => {
      const onChange = vi.fn();

      renderHook(() =>
        useTUIState('initial', { onChange })
      );

      expect(onChange).not.toHaveBeenCalled();
    });
  });
});

describe('useFormState Hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Basic Functionality', () => {
    it('should initialize with initial values', () => {
      const initialValues = { name: '', email: '' };

      const { result } = renderHook(() =>
        useFormState(initialValues)
      );

      expect(result.current.values).toEqual(initialValues);
      expect(result.current.isDirty).toBe(false);
      expect(result.current.isValid).toBe(true);
    });

    it('should update field values', () => {
      const { result } = renderHook(() =>
        useFormState({ name: '', email: '' })
      );

      act(() => {
        result.current.setFieldValue('name', 'John');
      });

      expect(result.current.values.name).toBe('John');
      expect(result.current.isDirty).toBe(true);
    });

    it('should mark fields as touched', () => {
      const { result } = renderHook(() =>
        useFormState({ name: '' })
      );

      expect(result.current.touched.name).toBe(false);

      act(() => {
        result.current.setFieldTouched('name', true);
      });

      expect(result.current.touched.name).toBe(true);
    });

    it('should reset form state', () => {
      const initialValues = { name: 'Initial' };

      const { result } = renderHook(() =>
        useFormState(initialValues)
      );

      act(() => {
        result.current.setFieldValue('name', 'Changed');
        result.current.setFieldTouched('name', true);
      });

      act(() => {
        result.current.reset();
      });

      expect(result.current.values).toEqual(initialValues);
      expect(result.current.isDirty).toBe(false);
      expect(result.current.touched.name).toBe(false);
    });
  });

  describe('Field Validation', () => {
    it('should validate individual fields', () => {
      const validationRules = {
        email: (value: string) => {
          if (!value.includes('@')) return 'Invalid email';
          return null;
        }
      };

      const { result } = renderHook(() =>
        useFormState({ email: '' }, { validationRules })
      );

      act(() => {
        result.current.setFieldTouched('email', true);
        result.current.setFieldValue('email', 'invalid');
      });

      expect(result.current.errors.email).toBe('Invalid email');
      expect(result.current.isValid).toBe(false);
    });

    it('should validate on field touch', () => {
      const validationRules = {
        name: (value: string) => value ? null : 'Name is required'
      };

      const { result } = renderHook(() =>
        useFormState({ name: '' }, { validationRules })
      );

      act(() => {
        result.current.setFieldTouched('name', true);
      });

      expect(result.current.errors.name).toBe('Name is required');
    });

    it('should clear errors when field becomes valid', () => {
      const validationRules = {
        name: (value: string) => value ? null : 'Required'
      };

      const { result } = renderHook(() =>
        useFormState({ name: '' }, { validationRules })
      );

      act(() => {
        result.current.setFieldTouched('name', true);
      });

      expect(result.current.errors.name).toBe('Required');

      act(() => {
        result.current.setFieldValue('name', 'Valid');
      });

      expect(result.current.errors.name).toBeUndefined();
    });
  });

  describe('Form Validation', () => {
    it('should validate entire form', () => {
      const validateForm = vi.fn().mockReturnValue(null);

      const { result } = renderHook(() =>
        useFormState({ name: 'Test' }, { validateForm })
      );

      act(() => {
        result.current.validateAllFields();
      });

      expect(validateForm).toHaveBeenCalledWith({ name: 'Test' });
    });

    it('should handle form-level validation errors', () => {
      const validateForm = vi.fn().mockReturnValue({ form: 'Form error' });

      const { result } = renderHook(() =>
        useFormState({ name: '' }, { validateForm })
      );

      act(() => {
        const isValid = result.current.validateAllFields();
        expect(isValid).toBe(false);
      });

      expect(result.current.errors.form).toBe('Form error');
    });
  });

  describe('Form Submission', () => {
    it('should handle successful form submission', async () => {
      const onSubmit = vi.fn().mockResolvedValue(undefined);

      const { result } = renderHook(() =>
        useFormState({ name: 'Valid' }, { onSubmit })
      );

      let submitResult;
      await act(async () => {
        submitResult = await result.current.handleSubmit();
      });

      expect(submitResult).toBe(true);
      expect(onSubmit).toHaveBeenCalledWith({ name: 'Valid' });
    });

    it('should prevent submission if form is invalid', async () => {
      const onSubmit = vi.fn();
      const validationRules = {
        name: (value: string) => value ? null : 'Required'
      };

      const { result } = renderHook(() =>
        useFormState({ name: '' }, { validationRules, onSubmit })
      );

      let submitResult;
      await act(async () => {
        submitResult = await result.current.handleSubmit();
      });

      expect(submitResult).toBe(false);
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('should handle submission errors', async () => {
      const onSubmit = vi.fn().mockRejectedValue(new Error('Submission failed'));
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { result } = renderHook(() =>
        useFormState({ name: 'Valid' }, { onSubmit })
      );

      let submitResult;
      await act(async () => {
        submitResult = await result.current.handleSubmit();
      });

      expect(submitResult).toBe(false);
      expect(consoleSpy).toHaveBeenCalledWith('Form submission error:', expect.any(Error));

      consoleSpy.mockRestore();
    });

    it('should set isSubmitting during submission', async () => {
      let resolveSubmit: () => void;
      const onSubmit = vi.fn().mockImplementation(() =>
        new Promise(resolve => { resolveSubmit = resolve; })
      );

      const { result } = renderHook(() =>
        useFormState({ name: 'Valid' }, { onSubmit })
      );

      act(() => {
        result.current.handleSubmit();
      });

      expect(result.current.isSubmitting).toBe(true);

      await act(async () => {
        resolveSubmit!();
      });

      expect(result.current.isSubmitting).toBe(false);
    });
  });

  describe('Field Props Helper', () => {
    it('should return field props object', () => {
      const { result } = renderHook(() =>
        useFormState({ name: 'test' })
      );

      const fieldProps = result.current.getFieldProps('name');

      expect(fieldProps).toEqual({
        value: 'test',
        error: undefined,
        touched: false,
        onChange: expect.any(Function),
        onBlur: expect.any(Function)
      });
    });

    it('should update field through props', () => {
      const { result } = renderHook(() =>
        useFormState({ name: '' })
      );

      const fieldProps = result.current.getFieldProps('name');

      act(() => {
        fieldProps.onChange('new value');
      });

      expect(result.current.values.name).toBe('new value');

      act(() => {
        fieldProps.onBlur();
      });

      expect(result.current.touched.name).toBe(true);
    });
  });

  describe('Callbacks', () => {
    it('should call onChange when values change', () => {
      const onChange = vi.fn();

      const { result } = renderHook(() =>
        useFormState({ name: '' }, { onChange })
      );

      act(() => {
        result.current.setFieldValue('name', 'changed');
      });

      expect(onChange).toHaveBeenCalledWith({ name: 'changed' });
    });
  });
});

describe('useListState Hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Basic Functionality', () => {
    it('should initialize with empty list', () => {
      const { result } = renderHook(() =>
        useListState<string>()
      );

      expect(result.current.items).toEqual([]);
      expect(result.current.isEmpty).toBe(true);
      expect(result.current.count).toBe(0);
    });

    it('should initialize with initial items', () => {
      const initialItems = ['item1', 'item2'];

      const { result } = renderHook(() =>
        useListState(initialItems)
      );

      expect(result.current.items).toEqual(initialItems);
      expect(result.current.count).toBe(2);
      expect(result.current.isEmpty).toBe(false);
    });

    it('should add items', () => {
      const { result } = renderHook(() =>
        useListState<string>([])
      );

      act(() => {
        result.current.addItem('new item');
      });

      expect(result.current.items).toEqual(['new item']);
      expect(result.current.count).toBe(1);
    });

    it('should add items at specific index', () => {
      const { result } = renderHook(() =>
        useListState(['a', 'c'])
      );

      act(() => {
        result.current.addItem('b', 1);
      });

      expect(result.current.items).toEqual(['a', 'b', 'c']);
    });

    it('should remove items', () => {
      const { result } = renderHook(() =>
        useListState(['a', 'b', 'c'])
      );

      act(() => {
        result.current.removeItem(1);
      });

      expect(result.current.items).toEqual(['a', 'c']);
    });

    it('should update items', () => {
      const { result } = renderHook(() =>
        useListState(['a', 'b', 'c'])
      );

      act(() => {
        result.current.updateItem(1, 'updated');
      });

      expect(result.current.items).toEqual(['a', 'updated', 'c']);
    });

    it('should update items with function', () => {
      const { result } = renderHook(() =>
        useListState([1, 2, 3])
      );

      act(() => {
        result.current.updateItem(1, prev => prev * 2);
      });

      expect(result.current.items).toEqual([1, 4, 3]);
    });

    it('should move items', () => {
      const { result } = renderHook(() =>
        useListState(['a', 'b', 'c'])
      );

      act(() => {
        result.current.moveItem(0, 2);
      });

      expect(result.current.items).toEqual(['b', 'c', 'a']);
    });

    it('should clear all items', () => {
      const { result } = renderHook(() =>
        useListState(['a', 'b', 'c'])
      );

      act(() => {
        result.current.clearItems();
      });

      expect(result.current.items).toEqual([]);
      expect(result.current.isEmpty).toBe(true);
    });
  });

  describe('Max Items Limit', () => {
    it('should respect max items limit', () => {
      const { result } = renderHook(() =>
        useListState(['a', 'b'], { maxItems: 2 })
      );

      expect(result.current.isAtMaxCapacity).toBe(true);

      act(() => {
        result.current.addItem('c');
      });

      expect(result.current.items).toEqual(['a', 'b']); // Should not add
    });

    it('should allow adding when under limit', () => {
      const { result } = renderHook(() =>
        useListState(['a'], { maxItems: 3 })
      );

      expect(result.current.isAtMaxCapacity).toBe(false);

      act(() => {
        result.current.addItem('b');
      });

      expect(result.current.items).toEqual(['a', 'b']);
    });
  });

  describe('Selection Management', () => {
    it('should select items', () => {
      const { result } = renderHook(() =>
        useListState(['a', 'b', 'c'])
      );

      act(() => {
        result.current.selectItem(1);
      });

      expect(result.current.selectedIndexes).toEqual([1]);
      expect(result.current.selectedItems).toEqual(['b']);
    });

    it('should deselect items', () => {
      const { result } = renderHook(() =>
        useListState(['a', 'b', 'c'])
      );

      act(() => {
        result.current.selectItem(1);
        result.current.selectItem(2);
      });

      act(() => {
        result.current.deselectItem(1);
      });

      expect(result.current.selectedIndexes).toEqual([2]);
      expect(result.current.selectedItems).toEqual(['c']);
    });

    it('should toggle selection', () => {
      const { result } = renderHook(() =>
        useListState(['a', 'b', 'c'])
      );

      act(() => {
        result.current.toggleSelection(1);
      });

      expect(result.current.selectedIndexes).toEqual([1]);

      act(() => {
        result.current.toggleSelection(1);
      });

      expect(result.current.selectedIndexes).toEqual([]);
    });

    it('should select all items', () => {
      const { result } = renderHook(() =>
        useListState(['a', 'b', 'c'])
      );

      act(() => {
        result.current.selectAll();
      });

      expect(result.current.selectedIndexes).toEqual([0, 1, 2]);
      expect(result.current.selectedItems).toEqual(['a', 'b', 'c']);
    });

    it('should clear selection', () => {
      const { result } = renderHook(() =>
        useListState(['a', 'b', 'c'])
      );

      act(() => {
        result.current.selectAll();
      });

      act(() => {
        result.current.clearSelection();
      });

      expect(result.current.selectedIndexes).toEqual([]);
      expect(result.current.selectedItems).toEqual([]);
    });

    it('should update selection when items are removed', () => {
      const { result } = renderHook(() =>
        useListState(['a', 'b', 'c', 'd'])
      );

      act(() => {
        result.current.selectItem(1); // 'b'
        result.current.selectItem(3); // 'd'
      });

      act(() => {
        result.current.removeItem(1); // Remove 'b'
      });

      // Selection should be updated: index 3 becomes 2
      expect(result.current.selectedIndexes).toEqual([2]);
      expect(result.current.selectedItems).toEqual(['d']);
    });
  });

  describe('Callbacks', () => {
    it('should call onChange when items change', () => {
      const onChange = vi.fn();

      const { result } = renderHook(() =>
        useListState<string>([], { onChange })
      );

      act(() => {
        result.current.addItem('new item');
      });

      expect(onChange).toHaveBeenCalledWith(['new item']);
    });

    it('should call onChange for all operations', () => {
      const onChange = vi.fn();

      const { result } = renderHook(() =>
        useListState(['a', 'b'], { onChange })
      );

      act(() => {
        result.current.updateItem(0, 'updated');
      });

      act(() => {
        result.current.removeItem(1);
      });

      act(() => {
        result.current.clearItems();
      });

      expect(onChange).toHaveBeenCalledTimes(3);
    });
  });

  describe('Edge Cases', () => {
    it('should handle removing non-existent items gracefully', () => {
      const { result } = renderHook(() =>
        useListState(['a'])
      );

      act(() => {
        result.current.removeItem(5); // Index out of bounds
      });

      expect(result.current.items).toEqual(['a']); // Should remain unchanged
    });

    it('should handle updating non-existent items', () => {
      const { result } = renderHook(() =>
        useListState(['a'])
      );

      act(() => {
        result.current.updateItem(5, 'updated'); // Index out of bounds
      });

      // Should not crash, but exact behavior depends on implementation
      expect(result.current.items).toBeDefined();
    });
  });
});