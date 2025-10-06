/**
 * TUI Module Entry Point for juno-task-ts
 *
 * Main exports for the Terminal User Interface system built on Ink + React.
 * Provides all components, apps, hooks, and utilities for TUI functionality.
 */

// ============================================================================
// Core Types and Interfaces
// ============================================================================

export * from './types.js';

// ============================================================================
// Base Components
// ============================================================================

export { Input, Validators } from './components/Input.js';
export {
  Spinner,
  LoadingSpinner,
  ProgressSpinner,
  TimedSpinner,
  CustomSpinner,
  SpinnerPresets
} from './components/Spinner.js';
export {
  ProgressBar,
  StepProgressBar,
  IndeterminateProgressBar,
  CircularProgress,
  FileProgressBar,
  useProgressAnimation
} from './components/ProgressBar.js';
export {
  Dialog,
  ConfirmDialog,
  AlertDialog,
  ChoiceDialog,
  ErrorDialog,
  ProgressDialog
} from './components/Dialog.js';
export {
  Select,
  SingleSelect,
  MultiSelect,
  SearchableSelect,
  BooleanSelect,
  QuickSelect
} from './components/Select.js';

// ============================================================================
// TUI Applications
// ============================================================================

export {
  TUIApp,
  TUIScreen,
  TUIScreenManager,
  TUILayout,
  useTUIContext
} from './apps/TUIApp.js';
export {
  PromptEditor,
  SimplePromptEditor
} from './apps/PromptEditor.js';

// ============================================================================
// Custom Hooks
// ============================================================================

// Note: useTUIContext is already exported from TUIApp.js
export {
  useKeyboard,
  useGlobalShortcuts,
  useNavigationKeys,
  useTextEditingKeys,
  useFormKeys,
  useAppShortcuts,
  createKeySequence,
  parseKeyBinding
} from './hooks/useKeyboard.js';
export {
  useTUIState,
  useFormState,
  useListState
} from './hooks/useTUIState.js';

// ============================================================================
// Rendering and Utilities
// ============================================================================

export {
  TUIRenderer,
  tuiRenderer,
  renderTUI,
  renderAndWait,
  showTUIAlert,
  isTUIAvailable,
  safeTUIRender,
  registerCleanupHandlers,
  initializeTUIRenderer
} from './utils/renderer.js';
export {
  headlessPromptEditor,
  headlessConfirmation,
  headlessSelection,
  headlessAlert,
  getTUICapabilities,
  enhanceForTerminal,
  safeConsoleOutput,
  createHeadlessProgress,
  getEnvironmentType
} from './utils/headless.js';

// ============================================================================
// High-Level TUI Functions for CLI Integration
// ============================================================================

/**
 * Launch the TUI prompt editor for interactive prompt creation
 */
export async function launchPromptEditor(options: {
  initialValue?: string;
  title?: string;
  maxLength?: number;
}): Promise<string | null> {
  const { isTUISupported } = await import('./utils/renderer.js');
  const { headlessPromptEditor } = await import('./utils/headless.js');

  // Use headless fallback if TUI is not supported
  if (!isTUISupported()) {
    return headlessPromptEditor(options);
  }

  try {
    const { initializeTUIRenderer, renderAndWait } = await import('./utils/renderer.js');
    const { PromptEditor } = await import('./apps/PromptEditor.js');
    const React = await import('react');

    const { initialValue = '', title = 'Prompt Editor', maxLength = 10000 } = options;

    return new Promise((resolve) => {
      const handleSubmit = (prompt: string) => {
        resolve(prompt);
      };

      const handleCancel = () => {
        resolve(null);
      };

      const editorComponent = React.createElement(PromptEditor, {
        initialValue,
        onSubmit: handleSubmit,
        onCancel: handleCancel,
        maxLength,
        showHelp: true,
        enableSyntaxHighlighting: true
      });

      // Initialize renderer and render editor
      const renderer = initializeTUIRenderer();
      renderAndWait(editorComponent).catch((error) => {
        console.error('Failed to render prompt editor:', error);
        resolve(null);
      });
    });
  } catch (error) {
    console.warn('TUI failed, falling back to headless mode:', error);
    return headlessPromptEditor(options);
  }
}

/**
 * Launch a simple prompt input dialog
 */
export async function launchSimplePrompt(options: {
  message?: string;
  placeholder?: string;
  initialValue?: string;
}): Promise<string | null> {
  const { renderAndWait } = await import('./utils/renderer.js');
  const { SimplePromptEditor } = await import('./apps/PromptEditor.js');
  const React = await import('react');

  const { placeholder = 'Enter your prompt...', initialValue = '' } = options;

  return new Promise((resolve) => {
    const handleSubmit = (prompt: string) => {
      resolve(prompt);
    };

    const handleCancel = () => {
      resolve(null);
    };

    const editorComponent = React.createElement(SimplePromptEditor, {
      initialValue,
      onSubmit: handleSubmit,
      onCancel: handleCancel,
      placeholder
    });

    renderAndWait(editorComponent).catch((error) => {
      console.error('Failed to render simple prompt:', error);
      resolve(null);
    });
  });
}

/**
 * Show a confirmation dialog
 */
export async function showConfirmation(options: {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
}): Promise<boolean> {
  const { renderAndWait } = await import('./utils/renderer.js');
  const { ConfirmDialog } = await import('./components/Dialog.js');
  const React = await import('react');

  const {
    title = 'Confirm',
    message,
    confirmLabel = 'Yes',
    cancelLabel = 'No'
  } = options;

  return new Promise((resolve) => {
    const handleConfirm = () => resolve(true);
    const handleCancel = () => resolve(false);

    const dialogComponent = React.createElement(ConfirmDialog, {
      title,
      message,
      isVisible: true,
      onConfirm: handleConfirm,
      onCancel: handleCancel,
      confirmLabel,
      cancelLabel
    });

    renderAndWait(dialogComponent).catch((error) => {
      console.error('Failed to render confirmation dialog:', error);
      resolve(false);
    });
  });
}

/**
 * Show an alert dialog
 */
export async function showAlert(options: {
  title?: string;
  message: string;
  type?: 'info' | 'success' | 'warning' | 'error';
}): Promise<void> {
  const { renderAndWait } = await import('./utils/renderer.js');
  const { AlertDialog } = await import('./components/Dialog.js');
  const React = await import('react');

  const { title, message, type = 'info' } = options;

  return new Promise((resolve) => {
    const handleClose = () => resolve();

    const dialogComponent = React.createElement(AlertDialog, {
      title,
      message,
      isVisible: true,
      onClose: handleClose,
      type
    });

    renderAndWait(dialogComponent).catch((error) => {
      console.error('Failed to render alert dialog:', error);
      resolve();
    });
  });
}

/**
 * Show a selection dialog
 */
export async function showSelection<T = string>(options: {
  title?: string;
  message: string;
  choices: Array<{ label: string; value: T; description?: string }>;
  multiple?: boolean;
  searchable?: boolean;
}): Promise<T | T[] | null> {
  const { renderAndWait } = await import('./utils/renderer.js');
  const { TUIApp } = await import('./apps/TUIApp.js');
  const { Select } = await import('./components/Select.js');
  const React = await import('react');

  const {
    title = 'Select Option',
    message,
    choices,
    multiple = false,
    searchable = false
  } = options;

  return new Promise((resolve) => {
    const handleSelection = (value: T | T[]) => {
      resolve(value);
    };

    const handleCancel = () => {
      resolve(null);
    };

    const selectComponent = React.createElement(
      TUIApp,
      { title, exitOnEscape: true, onExit: handleCancel },
      React.createElement('div', {},
        React.createElement('text', {}, message),
        React.createElement(Select, {
          options: choices,
          onChange: handleSelection,
          multiple,
          searchable,
          autoFocus: true
        })
      )
    );

    renderAndWait(selectComponent).catch((error) => {
      console.error('Failed to render selection dialog:', error);
      resolve(null);
    });
  });
}

/**
 * Check if TUI is available in current environment
 */
export function isTUISupported(): boolean {
  return typeof process !== 'undefined' &&
         process.stdout &&
         process.stdout.isTTY &&
         !process.env.CI &&
         process.env.TERM !== 'dumb';
}

/**
 * Safe TUI execution with automatic fallback
 */
export async function safeTUIExecution<T>(
  tuiFunction: () => Promise<T>,
  fallbackFunction: () => Promise<T>
): Promise<T> {
  if (!isTUISupported()) {
    return fallbackFunction();
  }

  try {
    return await tuiFunction();
  } catch (error) {
    console.warn('TUI execution failed, falling back to CLI mode:', error);
    return fallbackFunction();
  }
}

// ============================================================================
// Default Export
// ============================================================================

export default {
  // Apps
  TUIApp,
  PromptEditor,
  SimplePromptEditor,

  // Components
  Input,
  Spinner,
  ProgressBar,
  Dialog,
  Select,

  // Hooks
  useTUIContext,
  useKeyboard,
  useTUIState,

  // High-level functions
  launchPromptEditor,
  launchSimplePrompt,
  showConfirmation,
  showAlert,
  showSelection,
  isTUISupported,
  safeTUIExecution,

  // Utilities
  tuiRenderer,
  renderTUI,
  renderAndWait
};