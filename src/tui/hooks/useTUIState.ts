/**
 * TUI State Management Hook for juno-task-ts
 *
 * Custom hooks for managing TUI component state, form state, and
 * application-level state with persistence and validation.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { InputValidation } from '../types.js';

/**
 * Enhanced state hook with persistence and validation
 */
export function useTUIState<T>(
  initialValue: T,
  options: {
    /** Validation function */
    validate?: (value: T) => string | null;
    /** Persistence key for localStorage */
    persistKey?: string;
    /** Debounce delay for validation */
    debounceMs?: number;
    /** Callback when value changes */
    onChange?: (value: T) => void;
    /** Callback when validation state changes */
    onValidationChange?: (validation: InputValidation) => void;
  } = {}
) {
  const {
    validate,
    persistKey,
    debounceMs = 300,
    onChange,
    onValidationChange
  } = options;

  // Load initial value from persistence if available
  const getInitialValue = (): T => {
    if (persistKey && typeof localStorage !== 'undefined') {
      try {
        const stored = localStorage.getItem(persistKey);
        if (stored) {
          return JSON.parse(stored);
        }
      } catch {
        // Ignore persistence errors
      }
    }
    return initialValue;
  };

  const [value, setValue] = useState<T>(getInitialValue);
  const [validation, setValidation] = useState<InputValidation>({ isValid: true });
  const [isDirty, setIsDirty] = useState(false);
  const debounceRef = useRef<NodeJS.Timeout>();

  // Validate value
  const validateValue = useCallback((val: T) => {
    if (!validate) {
      setValidation({ isValid: true });
      return;
    }

    const error = validate(val);
    const newValidation = {
      isValid: !error,
      error
    };

    setValidation(newValidation);
    onValidationChange?.(newValidation);
  }, [validate, onValidationChange]);

  // Debounced validation
  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    debounceRef.current = setTimeout(() => {
      validateValue(value);
    }, debounceMs);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [value, validateValue, debounceMs]);

  // Persist value changes
  useEffect(() => {
    if (persistKey && typeof localStorage !== 'undefined' && isDirty) {
      try {
        localStorage.setItem(persistKey, JSON.stringify(value));
      } catch {
        // Ignore persistence errors
      }
    }
  }, [value, persistKey, isDirty]);

  // Call onChange callback
  useEffect(() => {
    if (isDirty) {
      onChange?.(value);
    }
  }, [value, onChange, isDirty]);

  const updateValue = useCallback((newValue: T | ((prev: T) => T)) => {
    setValue(prev => {
      const updated = typeof newValue === 'function' ? (newValue as (prev: T) => T)(prev) : newValue;
      setIsDirty(true);
      return updated;
    });
  }, []);

  const reset = useCallback(() => {
    setValue(initialValue);
    setIsDirty(false);
    setValidation({ isValid: true });
  }, [initialValue]);

  const clearPersistence = useCallback(() => {
    if (persistKey && typeof localStorage !== 'undefined') {
      try {
        localStorage.removeItem(persistKey);
      } catch {
        // Ignore persistence errors
      }
    }
  }, [persistKey]);

  return {
    value,
    setValue: updateValue,
    validation,
    isDirty,
    reset,
    clearPersistence,
    isValid: validation.isValid
  };
}

/**
 * Form state management hook
 */
export function useFormState<T extends Record<string, any>>(
  initialValues: T,
  options: {
    /** Field validation rules */
    validationRules?: Partial<Record<keyof T, (value: any) => string | null>>;
    /** Form-level validation */
    validateForm?: (values: T) => Record<string, string> | null;
    /** Persistence key */
    persistKey?: string;
    /** Callback when form values change */
    onChange?: (values: T) => void;
    /** Callback when form is submitted */
    onSubmit?: (values: T) => void | Promise<void>;
  } = {}
) {
  const {
    validationRules = {},
    validateForm,
    persistKey,
    onChange,
    onSubmit
  } = options;

  const [values, setValues] = useState<T>(initialValues);
  const [errors, setErrors] = useState<Partial<Record<keyof T, string>>>({});
  const [touched, setTouched] = useState<Partial<Record<keyof T, boolean>>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDirty, setIsDirty] = useState(false);

  // Validate individual field
  const validateField = useCallback((name: keyof T, value: any) => {
    const validator = validationRules[name];
    if (!validator) return null;

    return validator(value);
  }, [validationRules]);

  // Validate entire form
  const validateAllFields = useCallback(() => {
    const newErrors: Partial<Record<keyof T, string>> = {};

    // Validate individual fields
    Object.keys(values).forEach(key => {
      const fieldKey = key as keyof T;
      const error = validateField(fieldKey, values[fieldKey]);
      if (error) {
        newErrors[fieldKey] = error;
      }
    });

    // Validate form as a whole
    if (validateForm) {
      const formErrors = validateForm(values);
      if (formErrors) {
        Object.assign(newErrors, formErrors);
      }
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }, [values, validateField, validateForm]);

  // Update field value
  const setFieldValue = useCallback((name: keyof T, value: any) => {
    setValues(prev => {
      const updated = { ...prev, [name]: value };
      setIsDirty(true);
      onChange?.(updated);
      return updated;
    });

    // Validate field if it has been touched
    if (touched[name]) {
      const error = validateField(name, value);
      setErrors(prev => ({
        ...prev,
        [name]: error || undefined
      }));
    }
  }, [touched, validateField, onChange]);

  // Mark field as touched
  const setFieldTouched = useCallback((name: keyof T, isTouched: boolean = true) => {
    setTouched(prev => ({ ...prev, [name]: isTouched }));

    // Validate field when touched
    if (isTouched) {
      const error = validateField(name, values[name]);
      setErrors(prev => ({
        ...prev,
        [name]: error || undefined
      }));
    }
  }, [values, validateField]);

  // Get field props (value, error, touched status)
  const getFieldProps = useCallback((name: keyof T) => ({
    value: values[name],
    error: errors[name],
    touched: touched[name] || false,
    onChange: (value: any) => setFieldValue(name, value),
    onBlur: () => setFieldTouched(name, true)
  }), [values, errors, touched, setFieldValue, setFieldTouched]);

  // Handle form submission
  const handleSubmit = useCallback(async () => {
    // Mark all fields as touched
    const allFields = Object.keys(values) as Array<keyof T>;
    const touchedState: Partial<Record<keyof T, boolean>> = {};
    allFields.forEach(field => {
      touchedState[field] = true;
    });
    setTouched(touchedState);

    // Validate form
    const isValid = validateAllFields();
    if (!isValid) {
      return false;
    }

    // Submit form
    if (onSubmit) {
      setIsSubmitting(true);
      try {
        await onSubmit(values);
        return true;
      } catch (error) {
        console.error('Form submission error:', error);
        return false;
      } finally {
        setIsSubmitting(false);
      }
    }

    return true;
  }, [values, validateAllFields, onSubmit]);

  // Reset form
  const reset = useCallback(() => {
    setValues(initialValues);
    setErrors({});
    setTouched({});
    setIsDirty(false);
    setIsSubmitting(false);
  }, [initialValues]);

  // Check if form is valid
  const isValid = Object.keys(errors).length === 0;

  return {
    values,
    errors,
    touched,
    isSubmitting,
    isDirty,
    isValid,
    setFieldValue,
    setFieldTouched,
    getFieldProps,
    handleSubmit,
    reset,
    validateAllFields
  };
}

/**
 * List state management hook (for managing arrays/lists)
 */
export function useListState<T>(
  initialItems: T[] = [],
  options: {
    /** Unique key extractor */
    keyExtractor?: (item: T, index: number) => string | number;
    /** Maximum number of items */
    maxItems?: number;
    /** Callback when items change */
    onChange?: (items: T[]) => void;
  } = {}
) {
  const { keyExtractor, maxItems, onChange } = options;

  const [items, setItems] = useState<T[]>(initialItems);
  const [selectedIndexes, setSelectedIndexes] = useState<Set<number>>(new Set());

  // Add item
  const addItem = useCallback((item: T, index?: number) => {
    setItems(prev => {
      const newItems = [...prev];
      const targetIndex = index ?? newItems.length;

      // Check max items limit
      if (maxItems && newItems.length >= maxItems) {
        return prev; // Don't add if at limit
      }

      newItems.splice(targetIndex, 0, item);
      onChange?.(newItems);
      return newItems;
    });
  }, [maxItems, onChange]);

  // Remove item
  const removeItem = useCallback((index: number) => {
    setItems(prev => {
      const newItems = prev.filter((_, i) => i !== index);
      onChange?.(newItems);
      return newItems;
    });

    // Update selected indexes
    setSelectedIndexes(prev => {
      const newSelected = new Set<number>();
      prev.forEach(selectedIndex => {
        if (selectedIndex < index) {
          newSelected.add(selectedIndex);
        } else if (selectedIndex > index) {
          newSelected.add(selectedIndex - 1);
        }
      });
      return newSelected;
    });
  }, [onChange]);

  // Update item
  const updateItem = useCallback((index: number, updater: T | ((prev: T) => T)) => {
    setItems(prev => {
      const newItems = [...prev];
      newItems[index] = typeof updater === 'function'
        ? (updater as (prev: T) => T)(newItems[index])
        : updater;
      onChange?.(newItems);
      return newItems;
    });
  }, [onChange]);

  // Move item
  const moveItem = useCallback((fromIndex: number, toIndex: number) => {
    setItems(prev => {
      const newItems = [...prev];
      const [movedItem] = newItems.splice(fromIndex, 1);
      newItems.splice(toIndex, 0, movedItem);
      onChange?.(newItems);
      return newItems;
    });
  }, [onChange]);

  // Clear all items
  const clearItems = useCallback(() => {
    setItems([]);
    setSelectedIndexes(new Set());
    onChange?.([]);
  }, [onChange]);

  // Selection management
  const selectItem = useCallback((index: number) => {
    setSelectedIndexes(prev => new Set([...prev, index]));
  }, []);

  const deselectItem = useCallback((index: number) => {
    setSelectedIndexes(prev => {
      const newSelected = new Set(prev);
      newSelected.delete(index);
      return newSelected;
    });
  }, []);

  const toggleSelection = useCallback((index: number) => {
    setSelectedIndexes(prev => {
      const newSelected = new Set(prev);
      if (newSelected.has(index)) {
        newSelected.delete(index);
      } else {
        newSelected.add(index);
      }
      return newSelected;
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedIndexes(new Set());
  }, []);

  const selectAll = useCallback(() => {
    setSelectedIndexes(new Set(items.map((_, index) => index)));
  }, [items]);

  // Get selected items
  const selectedItems = items.filter((_, index) => selectedIndexes.has(index));

  return {
    items,
    selectedIndexes: Array.from(selectedIndexes),
    selectedItems,
    addItem,
    removeItem,
    updateItem,
    moveItem,
    clearItems,
    selectItem,
    deselectItem,
    toggleSelection,
    clearSelection,
    selectAll,
    isEmpty: items.length === 0,
    count: items.length,
    isAtMaxCapacity: maxItems ? items.length >= maxItems : false
  };
}

export default useTUIState;