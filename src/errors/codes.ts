/**
 * Error Codes for Unified Error Hierarchy
 *
 * Standardized error codes using hierarchical naming convention:
 * CATEGORY_SUBCATEGORY_SPECIFIC
 *
 * This provides consistent error identification across all modules
 * while maintaining compatibility with existing MCP error codes.
 */

/**
 * Comprehensive error codes for all juno-task-ts modules
 */
export enum ErrorCode {
  // ============================================================================
  // SYSTEM ERRORS (File system, OS, hardware)
  // ============================================================================

  /** File or directory not found */
  SYSTEM_FILE_NOT_FOUND = 'SYSTEM_FILE_NOT_FOUND',

  /** Permission denied for file/directory operation */
  SYSTEM_PERMISSION_DENIED = 'SYSTEM_PERMISSION_DENIED',

  /** Disk space insufficient */
  SYSTEM_DISK_FULL = 'SYSTEM_DISK_FULL',

  /** File or directory already exists */
  SYSTEM_ALREADY_EXISTS = 'SYSTEM_ALREADY_EXISTS',

  /** File system operation failed */
  SYSTEM_IO_ERROR = 'SYSTEM_IO_ERROR',

  /** Path is invalid or malformed */
  SYSTEM_INVALID_PATH = 'SYSTEM_INVALID_PATH',

  /** Resource is locked or busy */
  SYSTEM_RESOURCE_BUSY = 'SYSTEM_RESOURCE_BUSY',

  /** System resource exhausted */
  SYSTEM_RESOURCE_EXHAUSTED = 'SYSTEM_RESOURCE_EXHAUSTED',

  // ============================================================================
  // VALIDATION ERRORS (Input validation, schema validation)
  // ============================================================================

  /** Required field is missing */
  VALIDATION_REQUIRED_FIELD = 'VALIDATION_REQUIRED_FIELD',

  /** Field value has invalid format */
  VALIDATION_INVALID_FORMAT = 'VALIDATION_INVALID_FORMAT',

  /** Field value is out of allowed range */
  VALIDATION_OUT_OF_RANGE = 'VALIDATION_OUT_OF_RANGE',

  /** Field value doesn't match allowed options */
  VALIDATION_INVALID_CHOICE = 'VALIDATION_INVALID_CHOICE',

  /** Schema validation failed */
  VALIDATION_SCHEMA_ERROR = 'VALIDATION_SCHEMA_ERROR',

  /** Type validation failed */
  VALIDATION_TYPE_ERROR = 'VALIDATION_TYPE_ERROR',

  /** Constraint validation failed */
  VALIDATION_CONSTRAINT_ERROR = 'VALIDATION_CONSTRAINT_ERROR',

  /** Cross-field validation failed */
  VALIDATION_DEPENDENCY_ERROR = 'VALIDATION_DEPENDENCY_ERROR',

  // ============================================================================
  // CONFIGURATION ERRORS (Config files, setup, initialization)
  // ============================================================================

  /** Configuration file not found */
  CONFIG_FILE_NOT_FOUND = 'CONFIG_FILE_NOT_FOUND',

  /** Configuration file has invalid syntax */
  CONFIG_INVALID_SYNTAX = 'CONFIG_INVALID_SYNTAX',

  /** Configuration file has invalid schema */
  CONFIG_INVALID_SCHEMA = 'CONFIG_INVALID_SCHEMA',

  /** Required configuration option missing */
  CONFIG_MISSING_OPTION = 'CONFIG_MISSING_OPTION',

  /** Configuration option has invalid value */
  CONFIG_INVALID_VALUE = 'CONFIG_INVALID_VALUE',

  /** Configuration file cannot be loaded */
  CONFIG_LOAD_ERROR = 'CONFIG_LOAD_ERROR',

  /** Configuration file cannot be saved */
  CONFIG_SAVE_ERROR = 'CONFIG_SAVE_ERROR',

  /** Configuration migration failed */
  CONFIG_MIGRATION_ERROR = 'CONFIG_MIGRATION_ERROR',

  // ============================================================================
  // MCP ERRORS (Model Context Protocol server interactions)
  // ============================================================================

  /** Failed to connect to MCP server */
  MCP_CONNECTION_FAILED = 'MCP_CONNECTION_FAILED',

  /** Connection to MCP server lost */
  MCP_CONNECTION_LOST = 'MCP_CONNECTION_LOST',

  /** MCP server connection timeout */
  MCP_CONNECTION_TIMEOUT = 'MCP_CONNECTION_TIMEOUT',

  /** MCP tool execution failed */
  MCP_TOOL_EXECUTION_FAILED = 'MCP_TOOL_EXECUTION_FAILED',

  /** MCP tool not found */
  MCP_TOOL_NOT_FOUND = 'MCP_TOOL_NOT_FOUND',

  /** MCP operation timeout */
  MCP_OPERATION_TIMEOUT = 'MCP_OPERATION_TIMEOUT',

  /** MCP rate limit exceeded */
  MCP_RATE_LIMIT_EXCEEDED = 'MCP_RATE_LIMIT_EXCEEDED',

  /** MCP server authentication failed */
  MCP_AUTH_FAILED = 'MCP_AUTH_FAILED',

  /** MCP server configuration invalid */
  MCP_CONFIG_INVALID = 'MCP_CONFIG_INVALID',

  /** MCP server not responding */
  MCP_SERVER_UNRESPONSIVE = 'MCP_SERVER_UNRESPONSIVE',

  /** MCP protocol version mismatch */
  MCP_VERSION_MISMATCH = 'MCP_VERSION_MISMATCH',

  /** MCP server returned invalid response */
  MCP_INVALID_RESPONSE = 'MCP_INVALID_RESPONSE',

  // ============================================================================
  // TEMPLATE ERRORS (Template processing and generation)
  // ============================================================================

  /** Template file not found */
  TEMPLATE_NOT_FOUND = 'TEMPLATE_NOT_FOUND',

  /** Template syntax error */
  TEMPLATE_SYNTAX_ERROR = 'TEMPLATE_SYNTAX_ERROR',

  /** Template variable not defined */
  TEMPLATE_VARIABLE_UNDEFINED = 'TEMPLATE_VARIABLE_UNDEFINED',

  /** Template variable has invalid value */
  TEMPLATE_VARIABLE_INVALID = 'TEMPLATE_VARIABLE_INVALID',

  /** Template compilation failed */
  TEMPLATE_COMPILATION_FAILED = 'TEMPLATE_COMPILATION_FAILED',

  /** Template rendering failed */
  TEMPLATE_RENDER_FAILED = 'TEMPLATE_RENDER_FAILED',

  /** Template generation failed */
  TEMPLATE_GENERATION_FAILED = 'TEMPLATE_GENERATION_FAILED',

  /** Template helper function error */
  TEMPLATE_HELPER_ERROR = 'TEMPLATE_HELPER_ERROR',

  // ============================================================================
  // SESSION ERRORS (Session management and state)
  // ============================================================================

  /** Session not found */
  SESSION_NOT_FOUND = 'SESSION_NOT_FOUND',

  /** Session already exists */
  SESSION_ALREADY_EXISTS = 'SESSION_ALREADY_EXISTS',

  /** Session has expired */
  SESSION_EXPIRED = 'SESSION_EXPIRED',

  /** Session is invalid */
  SESSION_INVALID = 'SESSION_INVALID',

  /** Session creation failed */
  SESSION_CREATION_FAILED = 'SESSION_CREATION_FAILED',

  /** Session state corruption */
  SESSION_CORRUPTED = 'SESSION_CORRUPTED',

  /** Session serialization failed */
  SESSION_SERIALIZE_ERROR = 'SESSION_SERIALIZE_ERROR',

  /** Session deserialization failed */
  SESSION_DESERIALIZE_ERROR = 'SESSION_DESERIALIZE_ERROR',

  // ============================================================================
  // CLI ERRORS (Command-line interface)
  // ============================================================================

  /** Command not found */
  CLI_COMMAND_NOT_FOUND = 'CLI_COMMAND_NOT_FOUND',

  /** Invalid command arguments */
  CLI_INVALID_ARGUMENTS = 'CLI_INVALID_ARGUMENTS',

  /** Missing required arguments */
  CLI_MISSING_ARGUMENTS = 'CLI_MISSING_ARGUMENTS',

  /** Command execution failed */
  CLI_EXECUTION_FAILED = 'CLI_EXECUTION_FAILED',

  /** Command interrupted */
  CLI_INTERRUPTED = 'CLI_INTERRUPTED',

  /** Command timeout */
  CLI_TIMEOUT = 'CLI_TIMEOUT',

  /** Help system error */
  CLI_HELP_ERROR = 'CLI_HELP_ERROR',

  /** Command parsing error */
  CLI_PARSE_ERROR = 'CLI_PARSE_ERROR',

  // ============================================================================
  // TUI ERRORS (Terminal user interface)
  // ============================================================================

  /** TUI rendering failed */
  TUI_RENDER_ERROR = 'TUI_RENDER_ERROR',

  /** TUI input handling failed */
  TUI_INPUT_ERROR = 'TUI_INPUT_ERROR',

  /** TUI component error */
  TUI_COMPONENT_ERROR = 'TUI_COMPONENT_ERROR',

  /** TUI layout error */
  TUI_LAYOUT_ERROR = 'TUI_LAYOUT_ERROR',

  /** TUI not available in environment */
  TUI_NOT_AVAILABLE = 'TUI_NOT_AVAILABLE',

  /** TUI context error */
  TUI_CONTEXT_ERROR = 'TUI_CONTEXT_ERROR',

  /** TUI navigation error */
  TUI_NAVIGATION_ERROR = 'TUI_NAVIGATION_ERROR',

  /** TUI state management error */
  TUI_STATE_ERROR = 'TUI_STATE_ERROR',

  // ============================================================================
  // NETWORK ERRORS (Network connectivity and requests)
  // ============================================================================

  /** Network connection failed */
  NETWORK_CONNECTION_FAILED = 'NETWORK_CONNECTION_FAILED',

  /** Network timeout */
  NETWORK_TIMEOUT = 'NETWORK_TIMEOUT',

  /** DNS resolution failed */
  NETWORK_DNS_ERROR = 'NETWORK_DNS_ERROR',

  /** Network unreachable */
  NETWORK_UNREACHABLE = 'NETWORK_UNREACHABLE',

  /** SSL/TLS certificate error */
  NETWORK_SSL_ERROR = 'NETWORK_SSL_ERROR',

  /** Proxy error */
  NETWORK_PROXY_ERROR = 'NETWORK_PROXY_ERROR',

  /** HTTP error response */
  NETWORK_HTTP_ERROR = 'NETWORK_HTTP_ERROR',

  /** Request interrupted */
  NETWORK_REQUEST_INTERRUPTED = 'NETWORK_REQUEST_INTERRUPTED',

  // ============================================================================
  // SECURITY ERRORS (Security and permissions)
  // ============================================================================

  /** Authentication failed */
  SECURITY_AUTH_FAILED = 'SECURITY_AUTH_FAILED',

  /** Authorization denied */
  SECURITY_AUTH_DENIED = 'SECURITY_AUTH_DENIED',

  /** Invalid credentials */
  SECURITY_INVALID_CREDENTIALS = 'SECURITY_INVALID_CREDENTIALS',

  /** Token expired */
  SECURITY_TOKEN_EXPIRED = 'SECURITY_TOKEN_EXPIRED',

  /** Invalid token */
  SECURITY_INVALID_TOKEN = 'SECURITY_INVALID_TOKEN',

  /** Security policy violation */
  SECURITY_POLICY_VIOLATION = 'SECURITY_POLICY_VIOLATION',

  /** Encryption failed */
  SECURITY_ENCRYPTION_FAILED = 'SECURITY_ENCRYPTION_FAILED',

  /** Decryption failed */
  SECURITY_DECRYPTION_FAILED = 'SECURITY_DECRYPTION_FAILED',

  // ============================================================================
  // INTERNAL ERRORS (Application internal errors)
  // ============================================================================

  /** Unexpected internal error */
  INTERNAL_UNEXPECTED_ERROR = 'INTERNAL_UNEXPECTED_ERROR',

  /** Assertion failure */
  INTERNAL_ASSERTION_FAILED = 'INTERNAL_ASSERTION_FAILED',

  /** Invalid state */
  INTERNAL_INVALID_STATE = 'INTERNAL_INVALID_STATE',

  /** Not implemented */
  INTERNAL_NOT_IMPLEMENTED = 'INTERNAL_NOT_IMPLEMENTED',

  /** Memory allocation failed */
  INTERNAL_MEMORY_ERROR = 'INTERNAL_MEMORY_ERROR',

  /** Threading error */
  INTERNAL_THREAD_ERROR = 'INTERNAL_THREAD_ERROR',

  /** Deadlock detected */
  INTERNAL_DEADLOCK = 'INTERNAL_DEADLOCK',

  /** Resource leak detected */
  INTERNAL_RESOURCE_LEAK = 'INTERNAL_RESOURCE_LEAK'
}

/**
 * Error code categories mapping for quick lookup
 */
export const ERROR_CODE_CATEGORIES: Record<string, string> = {
  SYSTEM: 'system',
  VALIDATION: 'validation',
  CONFIG: 'configuration',
  MCP: 'mcp',
  TEMPLATE: 'template',
  SESSION: 'session',
  CLI: 'cli',
  TUI: 'tui',
  NETWORK: 'network',
  SECURITY: 'security',
  INTERNAL: 'internal'
};

/**
 * Get the category from an error code
 */
export function getErrorCodeCategory(code: ErrorCode): string {
  const prefix = code.split('_')[0];
  return ERROR_CODE_CATEGORIES[prefix] || 'unknown';
}

/**
 * Check if an error code indicates a retriable error
 */
export function isRetriableErrorCode(code: ErrorCode): boolean {
  const retriableCodes = [
    ErrorCode.SYSTEM_RESOURCE_BUSY,
    ErrorCode.MCP_CONNECTION_TIMEOUT,
    ErrorCode.MCP_OPERATION_TIMEOUT,
    ErrorCode.MCP_RATE_LIMIT_EXCEEDED,
    ErrorCode.MCP_SERVER_UNRESPONSIVE,
    ErrorCode.NETWORK_CONNECTION_FAILED,
    ErrorCode.NETWORK_TIMEOUT,
    ErrorCode.NETWORK_DNS_ERROR,
    ErrorCode.NETWORK_UNREACHABLE,
    ErrorCode.NETWORK_REQUEST_INTERRUPTED
  ];

  return retriableCodes.includes(code);
}

/**
 * Check if an error code indicates a user intervention required
 */
export function requiresUserIntervention(code: ErrorCode): boolean {
  const userInterventionCodes = [
    ErrorCode.SYSTEM_PERMISSION_DENIED,
    ErrorCode.VALIDATION_REQUIRED_FIELD,
    ErrorCode.VALIDATION_INVALID_FORMAT,
    ErrorCode.CONFIG_FILE_NOT_FOUND,
    ErrorCode.CONFIG_INVALID_SYNTAX,
    ErrorCode.CONFIG_MISSING_OPTION,
    ErrorCode.MCP_AUTH_FAILED,
    ErrorCode.MCP_CONFIG_INVALID,
    ErrorCode.CLI_COMMAND_NOT_FOUND,
    ErrorCode.CLI_INVALID_ARGUMENTS,
    ErrorCode.CLI_MISSING_ARGUMENTS,
    ErrorCode.SECURITY_AUTH_FAILED,
    ErrorCode.SECURITY_INVALID_CREDENTIALS
  ];

  return userInterventionCodes.includes(code);
}