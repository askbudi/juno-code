/**
 * TUI Types Module for juno-task-ts
 *
 * TypeScript interfaces and types for Terminal User Interface components,
 * built on Ink + React with support for headless fallback modes.
 */

import React from 'react';

// ============================================================================
// Base TUI Types
// ============================================================================

/**
 * TUI component base props
 */
export interface TUIComponentProps {
  /** Component test ID for testing */
  testId?: string;
  /** Whether component is disabled */
  disabled?: boolean;
  /** Whether component should auto-focus */
  autoFocus?: boolean;
}

/**
 * TUI theme configuration
 */
export interface TUITheme {
  /** Primary color for highlights */
  primary: string;
  /** Secondary color for accents */
  secondary: string;
  /** Success color for positive states */
  success: string;
  /** Warning color for caution states */
  warning: string;
  /** Error color for error states */
  error: string;
  /** Muted color for disabled/secondary text */
  muted: string;
  /** Background color (for bordered components) */
  background: string;
  /** Text color */
  text: string;
}

/**
 * Default TUI theme
 */
export const DEFAULT_TUI_THEME: TUITheme = {
  primary: '#0066cc',
  secondary: '#6366f1',
  success: '#16a34a',
  warning: '#ca8a04',
  error: '#dc2626',
  muted: '#6b7280',
  background: '#ffffff',
  text: '#111827'
};

// ============================================================================
// Input Component Types
// ============================================================================

/**
 * Input component props
 */
export interface InputProps extends TUIComponentProps {
  /** Input label text */
  label?: string;
  /** Placeholder text when empty */
  placeholder?: string;
  /** Current input value */
  value: string;
  /** Callback when value changes */
  onChange: (value: string) => void;
  /** Callback when enter is pressed */
  onSubmit?: (value: string) => void;
  /** Whether input is password type */
  isPassword?: boolean;
  /** Whether input allows multiline */
  multiline?: boolean;
  /** Maximum input length */
  maxLength?: number;
  /** Input validation function */
  validate?: (value: string) => string | null;
  /** Whether to show character count */
  showCount?: boolean;
}

/**
 * Input validation result
 */
export interface InputValidation {
  /** Whether input is valid */
  isValid: boolean;
  /** Error message if invalid */
  error?: string;
}

// ============================================================================
// Spinner Component Types
// ============================================================================

/**
 * Spinner component props
 */
export interface SpinnerProps extends TUIComponentProps {
  /** Loading message to display */
  label?: string;
  /** Spinner type/style */
  type?: SpinnerType;
  /** Custom spinner frames */
  frames?: string[];
  /** Animation interval in milliseconds */
  interval?: number;
}

/**
 * Available spinner types
 */
export type SpinnerType = 'dots' | 'line' | 'arc' | 'arrow' | 'bounce' | 'pulse';

// ============================================================================
// Progress Bar Component Types
// ============================================================================

/**
 * Progress bar component props
 */
export interface ProgressBarProps extends TUIComponentProps {
  /** Current progress value (0-100) */
  value: number;
  /** Maximum progress value */
  max?: number;
  /** Progress label text */
  label?: string;
  /** Whether to show percentage */
  showPercentage?: boolean;
  /** Progress bar width in characters */
  width?: number;
  /** Custom progress characters */
  chars?: {
    complete: string;
    incomplete: string;
    cursor: string;
  };
}

// ============================================================================
// Dialog Component Types
// ============================================================================

/**
 * Dialog component props
 */
export interface DialogProps extends TUIComponentProps {
  /** Dialog title */
  title?: string;
  /** Dialog message/content */
  message: string;
  /** Whether dialog is visible */
  isVisible: boolean;
  /** Callback when dialog is closed */
  onClose: () => void;
  /** Dialog buttons configuration */
  buttons?: DialogButton[];
  /** Dialog type affects styling */
  type?: DialogType;
  /** Whether dialog can be closed with escape */
  dismissible?: boolean;
}

/**
 * Dialog button configuration
 */
export interface DialogButton {
  /** Button label */
  label: string;
  /** Button action handler */
  action: () => void;
  /** Button style variant */
  variant?: ButtonVariant;
  /** Whether button is disabled */
  disabled?: boolean;
  /** Whether this is the default button */
  isDefault?: boolean;
}

/**
 * Dialog types
 */
export type DialogType = 'info' | 'success' | 'warning' | 'error' | 'confirm';

/**
 * Button style variants
 */
export type ButtonVariant = 'primary' | 'secondary' | 'success' | 'warning' | 'error';

// ============================================================================
// Select Component Types
// ============================================================================

/**
 * Select component props
 */
export interface SelectProps<T = string> extends TUIComponentProps {
  /** Select label text */
  label?: string;
  /** Available options */
  options: SelectOption<T>[];
  /** Currently selected value */
  value?: T;
  /** Callback when selection changes */
  onChange: (value: T) => void;
  /** Whether multiple selection is allowed */
  multiple?: boolean;
  /** Placeholder when no selection */
  placeholder?: string;
  /** Whether options are searchable */
  searchable?: boolean;
  /** Maximum visible options */
  maxVisible?: number;
}

/**
 * Select option configuration
 */
export interface SelectOption<T = string> {
  /** Option value */
  value: T;
  /** Option display label */
  label: string;
  /** Option description */
  description?: string;
  /** Whether option is disabled */
  disabled?: boolean;
  /** Option group (for categorization) */
  group?: string;
}

// ============================================================================
// TUI App Framework Types
// ============================================================================

/**
 * TUI application props
 */
export interface TUIAppProps {
  /** App title for display */
  title?: string;
  /** Whether app can be exited with ESC */
  exitOnEscape?: boolean;
  /** Custom theme configuration */
  theme?: Partial<TUITheme>;
  /** App children components */
  children: React.ReactNode;
  /** Callback when app exits */
  onExit?: (exitCode?: number) => void;
  /** Whether to clear screen on mount */
  clearOnMount?: boolean;
}

/**
 * TUI application state
 */
export interface TUIAppState {
  /** Whether app is active */
  isActive: boolean;
  /** Current screen/view */
  currentView?: string;
  /** App-level error state */
  error?: Error;
  /** Whether app is in fullscreen mode */
  isFullscreen: boolean;
}

// ============================================================================
// Rendering and Context Types
// ============================================================================

/**
 * TUI render options
 */
export interface TUIRenderOptions {
  /** Whether to exit on unmount */
  exitOnCtrlC?: boolean;
  /** Whether to capture stdout */
  debug?: boolean;
  /** Custom output stream */
  stdout?: NodeJS.WriteStream;
  /** Custom input stream */
  stdin?: NodeJS.ReadStream;
  /** Whether to wait for render completion */
  waitUntilExit?: boolean;
}

/**
 * TUI context for sharing state
 */
export interface TUIContext {
  /** Current theme */
  theme: TUITheme;
  /** Whether in headless mode */
  isHeadless: boolean;
  /** Terminal dimensions */
  dimensions: {
    width: number;
    height: number;
  };
  /** Global TUI state */
  appState: TUIAppState;
  /** Theme update function */
  updateTheme: (theme: Partial<TUITheme>) => void;
  /** Exit application function */
  exit: (code?: number) => void;
}

// ============================================================================
// Keyboard and Input Types
// ============================================================================

/**
 * Keyboard event data
 */
export interface KeyboardEvent {
  /** Key that was pressed */
  key: string;
  /** Whether ctrl was held */
  ctrl: boolean;
  /** Whether meta was held */
  meta: boolean;
  /** Whether shift was held */
  shift: boolean;
  /** Whether alt was held */
  alt: boolean;
  /** Raw key sequence */
  sequence: string;
}

/**
 * Key binding configuration
 */
export interface KeyBinding {
  /** Key combination */
  key: string;
  /** Action handler */
  handler: (event: KeyboardEvent) => boolean | void;
  /** Description for help */
  description?: string;
  /** Whether binding is global */
  global?: boolean;
}

// ============================================================================
// Prompt Editor Types (for --interactive-prompt)
// ============================================================================

/**
 * Prompt editor configuration
 */
export interface PromptEditorProps extends TUIComponentProps {
  /** Initial prompt text */
  initialValue?: string;
  /** Callback when prompt is submitted */
  onSubmit: (prompt: string) => void;
  /** Callback when editor is cancelled */
  onCancel: () => void;
  /** Whether to show help */
  showHelp?: boolean;
  /** Whether to enable syntax highlighting */
  enableSyntaxHighlighting?: boolean;
  /** Maximum prompt length */
  maxLength?: number;
  /** Template variables for highlighting and completion */
  templateVariables?: Record<string, any>;
  /** Whether to show real-time preview */
  showPreview?: boolean;
  /** Whether to show token count estimation */
  showTokenCount?: boolean;
  /** Target AI model for token estimation */
  targetModel?: 'gpt-4' | 'claude-3' | 'gemini';
  /** Whether to show prompt analysis */
  showAnalysis?: boolean;
}

/**
 * Prompt editor state
 */
export interface PromptEditorState {
  /** Current prompt text */
  text: string;
  /** Cursor position */
  cursorPosition: number;
  /** Whether editor is in help mode */
  showingHelp: boolean;
  /** Whether text has been modified */
  isDirty: boolean;
  /** Current line number */
  currentLine: number;
  /** Total lines */
  totalLines: number;
  /** Current token count estimate */
  tokenCount?: TokenEstimate;
  /** Current prompt analysis */
  analysis?: PromptAnalysis;
  /** Template preview text */
  previewText?: string;
}

/**
 * Template variable information
 */
export interface TemplateVariable {
  /** Variable name */
  name: string;
  /** Variable type */
  type: 'string' | 'number' | 'boolean' | 'array';
  /** Whether variable is required */
  required: boolean;
  /** Default value */
  default?: any;
  /** Variable description */
  description?: string;
  /** Current value */
  value?: any;
}

/**
 * Token count estimation
 */
export interface TokenEstimate {
  /** Estimated token count */
  count: number;
  /** Whether estimate is approximate */
  approximate: boolean;
  /** Estimated cost if available */
  costEstimate?: number;
  /** Model used for estimation */
  model: string;
}

/**
 * Prompt structure analysis
 */
export interface PromptAnalysis {
  /** Overall quality score (0-100) */
  qualityScore: number;
  /** Structure analysis */
  structure: StructureAnalysis;
  /** Clarity analysis */
  clarity: ClarityAnalysis;
  /** Completeness analysis */
  completeness: CompletenessAnalysis;
  /** Optimization suggestions */
  suggestions: PromptSuggestion[];
}

/**
 * Prompt structure analysis
 */
export interface StructureAnalysis {
  /** Whether prompt has clear structure */
  hasClearStructure: boolean;
  /** Whether prompt has context section */
  hasContext: boolean;
  /** Whether prompt has task definition */
  hasTask: boolean;
  /** Whether prompt has constraints */
  hasConstraints: boolean;
  /** Whether prompt has examples */
  hasExamples: boolean;
  /** Structure score (0-100) */
  score: number;
}

/**
 * Prompt clarity analysis
 */
export interface ClarityAnalysis {
  /** Average sentence length */
  avgSentenceLength: number;
  /** Number of ambiguous words */
  ambiguousWordCount: number;
  /** Passive voice ratio */
  passiveVoiceRatio: number;
  /** Clarity score (0-100) */
  clarityScore: number;
}

/**
 * Prompt completeness analysis
 */
export interface CompletenessAnalysis {
  /** Whether prompt defines the task clearly */
  hasTaskDefinition: boolean;
  /** Whether prompt provides sufficient context */
  hasContext: boolean;
  /** Whether prompt specifies output format */
  hasOutputFormat: boolean;
  /** Whether prompt includes examples */
  hasExamples: boolean;
  /** Completeness score (0-100) */
  score: number;
}

/**
 * Prompt optimization suggestion
 */
export interface PromptSuggestion {
  /** Suggestion type */
  type: 'structure' | 'clarity' | 'completeness' | 'efficiency' | 'specificity';
  /** Suggestion message */
  message: string;
  /** Detailed suggestion */
  suggestion: string;
  /** Priority level */
  priority: 'low' | 'medium' | 'high';
  /** Line number if applicable */
  lineNumber?: number;
}

/**
 * Syntax highlighting token
 */
export interface SyntaxToken {
  /** Token text */
  text: string;
  /** Token type for styling */
  type: 'variable' | 'keyword' | 'string' | 'comment' | 'url' | 'path' | 'code' | 'plain';
  /** Start position in text */
  start: number;
  /** End position in text */
  end: number;
  /** Whether token is valid (for variables) */
  isValid?: boolean;
}

// ============================================================================
// Utility Types
// ============================================================================

/**
 * TUI event handler
 */
export type TUIEventHandler<T = any> = (event: T) => void;

/**
 * TUI async handler
 */
export type TUIAsyncHandler<T = any> = (event: T) => Promise<void>;

/**
 * TUI component lifecycle
 */
export interface TUILifecycle {
  /** Called when component mounts */
  onMount?: () => void;
  /** Called when component unmounts */
  onUnmount?: () => void;
  /** Called when component updates */
  onUpdate?: () => void;
  /** Called when component has error */
  onError?: (error: Error) => void;
}

/**
 * TUI animation frame
 */
export interface AnimationFrame {
  /** Frame content */
  content: string;
  /** Frame duration in ms */
  duration?: number;
}

/**
 * TUI layout dimensions
 */
export interface LayoutDimensions {
  /** Width in characters */
  width: number;
  /** Height in lines */
  height: number;
  /** X offset */
  x?: number;
  /** Y offset */
  y?: number;
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * TUI-specific error
 */
export class TUIError extends Error {
  /** Error code */
  code: string;
  /** Component that caused error */
  component?: string;

  constructor(message: string, code: string = 'TUI_ERROR', component?: string) {
    super(message);
    this.name = 'TUIError';
    this.code = code;
    this.component = component;
  }
}

/**
 * TUI render error
 */
export class TUIRenderError extends TUIError {
  constructor(message: string, component?: string) {
    super(message, 'TUI_RENDER_ERROR', component);
    this.name = 'TUIRenderError';
  }
}

/**
 * TUI input error
 */
export class TUIInputError extends TUIError {
  constructor(message: string, component?: string) {
    super(message, 'TUI_INPUT_ERROR', component);
    this.name = 'TUIInputError';
  }
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Type guard for TUI errors
 */
export function isTUIError(error: unknown): error is TUIError {
  return error instanceof TUIError;
}

/**
 * Type guard for keyboard events
 */
export function isKeyboardEvent(event: unknown): event is KeyboardEvent {
  return (
    typeof event === 'object' &&
    event !== null &&
    'key' in event &&
    'ctrl' in event
  );
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Common key mappings
 */
export const KEYS = {
  ENTER: 'return',
  ESCAPE: 'escape',
  TAB: 'tab',
  BACKSPACE: 'backspace',
  DELETE: 'delete',
  UP: 'upArrow',
  DOWN: 'downArrow',
  LEFT: 'leftArrow',
  RIGHT: 'rightArrow',
  HOME: 'home',
  END: 'end',
  PAGE_UP: 'pageUp',
  PAGE_DOWN: 'pageDown',
  CTRL_C: 'ctrl+c',
  CTRL_D: 'ctrl+d',
  CTRL_Z: 'ctrl+z'
} as const;

/**
 * Default spinner frames
 */
export const SPINNER_FRAMES = {
  dots: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  line: ['|', '/', '-', '\\'],
  arc: ['◜', '◠', '◝', '◞', '◡', '◟'],
  arrow: ['←', '↖', '↑', '↗', '→', '↘', '↓', '↙'],
  bounce: ['⠁', '⠂', '⠄', '⠂'],
  pulse: ['●', '○', '●', '○']
} as const;

/**
 * Default progress bar characters
 */
export const PROGRESS_CHARS = {
  complete: '█',
  incomplete: '░',
  cursor: '█'
} as const;