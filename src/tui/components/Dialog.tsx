/**
 * Dialog Component for juno-task-ts TUI
 *
 * Modal dialog component for confirmations, alerts, and user interactions.
 * Supports various dialog types with customizable buttons and keyboard navigation.
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import chalk from 'chalk';
import type { DialogProps, DialogButton, DialogType, ButtonVariant } from '../types.js';
import { useTUIContext } from '../apps/TUIApp.js';

/**
 * Modal dialog component with customizable content and buttons
 */
export const Dialog: React.FC<DialogProps> = ({
  title,
  message,
  isVisible,
  onClose,
  buttons = [],
  type = 'info',
  dismissible = true,
  disabled = false,
  testId
}) => {
  const { theme, isHeadless } = useTUIContext();
  const [selectedButtonIndex, setSelectedButtonIndex] = useState(0);

  // Default buttons if none provided
  const defaultButtons: DialogButton[] = buttons.length > 0 ? buttons : [
    {
      label: 'OK',
      action: onClose,
      variant: 'primary',
      isDefault: true
    }
  ];

  // Find default button or use first button
  const defaultButtonIndex = defaultButtons.findIndex(btn => btn.isDefault) || 0;

  // Reset selection when dialog becomes visible
  useEffect(() => {
    if (isVisible) {
      setSelectedButtonIndex(defaultButtonIndex);
    }
  }, [isVisible, defaultButtonIndex]);

  // Handle keyboard input
  useInput(
    (input, key) => {
      if (!isVisible || disabled) return;

      // ESC to close (if dismissible)
      if (key.escape && dismissible) {
        onClose();
        return;
      }

      // Enter to activate selected button
      if (key.return) {
        const selectedButton = defaultButtons[selectedButtonIndex];
        if (selectedButton && !selectedButton.disabled) {
          selectedButton.action();
        }
        return;
      }

      // Arrow keys to navigate buttons
      if (key.leftArrow || key.upArrow) {
        setSelectedButtonIndex((prev) =>
          prev === 0 ? defaultButtons.length - 1 : prev - 1
        );
        return;
      }

      if (key.rightArrow || key.downArrow) {
        setSelectedButtonIndex((prev) =>
          prev === defaultButtons.length - 1 ? 0 : prev + 1
        );
        return;
      }

      // Tab to navigate buttons
      if (key.tab) {
        setSelectedButtonIndex((prev) =>
          (prev + 1) % defaultButtons.length
        );
        return;
      }

      // Number keys to select buttons (1-9)
      if (input && /^[1-9]$/.test(input)) {
        const buttonIndex = parseInt(input) - 1;
        if (buttonIndex < defaultButtons.length) {
          const button = defaultButtons[buttonIndex];
          if (!button.disabled) {
            button.action();
          }
        }
        return;
      }

      // First letter shortcuts
      if (input && /^[a-zA-Z]$/.test(input)) {
        const letter = input.toLowerCase();
        const matchingButtonIndex = defaultButtons.findIndex(
          btn => btn.label.toLowerCase().startsWith(letter) && !btn.disabled
        );
        if (matchingButtonIndex !== -1) {
          defaultButtons[matchingButtonIndex].action();
        }
        return;
      }
    },
    { isActive: isVisible && !disabled }
  );

  // Don't render if not visible
  if (!isVisible) {
    return null;
  }

  // Get dialog styling based on type
  const getDialogStyling = (dialogType: DialogType) => {
    switch (dialogType) {
      case 'success':
        return { borderColor: theme.success, icon: '✓' };
      case 'warning':
        return { borderColor: theme.warning, icon: '⚠' };
      case 'error':
        return { borderColor: theme.error, icon: '✗' };
      case 'confirm':
        return { borderColor: theme.primary, icon: '?' };
      default:
        return { borderColor: theme.primary, icon: 'ℹ' };
    }
  };

  const styling = getDialogStyling(type);

  // Get button styling
  const getButtonStyling = (variant: ButtonVariant = 'secondary', isSelected: boolean, isDisabled: boolean) => {
    if (isDisabled) {
      return { color: theme.muted, background: '' };
    }

    const styles = {
      primary: { color: theme.primary, background: isSelected ? theme.primary : '' },
      secondary: { color: theme.text, background: isSelected ? theme.muted : '' },
      success: { color: theme.success, background: isSelected ? theme.success : '' },
      warning: { color: theme.warning, background: isSelected ? theme.warning : '' },
      error: { color: theme.error, background: isSelected ? theme.error : '' }
    };

    return styles[variant];
  };

  // Headless mode fallback
  if (isHeadless) {
    return (
      <Box flexDirection="column">
        {title && <Text>{title}</Text>}
        <Text>{message}</Text>
        <Text>
          Options: {defaultButtons.map((btn, index) => `${index + 1}. ${btn.label}`).join(', ')}
        </Text>
      </Box>
    );
  }

  return (
    <Box
      position="absolute"
      top={0}
      left={0}
      width="100%"
      height="100%"
      justifyContent="center"
      alignItems="center"
      data-testid={testId}
    >
      {/* Backdrop */}
      <Box
        position="absolute"
        top={0}
        left={0}
        width="100%"
        height="100%"
        backgroundColor="black"
        opacity={0.5}
      />

      {/* Dialog content */}
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={styling.borderColor}
        backgroundColor={theme.background}
        paddingX={2}
        paddingY={1}
        minWidth={40}
        maxWidth={80}
      >
        {/* Header */}
        {title && (
          <Box marginBottom={1} alignItems="center">
            <Text color={styling.borderColor}>{styling.icon}</Text>
            <Text color={theme.text} bold> {title}</Text>
          </Box>
        )}

        {/* Message */}
        <Box marginBottom={2}>
          <Text color={theme.text}>{message}</Text>
        </Box>

        {/* Buttons */}
        <Box justifyContent="flex-end" gap={1}>
          {defaultButtons.map((button, index) => {
            const isSelected = index === selectedButtonIndex;
            const styling = getButtonStyling(button.variant, isSelected, button.disabled);

            return (
              <Box
                key={index}
                borderStyle={isSelected ? 'round' : undefined}
                borderColor={isSelected ? styling.color : undefined}
                paddingX={1}
              >
                <Text
                  color={styling.color}
                  backgroundColor={isSelected ? styling.background : undefined}
                  inverse={isSelected && !button.disabled}
                >
                  {index + 1}. {button.label}
                </Text>
              </Box>
            );
          })}
        </Box>

        {/* Help text */}
        {!disabled && (
          <Box marginTop={1}>
            <Text color={theme.muted}>
              Use arrow keys to navigate • Enter to confirm • {dismissible ? 'ESC to cancel' : ''}
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  );
};

/**
 * Confirmation dialog with Yes/No buttons
 */
export const ConfirmDialog: React.FC<{
  title?: string;
  message: string;
  isVisible: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  confirmLabel?: string;
  cancelLabel?: string;
  testId?: string;
}> = ({
  title = 'Confirm',
  message,
  isVisible,
  onConfirm,
  onCancel,
  confirmLabel = 'Yes',
  cancelLabel = 'No',
  testId
}) => {
  const buttons: DialogButton[] = [
    {
      label: cancelLabel,
      action: onCancel,
      variant: 'secondary'
    },
    {
      label: confirmLabel,
      action: onConfirm,
      variant: 'primary',
      isDefault: true
    }
  ];

  return (
    <Dialog
      title={title}
      message={message}
      isVisible={isVisible}
      onClose={onCancel}
      buttons={buttons}
      type="confirm"
      dismissible={true}
      testId={testId}
    />
  );
};

/**
 * Alert dialog for displaying messages
 */
export const AlertDialog: React.FC<{
  title?: string;
  message: string;
  isVisible: boolean;
  onClose: () => void;
  type?: DialogType;
  testId?: string;
}> = ({
  title,
  message,
  isVisible,
  onClose,
  type = 'info',
  testId
}) => {
  const buttons: DialogButton[] = [
    {
      label: 'OK',
      action: onClose,
      variant: 'primary',
      isDefault: true
    }
  ];

  return (
    <Dialog
      title={title}
      message={message}
      isVisible={isVisible}
      onClose={onClose}
      buttons={buttons}
      type={type}
      dismissible={true}
      testId={testId}
    />
  );
};

/**
 * Choice dialog for selecting from multiple options
 */
export const ChoiceDialog: React.FC<{
  title?: string;
  message: string;
  choices: { label: string; value: any; variant?: ButtonVariant }[];
  isVisible: boolean;
  onChoice: (value: any) => void;
  onCancel?: () => void;
  testId?: string;
}> = ({
  title,
  message,
  choices,
  isVisible,
  onChoice,
  onCancel,
  testId
}) => {
  const buttons: DialogButton[] = [
    ...choices.map((choice, index) => ({
      label: choice.label,
      action: () => onChoice(choice.value),
      variant: choice.variant || 'secondary' as ButtonVariant,
      isDefault: index === 0
    })),
    ...(onCancel ? [{
      label: 'Cancel',
      action: onCancel,
      variant: 'secondary' as ButtonVariant
    }] : [])
  ];

  return (
    <Dialog
      title={title}
      message={message}
      isVisible={isVisible}
      onClose={onCancel || (() => {})}
      buttons={buttons}
      type="info"
      dismissible={!!onCancel}
      testId={testId}
    />
  );
};

/**
 * Error dialog with retry option
 */
export const ErrorDialog: React.FC<{
  title?: string;
  message: string;
  error?: Error;
  isVisible: boolean;
  onRetry?: () => void;
  onClose: () => void;
  showDetails?: boolean;
  testId?: string;
}> = ({
  title = 'Error',
  message,
  error,
  isVisible,
  onRetry,
  onClose,
  showDetails = false,
  testId
}) => {
  const [showError, setShowError] = useState(false);

  const buttons: DialogButton[] = [
    ...(onRetry ? [{
      label: 'Retry',
      action: onRetry,
      variant: 'primary' as ButtonVariant,
      isDefault: true
    }] : []),
    {
      label: 'Close',
      action: onClose,
      variant: 'secondary' as ButtonVariant,
      isDefault: !onRetry
    },
    ...(error && showDetails ? [{
      label: showError ? 'Hide Details' : 'Show Details',
      action: () => setShowError(!showError),
      variant: 'secondary' as ButtonVariant
    }] : [])
  ];

  const fullMessage = showError && error
    ? `${message}\n\nError Details:\n${error.message}\n\nStack Trace:\n${error.stack}`
    : message;

  return (
    <Dialog
      title={title}
      message={fullMessage}
      isVisible={isVisible}
      onClose={onClose}
      buttons={buttons}
      type="error"
      dismissible={true}
      testId={testId}
    />
  );
};

/**
 * Progress dialog for long-running operations
 */
export const ProgressDialog: React.FC<{
  title?: string;
  message: string;
  progress?: number;
  isVisible: boolean;
  onCancel?: () => void;
  showProgress?: boolean;
  testId?: string;
}> = ({
  title = 'Processing',
  message,
  progress,
  isVisible,
  onCancel,
  showProgress = true,
  testId
}) => {
  const { theme } = useTUIContext();

  const buttons: DialogButton[] = onCancel ? [{
    label: 'Cancel',
    action: onCancel,
    variant: 'secondary'
  }] : [];

  const progressBar = showProgress && typeof progress === 'number'
    ? `\n\n${'█'.repeat(Math.floor(progress / 5))}${'░'.repeat(20 - Math.floor(progress / 5))} ${Math.round(progress)}%`
    : '';

  return (
    <Dialog
      title={title}
      message={message + progressBar}
      isVisible={isVisible}
      onClose={() => {}} // Cannot close without explicit action
      buttons={buttons}
      type="info"
      dismissible={false}
      testId={testId}
    />
  );
};

export default Dialog;