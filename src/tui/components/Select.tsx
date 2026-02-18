/**
 * Select Component for juno-task-ts TUI
 *
 * Interactive selection component with support for single/multiple selection,
 * search filtering, grouping, and keyboard navigation.
 */

import React, { useState, useEffect, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import chalk from 'chalk';
import type { SelectProps, SelectOption } from '../types.js';
import { useTUIContext } from '../apps/TUIApp.js';

/**
 * Interactive select component with rich features
 */
export const Select = <T = string>({
  label,
  options,
  value,
  onChange,
  multiple = false,
  placeholder = 'Select an option...',
  searchable = false,
  maxVisible = 10,
  disabled = false,
  autoFocus = false,
  testId
}: SelectProps<T>): React.ReactElement => {
  const { theme, isHeadless } = useTUIContext();
  const [isOpen, setIsOpen] = useState(autoFocus);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedValues, setSelectedValues] = useState<T[]>(
    multiple ? (Array.isArray(value) ? value : value ? [value] : []) : []
  );

  // Filter options based on search query
  const filteredOptions = useMemo(() => {
    if (!searchQuery) return options;

    return options.filter(option =>
      option.label.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (option.description && option.description.toLowerCase().includes(searchQuery.toLowerCase()))
    );
  }, [options, searchQuery]);

  // Group options if they have groups
  const groupedOptions = useMemo(() => {
    const groups: Record<string, SelectOption<T>[]> = {};
    const ungrouped: SelectOption<T>[] = [];

    filteredOptions.forEach(option => {
      if (option.group) {
        if (!groups[option.group]) {
          groups[option.group] = [];
        }
        groups[option.group].push(option);
      } else {
        ungrouped.push(option);
      }
    });

    return { groups, ungrouped };
  }, [filteredOptions]);

  // Flatten grouped options for navigation
  const flatOptions = useMemo(() => {
    const result: SelectOption<T>[] = [];

    // Add ungrouped options first
    result.push(...groupedOptions.ungrouped);

    // Add grouped options
    Object.entries(groupedOptions.groups).forEach(([group, groupOptions]) => {
      result.push(...groupOptions);
    });

    return result;
  }, [groupedOptions]);

  // Update selected values when value prop changes
  useEffect(() => {
    if (multiple) {
      setSelectedValues(Array.isArray(value) ? value : value ? [value] : []);
    } else {
      setSelectedValues(value ? [value] : []);
    }
  }, [value, multiple]);

  // Reset selected index when options change
  useEffect(() => {
    setSelectedIndex(0);
  }, [filteredOptions]);

  // Handle keyboard input
  useInput(
    (input, key) => {
      if (disabled) return;

      // Toggle dropdown
      if (key.return && !isOpen) {
        setIsOpen(true);
        return;
      }

      if (!isOpen) {
        // Open on any key when closed
        if (input || key.downArrow || key.upArrow) {
          setIsOpen(true);
          if (input && searchable) {
            setSearchQuery(input);
          }
        }
        return;
      }

      // Handle search input
      if (searchable && input && /^[a-zA-Z0-9\s]$/.test(input)) {
        setSearchQuery(prev => prev + input);
        setSelectedIndex(0);
        return;
      }

      // Handle backspace in search
      if (searchable && key.backspace) {
        setSearchQuery(prev => prev.slice(0, -1));
        setSelectedIndex(0);
        return;
      }

      // Close dropdown
      if (key.escape) {
        setIsOpen(false);
        setSearchQuery('');
        return;
      }

      // Navigate options
      if (key.upArrow) {
        setSelectedIndex(prev =>
          prev === 0 ? flatOptions.length - 1 : prev - 1
        );
        return;
      }

      if (key.downArrow) {
        setSelectedIndex(prev =>
          prev === flatOptions.length - 1 ? 0 : prev + 1
        );
        return;
      }

      // Page navigation
      if (key.pageUp) {
        setSelectedIndex(prev => Math.max(0, prev - maxVisible));
        return;
      }

      if (key.pageDown) {
        setSelectedIndex(prev =>
          Math.min(flatOptions.length - 1, prev + maxVisible)
        );
        return;
      }

      // Home/End navigation
      if (key.home) {
        setSelectedIndex(0);
        return;
      }

      if (key.end) {
        setSelectedIndex(flatOptions.length - 1);
        return;
      }

      // Select option
      if (key.return) {
        const selectedOption = flatOptions[selectedIndex];
        if (selectedOption && !selectedOption.disabled) {
          if (multiple) {
            const newValues = selectedValues.includes(selectedOption.value)
              ? selectedValues.filter(v => v !== selectedOption.value)
              : [...selectedValues, selectedOption.value];
            setSelectedValues(newValues);
            onChange(newValues as any);
          } else {
            onChange(selectedOption.value);
            setIsOpen(false);
            setSearchQuery('');
          }
        }
        return;
      }

      // Toggle selection with space (for multiple select)
      if (multiple && key.space) {
        const selectedOption = flatOptions[selectedIndex];
        if (selectedOption && !selectedOption.disabled) {
          const newValues = selectedValues.includes(selectedOption.value)
            ? selectedValues.filter(v => v !== selectedOption.value)
            : [...selectedValues, selectedOption.value];
          setSelectedValues(newValues);
          onChange(newValues as any);
        }
        return;
      }
    },
    { isActive: !disabled }
  );

  // Get display text for selected values
  const getDisplayText = () => {
    if (selectedValues.length === 0) {
      return placeholder;
    }

    if (multiple) {
      const selectedLabels = selectedValues
        .map(val => options.find(opt => opt.value === val)?.label)
        .filter(Boolean);

      if (selectedLabels.length === 0) return placeholder;
      if (selectedLabels.length === 1) return selectedLabels[0];
      return `${selectedLabels.length} items selected`;
    }

    const selectedOption = options.find(opt => opt.value === selectedValues[0]);
    return selectedOption?.label || placeholder;
  };

  // Headless mode fallback
  if (isHeadless) {
    return (
      <Box flexDirection="column">
        {label && <Text>{label}:</Text>}
        <Text>{getDisplayText()}</Text>
        {isOpen && (
          <Box flexDirection="column" marginLeft={2}>
            {flatOptions.map((option, index) => (
              <Text key={String(option.value)} color={index === selectedIndex ? 'cyan' : 'white'}>
                {index === selectedIndex ? '> ' : '  '}
                {multiple && selectedValues.includes(option.value) ? '[✓] ' : multiple ? '[ ] ' : ''}
                {option.label}
              </Text>
            ))}
          </Box>
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

      {/* Selected value display */}
      <Box
        borderStyle="round"
        borderColor={
          disabled
            ? theme.muted
            : isOpen
            ? theme.primary
            : theme.muted
        }
        paddingX={1}
      >
        <Text color={selectedValues.length === 0 ? theme.muted : theme.text}>
          {getDisplayText()}
        </Text>
        <Text color={theme.muted}> {isOpen ? '▲' : '▼'}</Text>
      </Box>

      {/* Search input */}
      {isOpen && searchable && (
        <Box
          marginTop={1}
          borderStyle="round"
          borderColor={theme.primary}
          paddingX={1}
        >
          <Text color={theme.muted}>Search: </Text>
          <Text color={theme.text}>{searchQuery}</Text>
          <Text color={theme.primary}>|</Text>
        </Box>
      )}

      {/* Options dropdown */}
      {isOpen && (
        <Box
          marginTop={1}
          borderStyle="round"
          borderColor={theme.primary}
          paddingX={1}
          paddingY={1}
          flexDirection="column"
          maxHeight={maxVisible + 2}
        >
          {flatOptions.length === 0 ? (
            <Text color={theme.muted}>No options found</Text>
          ) : (
            <>
              {/* Render ungrouped options */}
              {groupedOptions.ungrouped.map((option, globalIndex) => {
                const isSelected = selectedIndex === globalIndex;
                const isChecked = selectedValues.includes(option.value);

                return (
                  <Box key={String(option.value)}>
                    <Text
                      color={
                        option.disabled
                          ? theme.muted
                          : isSelected
                          ? theme.primary
                          : theme.text
                      }
                      backgroundColor={isSelected ? theme.primary : undefined}
                      inverse={isSelected && !option.disabled}
                    >
                      {isSelected ? '> ' : '  '}
                      {multiple && (
                        <Text color={isChecked ? theme.success : theme.muted}>
                          {isChecked ? '[✓] ' : '[ ] '}
                        </Text>
                      )}
                      {option.label}
                      {option.description && (
                        <Text color={theme.muted}> - {option.description}</Text>
                      )}
                    </Text>
                  </Box>
                );
              })}

              {/* Render grouped options */}
              {Object.entries(groupedOptions.groups).map(([groupName, groupOptions]) => {
                const groupStartIndex = groupedOptions.ungrouped.length +
                  Object.entries(groupedOptions.groups)
                    .slice(0, Object.keys(groupedOptions.groups).indexOf(groupName))
                    .reduce((acc, [, opts]) => acc + opts.length, 0);

                return (
                  <Box key={groupName} flexDirection="column">
                    {/* Group header */}
                    <Box marginTop={1} marginBottom={1}>
                      <Text color={theme.secondary} bold>
                        {groupName}
                      </Text>
                    </Box>

                    {/* Group options */}
                    {groupOptions.map((option, localIndex) => {
                      const globalIndex = groupStartIndex + localIndex;
                      const isSelected = selectedIndex === globalIndex;
                      const isChecked = selectedValues.includes(option.value);

                      return (
                        <Box key={String(option.value)} marginLeft={2}>
                          <Text
                            color={
                              option.disabled
                                ? theme.muted
                                : isSelected
                                ? theme.primary
                                : theme.text
                            }
                            backgroundColor={isSelected ? theme.primary : undefined}
                            inverse={isSelected && !option.disabled}
                          >
                            {isSelected ? '> ' : '  '}
                            {multiple && (
                              <Text color={isChecked ? theme.success : theme.muted}>
                                {isChecked ? '[✓] ' : '[ ] '}
                              </Text>
                            )}
                            {option.label}
                            {option.description && (
                              <Text color={theme.muted}> - {option.description}</Text>
                            )}
                          </Text>
                        </Box>
                      );
                    })}
                  </Box>
                );
              })}
            </>
          )}

          {/* Help text */}
          {!disabled && flatOptions.length > 0 && (
            <Box marginTop={1} borderTop borderColor={theme.muted} paddingTop={1}>
              <Text color={theme.muted}>
                {multiple ? '↑↓ navigate • Space to toggle • Enter to confirm • ESC to close' : '↑↓ navigate • Enter to select • ESC to close'}
                {searchable && ' • Type to search'}
              </Text>
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
};

/**
 * Simple single-select dropdown
 */
export const SingleSelect = <T = string>(props: Omit<SelectProps<T>, 'multiple'>) => {
  return <Select {...props} multiple={false} />;
};

/**
 * Multi-select dropdown with checkboxes
 */
export const MultiSelect = <T = string>(props: Omit<SelectProps<T>, 'multiple'>) => {
  return <Select {...props} multiple={true} />;
};

/**
 * Searchable select with built-in filtering
 */
export const SearchableSelect = <T = string>(props: Omit<SelectProps<T>, 'searchable'>) => {
  return <Select {...props} searchable={true} />;
};

/**
 * Quick selection for common yes/no choices
 */
export const BooleanSelect: React.FC<{
  label?: string;
  value?: boolean;
  onChange: (value: boolean) => void;
  trueLabel?: string;
  falseLabel?: string;
  testId?: string;
}> = ({
  label,
  value,
  onChange,
  trueLabel = 'Yes',
  falseLabel = 'No',
  testId
}) => {
  const options: SelectOption<boolean>[] = [
    { value: true, label: trueLabel },
    { value: false, label: falseLabel }
  ];

  return (
    <Select
      label={label}
      options={options}
      value={value}
      onChange={onChange}
      testId={testId}
    />
  );
};

/**
 * Select with predefined common choices
 */
export const QuickSelect: React.FC<{
  label?: string;
  choices: string[];
  value?: string;
  onChange: (value: string) => void;
  placeholder?: string;
  testId?: string;
}> = ({
  label,
  choices,
  value,
  onChange,
  placeholder,
  testId
}) => {
  const options: SelectOption<string>[] = choices.map(choice => ({
    value: choice,
    label: choice
  }));

  return (
    <Select
      label={label}
      options={options}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      testId={testId}
    />
  );
};

export default Select;