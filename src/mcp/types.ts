/**
 * Model Context Protocol (MCP) TypeScript type definitions for juno-task-ts
 *
 * This module provides comprehensive TypeScript types for MCP integration,
 * supporting the @modelcontextprotocol/sdk with the exact progress callback
 * patterns identified in the Python budi-cli implementation.
 *
 * @module MCPTypes
 * @since 1.0.0
 */

// =============================================================================
// Core Types & Enums
// =============================================================================

/**
 * Supported subagent types for MCP tool mapping
 */
export type SubagentType = 'claude' | 'cursor' | 'codex' | 'gemini';

/**
 * Extended subagent aliases for flexible naming
 */
export type SubagentAlias =
  | 'claude-code'
  | 'claude_code'
  | 'gemini-cli'
  | 'cursor-agent';

/**
 * MCP connection state lifecycle
 */
export enum MCPConnectionState {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  RECONNECTING = 'reconnecting',
  FAILED = 'failed',
  CLOSING = 'closing'
}

/**
 * Progress event types from Roundtable MCP server format
 */
export enum ProgressEventType {
  TOOL_START = 'tool_start',
  TOOL_RESULT = 'tool_result',
  THINKING = 'thinking',
  ERROR = 'error',
  INFO = 'info',
  DEBUG = 'debug'
}

/**
 * MCP error categories for targeted error handling
 */
export enum MCPErrorType {
  CONNECTION = 'connection',
  TIMEOUT = 'timeout',
  RATE_LIMIT = 'rate_limit',
  TOOL_EXECUTION = 'tool_execution',
  VALIDATION = 'validation',
  SERVER_NOT_FOUND = 'server_not_found',
  PROTOCOL = 'protocol',
  AUTHENTICATION = 'authentication'
}

/**
 * Tool execution status for tracking
 */
export enum ToolExecutionStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
  TIMEOUT = 'timeout'
}

// =============================================================================
// Configuration Types
// =============================================================================

/**
 * Core MCP server configuration interface
 *
 * @example
 * ```typescript
 * const config: MCPServerConfig = {
 *   serverPath: './roundtable_mcp_server',
 *   timeout: 3600,
 *   retries: 3,
 *   retryDelay: 1000,
 *   workingDirectory: process.cwd(),
 *   environment: {
 *     'ROUNDTABLE_API_KEY': 'your-key'
 *   }
 * };
 * ```
 */
export interface MCPServerConfig {
  /** Optional path to MCP server executable - will auto-discover if not provided */
  readonly serverPath?: string;

  /** Tool execution timeout in milliseconds (default: 3600000ms = 1 hour) */
  readonly timeout: number;

  /** Maximum retry attempts for failed operations (default: 3) */
  readonly retries: number;

  /** Delay between retry attempts in milliseconds (default: 1000ms) */
  readonly retryDelay: number;

  /** Working directory for server process execution */
  readonly workingDirectory: string;

  /** Additional environment variables for server process */
  readonly environment?: Readonly<Record<string, string>>;

  /** Custom server arguments (advanced usage) */
  readonly serverArgs?: readonly string[];

  /** Enable debug logging for MCP communications */
  readonly debug?: boolean;

  /** Maximum memory usage for server process in MB */
  readonly maxMemoryMB?: number;

  /** Process priority for server subprocess */
  readonly processPriority?: 'low' | 'normal' | 'high';
}

/**
 * Connection retry configuration with exponential backoff
 */
export interface RetryConfig {
  /** Maximum number of retry attempts */
  readonly maxRetries: number;

  /** Initial delay between retries in milliseconds */
  readonly initialDelay: number;

  /** Maximum delay between retries in milliseconds */
  readonly maxDelay: number;

  /** Exponential backoff multiplier */
  readonly backoffMultiplier: number;

  /** Jitter factor to randomize retry timing (0-1) */
  readonly jitterFactor: number;

  /** Custom retry condition predicate */
  readonly shouldRetry?: (error: Error, attempt: number) => boolean;
}

/**
 * Rate limiting configuration and state
 */
export interface RateLimitConfig {
  /** Maximum requests per time window */
  readonly maxRequests: number;

  /** Time window in milliseconds */
  readonly windowMs: number;

  /** Burst allowance for short-term spikes */
  readonly burstAllowance: number;

  /** Enable adaptive rate limiting based on server responses */
  readonly adaptive: boolean;
}

// =============================================================================
// Progress Tracking Types
// =============================================================================

/**
 * Progress event interface matching Roundtable MCP server format
 * Format: "Backend #count: event_type => content"
 *
 * @example
 * ```typescript
 * const progressEvent: ProgressEvent = {
 *   sessionId: 'session-123',
 *   timestamp: new Date(),
 *   backend: 'claude',
 *   count: 1,
 *   type: ProgressEventType.TOOL_START,
 *   content: 'Starting code analysis...',
 *   toolId: 'claude_1',
 *   metadata: {
 *     duration: 150,
 *     tokens: 1024
 *   }
 * };
 * ```
 */
export interface ProgressEvent {
  /** Unique session identifier for correlation */
  readonly sessionId: string;

  /** Event timestamp */
  readonly timestamp: Date;

  /** Subagent backend name (claude, cursor, codex, gemini) */
  readonly backend: string;

  /** Sequential event number within session */
  readonly count: number;

  /** Progress event classification */
  readonly type: ProgressEventType;

  /** Event content/message from subagent */
  readonly content: string;

  /** Generated tool correlation ID for tracking */
  readonly toolId: string;

  /** Additional event metadata */
  readonly metadata?: Readonly<Record<string, unknown>>;

  /** Parent event ID for nested operations */
  readonly parentId?: string;

  /** Event priority level */
  readonly priority?: 'low' | 'normal' | 'high';
}

/**
 * Progress callback function signature
 * Callbacks must never throw errors to avoid breaking execution flow
 *
 * @param event - The progress event to handle
 * @returns Promise<void> - Should handle errors internally
 */
export type ProgressCallback = (event: ProgressEvent) => Promise<void> | void;

/**
 * Progress metadata for context tracking
 */
export interface ProgressMetadata {
  /** Operation start time */
  readonly startTime: Date;

  /** Total events processed */
  readonly eventCount: number;

  /** Last event timestamp */
  readonly lastEventTime?: Date;

  /** Operation context */
  readonly context: string;

  /** User-defined tags for categorization */
  readonly tags?: readonly string[];

  /** Performance metrics */
  readonly metrics?: ProgressMetrics;
}

/**
 * Performance metrics for progress tracking
 */
export interface ProgressMetrics {
  /** Average event processing time in milliseconds */
  readonly avgProcessingTime: number;

  /** Events processed per second */
  readonly eventsPerSecond: number;

  /** Memory usage in bytes */
  readonly memoryUsage: number;

  /** CPU usage percentage */
  readonly cpuUsage: number;
}

// =============================================================================
// Tool Execution Types
// =============================================================================

/**
 * Tool call request structure
 *
 * @example
 * ```typescript
 * const request: ToolCallRequest = {
 *   toolName: 'claude_subagent',
 *   arguments: {
 *     instruction: 'Analyze this code',
 *     project_path: '/path/to/project',
 *     model: 'sonnet-4'
 *   },
 *   timeout: 30000,
 *   priority: 'high',
 *   metadata: {
 *     userId: 'user-123',
 *     sessionId: 'session-456'
 *   }
 * };
 * ```
 */
export interface ToolCallRequest {
  /** MCP tool name (mapped from subagent name) */
  readonly toolName: string;

  /** Tool arguments object */
  readonly arguments: Readonly<Record<string, unknown>>;

  /** Request timeout in milliseconds */
  readonly timeout?: number;

  /** Request priority level */
  readonly priority?: 'low' | 'normal' | 'high';

  /** Additional request metadata */
  readonly metadata?: Readonly<Record<string, unknown>>;

  /** Callback for progress events */
  readonly progressCallback?: ProgressCallback;

  /** Unique request identifier */
  readonly requestId?: string;
}

/**
 * Tool call result structure
 */
export interface ToolCallResult {
  /** Tool execution result content */
  readonly content: string;

  /** Execution status */
  readonly status: ToolExecutionStatus;

  /** Execution start time */
  readonly startTime: Date;

  /** Execution end time */
  readonly endTime: Date;

  /** Total execution duration in milliseconds */
  readonly duration: number;

  /** Any error that occurred during execution */
  readonly error?: Error;

  /** Progress events generated during execution */
  readonly progressEvents: readonly ProgressEvent[];

  /** Tool execution metadata */
  readonly metadata?: ToolExecutionMetadata;

  /** Request that generated this result */
  readonly request: ToolCallRequest;
}

/**
 * Tool execution metadata
 */
export interface ToolExecutionMetadata {
  /** Number of tokens used */
  readonly tokensUsed?: number;

  /** Estimated cost */
  readonly estimatedCost?: number;

  /** Model used for execution */
  readonly model?: string;

  /** Server version */
  readonly serverVersion?: string;

  /** Performance metrics */
  readonly performanceMetrics?: ToolPerformanceMetrics;

  /** Raw subagent response payload (for programmatic capture / session resume) */
  readonly subAgentResponse?: any;

  /** Indicates the content string is structured (e.g., JSON) and safe to parse */
  readonly structuredOutput?: boolean;

  /** Content type for the tool output (e.g., application/json) */
  readonly contentType?: string;

  /** Original raw output emitted by the tool (pre-structuring) */
  readonly rawOutput?: string;
}

/**
 * Tool performance metrics
 */
export interface ToolPerformanceMetrics {
  /** CPU usage during execution */
  readonly cpuUsage: number;

  /** Memory usage during execution */
  readonly memoryUsage: number;

  /** Network usage in bytes */
  readonly networkUsage: number;

  /** Processing time breakdown */
  readonly timingBreakdown: Record<string, number>;
}

// =============================================================================
// Subagent Integration Types
// =============================================================================

/**
 * Subagent information and capabilities
 */
export interface SubagentInfo {
  /** Subagent identifier */
  readonly id: SubagentType;

  /** Display name */
  readonly name: string;

  /** Supported capabilities */
  readonly capabilities: readonly SubagentCapability[];

  /** Available models */
  readonly models: readonly string[];

  /** Default model */
  readonly defaultModel: string;

  /** Current availability status */
  readonly status: SubagentStatus;

  /** Rate limiting information */
  readonly rateLimits?: RateLimitInfo;

  /** Performance characteristics */
  readonly performance?: SubagentPerformance;
}

/**
 * Subagent capability types
 */
export enum SubagentCapability {
  CODE_GENERATION = 'code_generation',
  CODE_ANALYSIS = 'code_analysis',
  DEBUGGING = 'debugging',
  REFACTORING = 'refactoring',
  DOCUMENTATION = 'documentation',
  TESTING = 'testing',
  ARCHITECTURE = 'architecture',
  REVIEW = 'review'
}

/**
 * Subagent status
 */
export enum SubagentStatus {
  AVAILABLE = 'available',
  BUSY = 'busy',
  RATE_LIMITED = 'rate_limited',
  UNAVAILABLE = 'unavailable',
  ERROR = 'error',
  MAINTENANCE = 'maintenance'
}

/**
 * Rate limit information
 */
export interface RateLimitInfo {
  /** Requests remaining in current window */
  readonly remaining: number;

  /** Total requests allowed per window */
  readonly limit: number;

  /** Window reset time */
  readonly resetTime: Date;

  /** Current rate limit tier */
  readonly tier: string;
}

/**
 * Subagent performance characteristics
 */
export interface SubagentPerformance {
  /** Average response time in milliseconds */
  readonly avgResponseTime: number;

  /** Success rate percentage */
  readonly successRate: number;

  /** Current load level */
  readonly loadLevel: 'low' | 'medium' | 'high';

  /** Quality score (0-100) */
  readonly qualityScore: number;
}

/**
 * Subagent tool mapping configuration
 */
export interface SubagentMapper {
  /** Core subagent to tool name mapping */
  readonly mapping: Readonly<Record<SubagentType, string>>;

  /** Alias to subagent mapping */
  readonly aliases: Readonly<Record<SubagentAlias, SubagentType>>;

  /** Model validation rules */
  readonly modelValidation: Readonly<Record<SubagentType, ModelValidationRule>>;

  /** Default configurations per subagent */
  readonly defaults: Readonly<Record<SubagentType, SubagentDefaults>>;
}

/**
 * Model validation rule
 */
export interface ModelValidationRule {
  /** Allowed models for this subagent */
  readonly allowedModels: readonly string[];

  /** Default model if none specified */
  readonly defaultModel: string;

  /** Custom validation function */
  readonly customValidator?: (model: string) => boolean;
}

/**
 * Default subagent configuration
 */
export interface SubagentDefaults {
  /** Default timeout in milliseconds */
  readonly timeout: number;

  /** Default model */
  readonly model: string;

  /** Default arguments */
  readonly arguments: Readonly<Record<string, unknown>>;

  /** Default priority */
  readonly priority: 'low' | 'normal' | 'high';
}

// =============================================================================
// Connection Management Types
// =============================================================================

/**
 * Connection lifecycle event
 */
export interface ConnectionEvent {
  /** Event type */
  readonly type: ConnectionEventType;

  /** Event timestamp */
  readonly timestamp: Date;

  /** Connection state after event */
  readonly state: MCPConnectionState;

  /** Event details */
  readonly details?: string;

  /** Error information if applicable */
  readonly error?: Error;
}

/**
 * Connection event types
 */
export enum ConnectionEventType {
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  DISCONNECTED = 'disconnected',
  RECONNECTING = 'reconnecting',
  ERROR = 'error',
  TIMEOUT = 'timeout',
  RATE_LIMITED = 'rate_limited'
}

/**
 * Connection health monitoring
 */
export interface ConnectionHealth {
  /** Current connection state */
  readonly state: MCPConnectionState;

  /** Connection uptime in milliseconds */
  readonly uptime: number;

  /** Number of successful operations */
  readonly successfulOperations: number;

  /** Number of failed operations */
  readonly failedOperations: number;

  /** Average response time */
  readonly avgResponseTime: number;

  /** Last successful operation time */
  readonly lastSuccessTime?: Date;

  /** Last error time */
  readonly lastErrorTime?: Date;

  /** Current error streak */
  readonly errorStreak: number;
}

/**
 * Connection recovery strategy
 */
export interface RecoveryStrategy {
  /** Strategy type */
  readonly type: RecoveryStrategyType;

  /** Strategy configuration */
  readonly config: RecoveryConfig;

  /** Custom recovery function */
  readonly customRecovery?: () => Promise<boolean>;
}

/**
 * Recovery strategy types
 */
export enum RecoveryStrategyType {
  IMMEDIATE_RETRY = 'immediate_retry',
  EXPONENTIAL_BACKOFF = 'exponential_backoff',
  CIRCUIT_BREAKER = 'circuit_breaker',
  GRACEFUL_DEGRADATION = 'graceful_degradation',
  CUSTOM = 'custom'
}

/**
 * Recovery configuration
 */
export interface RecoveryConfig {
  /** Maximum recovery attempts */
  readonly maxAttempts: number;

  /** Recovery timeout */
  readonly timeout: number;

  /** Strategy-specific parameters */
  readonly parameters: Readonly<Record<string, unknown>>;
}

// =============================================================================
// Session Integration Types
// =============================================================================

/**
 * MCP session context
 */
export interface MCPSessionContext {
  /** Unique session identifier */
  readonly sessionId: string;

  /** Session start time */
  readonly startTime: Date;

  /** User identifier */
  readonly userId?: string;

  /** Session metadata */
  readonly metadata: Readonly<Record<string, unknown>>;

  /** Active tool calls */
  readonly activeToolCalls: readonly string[];

  /** Session state */
  readonly state: SessionState;

  /** Last activity time */
  readonly lastActivity: Date;
}

/**
 * Session state
 */
export enum SessionState {
  INITIALIZING = 'initializing',
  ACTIVE = 'active',
  IDLE = 'idle',
  SUSPENDED = 'suspended',
  COMPLETED = 'completed',
  FAILED = 'failed'
}

/**
 * Session persistence configuration
 */
export interface SessionPersistence {
  /** Enable session persistence */
  readonly enabled: boolean;

  /** Storage backend type */
  readonly storageType: SessionStorageType;

  /** Storage configuration */
  readonly storageConfig: SessionStorageConfig;

  /** Session TTL in milliseconds */
  readonly ttlMs: number;

  /** Auto-cleanup interval */
  readonly cleanupIntervalMs: number;
}

/**
 * Session storage types
 */
export enum SessionStorageType {
  MEMORY = 'memory',
  FILE = 'file',
  DATABASE = 'database',
  REDIS = 'redis'
}

/**
 * Session storage configuration
 */
export interface SessionStorageConfig {
  /** Storage-specific parameters */
  readonly parameters: Readonly<Record<string, unknown>>;

  /** Encryption configuration */
  readonly encryption?: EncryptionConfig;

  /** Compression configuration */
  readonly compression?: CompressionConfig;
}

/**
 * Encryption configuration
 */
export interface EncryptionConfig {
  /** Encryption algorithm */
  readonly algorithm: string;

  /** Key derivation parameters */
  readonly keyDerivation: KeyDerivationConfig;
}

/**
 * Key derivation configuration
 */
export interface KeyDerivationConfig {
  /** KDF algorithm */
  readonly algorithm: string;

  /** Salt length */
  readonly saltLength: number;

  /** Iteration count */
  readonly iterations: number;
}

/**
 * Compression configuration
 */
export interface CompressionConfig {
  /** Compression algorithm */
  readonly algorithm: 'gzip' | 'deflate' | 'brotli';

  /** Compression level */
  readonly level: number;
}

// =============================================================================
// Error Types - Import from errors.ts
// =============================================================================

// Import error types from dedicated errors module
export type {
  MCPError,
  MCPConnectionError,
  MCPToolError,
  MCPTimeoutError,
  MCPRateLimitError,
  MCPValidationError,
  MCPErrorOptions,
  RetryInfo,
  ServerInfo,
  ToolInfo,
  ToolExecutionDetails,
} from './errors.js';

// =============================================================================
// Utility Types
// =============================================================================

/**
 * Type-safe event emitter interface for MCP events
 */
export interface MCPEventEmitter {
  on<T extends keyof MCPEventMap>(event: T, listener: MCPEventMap[T]): void;
  off<T extends keyof MCPEventMap>(event: T, listener: MCPEventMap[T]): void;
  emit<T extends keyof MCPEventMap>(event: T, ...args: Parameters<MCPEventMap[T]>): boolean;
}

/**
 * MCP event map for type-safe event handling
 */
export interface MCPEventMap {
  'connection:state': (state: MCPConnectionState) => void;
  'connection:error': (error: Error) => void;
  'progress:event': (event: ProgressEvent) => void;
  'tool:start': (request: ToolCallRequest) => void;
  'tool:complete': (result: ToolCallResult) => void;
  'tool:error': (error: Error) => void;
  'session:create': (context: MCPSessionContext) => void;
  'session:end': (sessionId: string) => void;
  'rate-limit:reached': (error: Error) => void;
}

/**
 * Utility type for making properties optional
 */
export type PartialBy<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

/**
 * Utility type for making properties required
 */
export type RequiredBy<T, K extends keyof T> = T & Required<Pick<T, K>>;

/**
 * Utility type for deep readonly
 */
export type DeepReadonly<T> = {
  readonly [P in keyof T]: T[P] extends object ? DeepReadonly<T[P]> : T[P];
};

/**
 * Utility type for extracting promise return type
 */
export type Awaited<T> = T extends Promise<infer U> ? U : T;

/**
 * Type guard for progress events
 */
export function isProgressEvent(obj: unknown): obj is ProgressEvent {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'sessionId' in obj &&
    'timestamp' in obj &&
    'backend' in obj &&
    'count' in obj &&
    'type' in obj &&
    'content' in obj &&
    'toolId' in obj
  );
}

// Import type guards from errors module
export { isMCPError } from './errors.js';

/**
 * Type guard for subagent types
 */
export function isSubagentType(value: string): value is SubagentType {
  return ['claude', 'cursor', 'codex', 'gemini'].includes(value);
}

/**
 * Type guard for connection states
 */
export function isConnectionState(value: string): value is MCPConnectionState {
  return Object.values(MCPConnectionState).includes(value as MCPConnectionState);
}

// =============================================================================
// Factory Types
// =============================================================================

/**
 * MCP client factory configuration
 */
export interface MCPClientFactory {
  /** Create MCP client with configuration */
  create(config: MCPServerConfig): Promise<MCPClient>;

  /** Create mock client for testing */
  createMock(mockConfig?: MockClientConfig): MockMCPClient;

  /** Validate configuration */
  validateConfig(config: MCPServerConfig): ValidationResult;
}

/**
 * Mock client configuration for testing
 */
export interface MockClientConfig {
  /** Predefined tool responses */
  readonly toolResponses: Readonly<Record<string, string>>;

  /** Simulated progress events */
  readonly progressEvents: readonly ProgressEvent[];

  /** Simulated errors */
  readonly errors: readonly Error[];

  /** Response delays */
  readonly responseDelays: Readonly<Record<string, number>>;
}

/**
 * Validation result
 */
export interface ValidationResult {
  /** Validation success */
  readonly valid: boolean;

  /** Validation errors */
  readonly errors: readonly string[];

  /** Validation warnings */
  readonly warnings: readonly string[];
}

/**
 * Abstract MCP client interface
 */
export interface MCPClient {
  /** Connect to MCP server */
  connect(): Promise<void>;

  /** Disconnect from MCP server */
  disconnect(): Promise<void>;

  /** Check connection status */
  isConnected(): boolean;

  /** Call tool with progress tracking */
  callTool(request: ToolCallRequest): Promise<ToolCallResult>;

  /** List available tools */
  listTools(): Promise<readonly string[]>;

  /** Get subagent information */
  getSubagentInfo(subagent: SubagentType): Promise<SubagentInfo>;

  /** Add progress callback */
  onProgress(callback: ProgressCallback): () => void;

  /** Get connection health */
  getHealth(): ConnectionHealth;

  /** Event emitter interface */
  on<T extends keyof MCPEventMap>(event: T, listener: MCPEventMap[T]): void;
  off<T extends keyof MCPEventMap>(event: T, listener: MCPEventMap[T]): void;
}

/**
 * Mock MCP client interface for testing
 */
export interface MockMCPClient extends MCPClient {
  /** Add mock tool response */
  addToolResponse(toolName: string, response: string): void;

  /** Simulate progress event */
  simulateProgressEvent(event: ProgressEvent): void;

  /** Simulate error */
  simulateError(error: Error): void;

  /** Reset mock state */
  reset(): void;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Default MCP configuration values
 */
export const MCP_DEFAULTS = {
  TIMEOUT: 3600000, // 1 hour
  RETRIES: 3,
  RETRY_DELAY: 1000, // 1 second
  MAX_MEMORY_MB: 512,
  PROCESS_PRIORITY: 'normal' as const,
  CONNECTION_TIMEOUT: 30000, // 30 seconds
  HEALTH_CHECK_INTERVAL: 60000, // 1 minute
  SESSION_TTL: 86400000, // 24 hours
  CLEANUP_INTERVAL: 3600000, // 1 hour
} as const;

/**
 * Subagent to tool mapping
 */
export const SUBAGENT_TOOL_MAPPING: Record<SubagentType, string> = {
  claude: 'claude_subagent',
  cursor: 'cursor_subagent',
  codex: 'codex_subagent',
  gemini: 'gemini_subagent',
} as const;

/**
 * Subagent alias mapping
 */
export const SUBAGENT_ALIASES: Record<SubagentAlias, SubagentType> = {
  'claude-code': 'claude',
  'claude_code': 'claude',
  'gemini-cli': 'gemini',
  'cursor-agent': 'cursor',
} as const;

/**
 * Progress event parsing patterns
 */
export const PROGRESS_PATTERNS = {
  /** Main progress message pattern: "Backend #count: event_type => content" */
  MAIN: /^(.+?)\s+#(\d+):\s+(\w+)\s*=>\s*(.+)$/,

  /** Tool call patterns for detection */
  TOOL_CALLS: [
    /calling\s+tool[:\s]*([a-zA-Z_][a-zA-Z0-9_]*)/i,
    /<function_calls>\s*<invoke name="([^"]+)"/i,
    /tool[:\s]*([a-zA-Z_][a-zA-Z0-9_]*)/i,
  ],

  /** Rate limit patterns */
  RATE_LIMITS: [
    /resets\s+(at\s+)?(\d{1,2}):(\d{2})\s*(am|pm)?/i,
    /resets\s+(at\s+)?(\d{1,2})\s*(am|pm)/i,
    /try again in (\d+)\s*(minutes?|hours?)/i,
    /5-hour limit reached.*resets\s+(at\s+)?(\d{1,2})\s*(am|pm)/i,
  ],
} as const;

// Note: All types and enums are already exported above via their declarations
