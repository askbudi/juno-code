/**
 * @fileoverview Template system types for juno-code
 *
 * Comprehensive TypeScript type definitions for the template system,
 * based on the Python budi-cli implementation. Supports Handlebars
 * template engine with variable substitution patterns compatible
 * with the Python implementation.
 *
 * @version 1.0.0
 * @author juno-code
 */

/**
 * Union type for different variable input types supported by the template system.
 */
export type VariableType =
  | 'text'
  | 'email'
  | 'url'
  | 'identifier'
  | 'version'
  | 'path'
  | 'subagent'
  | 'choice'
  | 'boolean'
  | 'number'
  | 'date'
  | 'timestamp';

/**
 * Union type for runtime variable values that can be substituted in templates.
 */
export type VariableValue = string | number | boolean | Date | null | undefined;

/**
 * Template category enumeration for organizing templates by purpose.
 */
export enum TemplateCategory {
  /** Core project initialization templates */
  CORE = 'core',
  /** Project specification templates */
  SPECS = 'specs',
  /** Development workflow templates */
  WORKFLOW = 'workflow',
  /** Configuration templates */
  CONFIG = 'config',
  /** Documentation templates */
  DOCS = 'docs',
  /** Custom user-defined templates */
  CUSTOM = 'custom'
}

/**
 * Template variable definition interface with validation and metadata.
 */
export interface TemplateVariable {
  /** Variable name/key used in templates */
  readonly name: string;
  /** Human-readable description of the variable */
  readonly description: string;
  /** Variable type for validation */
  readonly type: VariableType;
  /** Default value if none provided */
  readonly defaultValue?: VariableValue;
  /** Whether this variable is required */
  readonly required: boolean;
  /** Valid choices for choice-type variables */
  readonly choices?: readonly string[];
  /** Validation function for custom validation */
  readonly validator?: VariableValidator;
  /** Additional metadata */
  readonly metadata?: Record<string, unknown>;
}

/**
 * Function type for custom variable validation.
 *
 * @param value - The value to validate
 * @returns Validation result with success status and optional error message
 */
export type VariableValidator = (value: VariableValue) => ValidationResult;

/**
 * Validation result interface.
 */
export interface ValidationResult {
  /** Whether validation passed */
  readonly valid: boolean;
  /** Error message if validation failed */
  readonly error?: string;
}

/**
 * Collection of template variables mapped by variable name.
 */
export interface TemplateVariables {
  readonly [variableName: string]: VariableValue;
}

/**
 * Template context interface for rendering operations.
 */
export interface TemplateContext {
  /** Template variables for substitution */
  readonly variables: TemplateVariables;
  /** Environment variables */
  readonly environment: TemplateEnvironment;
  /** Project-specific context data */
  readonly project: ProjectContext;
  /** Git repository context */
  readonly git: GitContext;
  /** Timestamp when context was created */
  readonly timestamp: Date;
}

/**
 * Template environment interface for environment variables and paths.
 */
export interface TemplateEnvironment {
  /** Current working directory */
  readonly cwd: string;
  /** Virtual environment path */
  readonly venvPath?: string;
  /** Node.js version */
  readonly nodeVersion?: string;
  /** npm version */
  readonly npmVersion?: string;
  /** Additional environment variables */
  readonly variables: Record<string, string>;
}

/**
 * Project context interface for project-specific data.
 */
export interface ProjectContext {
  /** Project name */
  readonly name: string;
  /** Project root directory path */
  readonly path: string;
  /** Package name (sanitized project name) */
  readonly packageName: string;
  /** Project description */
  readonly description?: string;
  /** Project version */
  readonly version?: string;
  /** Project author */
  readonly author?: string;
  /** Project license */
  readonly license?: string;
  /** Project phase (development, testing, production) */
  readonly phase?: string;
}

/**
 * Git repository context interface.
 */
export interface GitContext {
  /** Git repository URL */
  readonly url?: string;
  /** Current branch name */
  readonly branch?: string;
  /** Latest commit hash */
  readonly commit?: string;
  /** Repository owner */
  readonly owner?: string;
  /** Repository name */
  readonly repo?: string;
  /** Whether repository has uncommitted changes */
  readonly dirty?: boolean;
}

/**
 * Core template definition interface.
 */
export interface Template {
  /** Unique template identifier */
  readonly id: string;
  /** Template display name */
  readonly name: string;
  /** Template description */
  readonly description: string;
  /** Template category */
  readonly category: TemplateCategory;
  /** Template content with placeholders */
  readonly content: string;
  /** Variables used in this template */
  readonly variables: readonly TemplateVariable[];
  /** Template version */
  readonly version: string;
  /** Template author */
  readonly author?: string;
  /** Template file extension */
  readonly fileExtension?: string;
  /** Whether template supports multiple file generation */
  readonly multiFile?: boolean;
  /** Template metadata */
  readonly metadata?: Record<string, unknown>;
}

/**
 * Template file metadata interface.
 */
export interface TemplateFile {
  /** Relative file path from template root */
  readonly path: string;
  /** File content template */
  readonly content: string;
  /** File-specific variables */
  readonly variables?: readonly TemplateVariable[];
  /** Whether file is executable */
  readonly executable?: boolean;
  /** File encoding */
  readonly encoding?: string;
  /** File metadata */
  readonly metadata?: Record<string, unknown>;
}

/**
 * Template directory structure interface.
 */
export interface TemplateDirectory {
  /** Directory name */
  readonly name: string;
  /** Directory path relative to template root */
  readonly path: string;
  /** Files in this directory */
  readonly files: readonly TemplateFile[];
  /** Subdirectories */
  readonly subdirectories: readonly TemplateDirectory[];
  /** Directory-specific variables */
  readonly variables?: readonly TemplateVariable[];
  /** Directory metadata */
  readonly metadata?: Record<string, unknown>;
}

/**
 * Template manifest interface for template collection information.
 */
export interface TemplateManifest {
  /** Manifest version */
  readonly version: string;
  /** Template collection name */
  readonly name: string;
  /** Template collection description */
  readonly description: string;
  /** Available templates */
  readonly templates: readonly Template[];
  /** Global variables available to all templates */
  readonly globalVariables?: readonly TemplateVariable[];
  /** Template collection author */
  readonly author?: string;
  /** Template collection license */
  readonly license?: string;
  /** Last updated timestamp */
  readonly lastUpdated: Date;
}

/**
 * Template source interface for template content sources.
 */
export interface TemplateSource {
  /** Source type */
  readonly type: 'file' | 'url' | 'git' | 'embedded';
  /** Source location */
  readonly location: string;
  /** Source version/branch/tag */
  readonly version?: string;
  /** Authentication information if required */
  readonly auth?: {
    readonly username?: string;
    readonly token?: string;
  };
  /** Source metadata */
  readonly metadata?: Record<string, unknown>;
}

/**
 * Template engine interface for processing templates.
 */
export interface TemplateEngine {
  /** Engine name */
  readonly name: string;
  /** Engine version */
  readonly version: string;
  /** Supported file extensions */
  readonly supportedExtensions: readonly string[];

  /**
   * Render a template with the given context.
   *
   * @param template - Template to render
   * @param context - Rendering context
   * @param options - Rendering options
   * @returns Promise resolving to rendered content
   */
  render(template: Template, context: TemplateContext, options?: RenderOptions): Promise<string>;

  /**
   * Validate template syntax.
   *
   * @param template - Template to validate
   * @returns Validation result
   */
  validate(template: Template): ValidationResult;

  /**
   * Get variables used in a template.
   *
   * @param template - Template to analyze
   * @returns Array of variable names used in template
   */
  getUsedVariables(template: Template): readonly string[];
}

/**
 * Rendering options interface for template generation configuration.
 */
export interface RenderOptions {
  /** Whether to preserve whitespace */
  readonly preserveWhitespace?: boolean;
  /** Whether to escape HTML characters */
  readonly escapeHtml?: boolean;
  /** Whether to allow partial rendering with missing variables */
  readonly allowPartial?: boolean;
  /** Custom helper functions */
  readonly helpers?: Record<string, (...args: unknown[]) => unknown>;
  /** Rendering timeout in milliseconds */
  readonly timeout?: number;
  /** Additional engine-specific options */
  readonly engineOptions?: Record<string, unknown>;
}

/**
 * Individual file generation result interface.
 */
export interface FileGenerationResult {
  /** Generated file path */
  readonly path: string;
  /** Generated file content */
  readonly content: string;
  /** Generation status */
  readonly status: 'created' | 'overwritten' | 'skipped' | 'error';
  /** Error message if status is 'error' */
  readonly error?: string;
  /** File size in bytes */
  readonly size: number;
  /** Generation timestamp */
  readonly timestamp: Date;
}

/**
 * Template generation result interface.
 */
export interface GenerationResult {
  /** Whether generation was successful */
  readonly success: boolean;
  /** Generated files */
  readonly files: readonly FileGenerationResult[];
  /** Generation context used */
  readonly context: TemplateContext;
  /** Total generation time in milliseconds */
  readonly duration: number;
  /** Generation timestamp */
  readonly timestamp: Date;
  /** Overall error message if generation failed */
  readonly error?: string;
  /** Generation metadata */
  readonly metadata?: Record<string, unknown>;
}

/**
 * Template discovery information interface.
 */
export interface TemplateInfo {
  /** Template identifier */
  readonly id: string;
  /** Template name */
  readonly name: string;
  /** Template description */
  readonly description: string;
  /** Template category */
  readonly category: TemplateCategory;
  /** Template source */
  readonly source: TemplateSource;
  /** Whether template is available locally */
  readonly available: boolean;
  /** Template version */
  readonly version: string;
  /** Template tags for filtering */
  readonly tags?: readonly string[];
}

/**
 * Base class for template-related errors.
 */
export class TemplateError extends Error {
  /** Error code for programmatic handling */
  public readonly code: string;
  /** Original error if this wraps another error */
  public readonly cause?: Error;

  constructor(message: string, code: string = 'TEMPLATE_ERROR', cause?: Error) {
    super(message);
    this.name = 'TemplateError';
    this.code = code;
    this.cause = cause;

    // Maintain proper stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, TemplateError);
    }
  }
}

/**
 * Template parsing error for syntax and structure issues.
 */
export class TemplateParseError extends TemplateError {
  /** Line number where error occurred */
  public readonly line?: number;
  /** Column number where error occurred */
  public readonly column?: number;

  constructor(message: string, line?: number, column?: number, cause?: Error) {
    super(message, 'TEMPLATE_PARSE_ERROR', cause);
    this.name = 'TemplateParseError';
    this.line = line;
    this.column = column;
  }
}

/**
 * Template variable validation error.
 */
export class TemplateVariableError extends TemplateError {
  /** Variable name that caused the error */
  public readonly variableName: string;
  /** Variable value that failed validation */
  public readonly variableValue: VariableValue;

  constructor(message: string, variableName: string, variableValue: VariableValue, cause?: Error) {
    super(message, 'TEMPLATE_VARIABLE_ERROR', cause);
    this.name = 'TemplateVariableError';
    this.variableName = variableName;
    this.variableValue = variableValue;
  }
}

/**
 * Template generation error for file creation and processing issues.
 */
export class TemplateGenerationError extends TemplateError {
  /** Target file path that failed to generate */
  public readonly targetPath?: string;
  /** Template that failed to generate */
  public readonly templateId?: string;

  constructor(message: string, templateId?: string, targetPath?: string, cause?: Error) {
    super(message, 'TEMPLATE_GENERATION_ERROR', cause);
    this.name = 'TemplateGenerationError';
    this.templateId = templateId;
    this.targetPath = targetPath;
  }
}

/**
 * Built-in template constants based on Python implementation.
 */
export const BUILT_IN_TEMPLATES = {
  /** Main task initialization template */
  INIT: 'init.md',
  /** Agent prompt template */
  PROMPT: 'prompt.md',
  /** Project plan template */
  PLAN: 'plan.md',
  /** User feedback template */
  USER_FEEDBACK: 'USER_FEEDBACK.md',
  /** Claude session documentation */
  CLAUDE: 'CLAUDE.md',
  /** Agent comparison documentation */
  AGENTS: 'AGENTS.md',
  /** Specifications README */
  SPECS_README: 'specs/README.md',
  /** Requirements specification */
  REQUIREMENTS: 'specs/requirements.md',
  /** Architecture specification */
  ARCHITECTURE: 'specs/architecture.md'
} as const;

/**
 * Default template variables based on Python implementation.
 */
export const DEFAULT_TEMPLATE_VARIABLES = {
  /** Core variables */
  CORE: {
    TASK: 'Define your main task objective here',
    SUBAGENT: 'claude',
    GIT_URL: 'https://github.com/owner/repo'
  },
  /** Project variables */
  PROJECT: {
    PROJECT_PHASE: 'Development',
    CURRENT_PRIORITY: 'Priority 1',
    AUTHOR: 'Anonymous',
    EMAIL: 'author@example.com',
    LICENSE: 'MIT',
    DESCRIPTION: 'A juno-code project',
    VERSION: '0.1.0'
  }
} as const;

/**
 * Valid subagent choices based on Python implementation.
 */
export const VALID_SUBAGENTS = ['claude', 'gemini', 'cursor', 'codex'] as const;

/**
 * Valid license choices for projects.
 */
export const VALID_LICENSES = ['MIT', 'Apache-2.0', 'GPL-3.0', 'BSD-3-Clause', 'Proprietary'] as const;

/**
 * Template file extension mappings.
 */
export const TEMPLATE_EXTENSIONS = {
  MARKDOWN: '.md',
  HANDLEBARS: '.hbs',
  TEXT: '.txt',
  JSON: '.json',
  YAML: '.yml',
  TYPESCRIPT: '.ts',
  JAVASCRIPT: '.js'
} as const;

/**
 * Variable category definitions based on Python implementation.
 */
export interface VariableCategory {
  readonly name: string;
  readonly description: string;
  readonly variables: Record<string, Omit<TemplateVariable, 'name'>>;
  readonly required: boolean;
}

/**
 * Predefined variable categories from Python implementation.
 */
export const VARIABLE_CATEGORIES: Record<string, VariableCategory> = {
  core: {
    name: 'Core',
    description: 'Essential variables required for template generation',
    required: true,
    variables: {
      TASK: {
        description: 'Main task description',
        type: 'text',
        defaultValue: 'Define your main task objective here',
        required: true
      },
      SUBAGENT: {
        description: 'Preferred AI subagent',
        type: 'subagent',
        defaultValue: 'claude',
        required: true,
        choices: VALID_SUBAGENTS
      },
      GIT_URL: {
        description: 'Git repository URL',
        type: 'url',
        defaultValue: 'https://github.com/owner/repo',
        required: true
      }
    }
  },
  project: {
    name: 'Project',
    description: 'Project-specific configuration variables',
    required: false,
    variables: {
      PROJECT_NAME: {
        description: 'Project name',
        type: 'identifier',
        required: true
      },
      PACKAGE_NAME: {
        description: 'Package name (derived from project name)',
        type: 'identifier',
        required: false
      },
      PROJECT_PATH: {
        description: 'Project root directory',
        type: 'path',
        required: true
      },
      VENV_PATH: {
        description: 'Virtual environment path',
        type: 'path',
        required: true
      }
    }
  },
  optional: {
    name: 'Optional',
    description: 'Optional project metadata variables',
    required: false,
    variables: {
      AUTHOR: {
        description: 'Project author name',
        type: 'text',
        defaultValue: 'Anonymous',
        required: false
      },
      EMAIL: {
        description: 'Author email address',
        type: 'email',
        defaultValue: 'author@example.com',
        required: false
      },
      LICENSE: {
        description: 'Project license',
        type: 'choice',
        defaultValue: 'MIT',
        required: false,
        choices: VALID_LICENSES
      },
      DESCRIPTION: {
        description: 'Project description',
        type: 'text',
        defaultValue: 'A juno-code project',
        required: false
      },
      VERSION: {
        description: 'Initial version',
        type: 'version',
        defaultValue: '0.1.0',
        required: false
      }
    }
  }
} as const;

/**
 * Type guard to check if a value is a valid VariableType.
 */
export function isVariableType(value: unknown): value is VariableType {
  return typeof value === 'string' && [
    'text', 'email', 'url', 'identifier', 'version', 'path',
    'subagent', 'choice', 'boolean', 'number', 'date', 'timestamp'
  ].includes(value);
}

/**
 * Type guard to check if a value is a valid TemplateCategory.
 */
export function isTemplateCategory(value: unknown): value is TemplateCategory {
  return Object.values(TemplateCategory).includes(value as TemplateCategory);
}

/**
 * Type guard to check if an object implements the Template interface.
 */
export function isTemplate(value: unknown): value is Template {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === 'string' &&
    typeof obj.name === 'string' &&
    typeof obj.description === 'string' &&
    isTemplateCategory(obj.category) &&
    typeof obj.content === 'string' &&
    Array.isArray(obj.variables) &&
    typeof obj.version === 'string'
  );
}

/**
 * Type guard to check if an object implements the TemplateContext interface.
 */
export function isTemplateContext(value: unknown): value is TemplateContext {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const obj = value as Record<string, unknown>;
  return (
    typeof obj.variables === 'object' &&
    typeof obj.environment === 'object' &&
    typeof obj.project === 'object' &&
    typeof obj.git === 'object' &&
    obj.timestamp instanceof Date
  );
}