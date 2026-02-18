/**
 * Error Context and Metadata System
 *
 * Provides rich contextual information for errors to enable
 * better debugging, recovery, and user assistance.
 */

import { ErrorCategory, ErrorSeverity, ErrorPriority, ErrorHandlingStrategy } from './categories';
import { ErrorCode } from './codes';

/**
 * Rich error context containing all relevant information
 */
export interface ErrorContext {
  /** Primary error code */
  readonly code: ErrorCode;

  /** Error category */
  readonly category: ErrorCategory;

  /** Error severity level */
  readonly severity: ErrorSeverity;

  /** Error priority for handling */
  readonly priority: ErrorPriority;

  /** Recommended handling strategy */
  readonly strategy: ErrorHandlingStrategy;

  /** Component or module where error occurred */
  readonly component?: string;

  /** Operation being performed when error occurred */
  readonly operation?: string;

  /** Request ID or correlation ID */
  readonly requestId?: string;

  /** User ID or session ID */
  readonly userId?: string;

  /** Timestamp when error occurred */
  readonly timestamp: Date;

  /** Stack trace at point of error */
  readonly stackTrace?: string;

  /** Additional error metadata */
  readonly metadata?: ErrorMetadata;

  /** Recovery suggestions for user */
  readonly recoverySuggestions?: readonly string[];

  /** Related documentation links */
  readonly documentationLinks?: readonly string[];

  /** Whether error is retriable */
  readonly isRetriable: boolean;

  /** Maximum retry attempts */
  readonly maxRetries?: number;

  /** Retry delay configuration */
  readonly retryDelay?: RetryDelayConfig;
}

/**
 * Additional metadata that can be attached to errors
 */
export interface ErrorMetadata {
  /** File path related to error */
  readonly filePath?: string;

  /** Line number where error occurred */
  readonly lineNumber?: number;

  /** Column number where error occurred */
  readonly columnNumber?: number;

  /** Function name where error occurred */
  readonly functionName?: string;

  /** Input data that caused the error */
  readonly inputData?: unknown;

  /** Expected vs actual values */
  readonly expectedValue?: unknown;
  readonly actualValue?: unknown;

  /** Performance metrics at time of error */
  readonly performanceMetrics?: PerformanceMetrics;

  /** Environment information */
  readonly environment?: EnvironmentInfo;

  /** User agent or client information */
  readonly userAgent?: string;

  /** Request headers or parameters */
  readonly requestData?: Record<string, unknown>;

  /** Response data if applicable */
  readonly responseData?: unknown;

  /** External service information */
  readonly externalService?: ExternalServiceInfo;

  /** Custom application-specific metadata */
  readonly custom?: Record<string, unknown>;
}

/**
 * Performance metrics at time of error
 */
export interface PerformanceMetrics {
  /** Memory usage in bytes */
  readonly memoryUsage?: number;

  /** CPU usage percentage */
  readonly cpuUsage?: number;

  /** Operation duration in milliseconds */
  readonly duration?: number;

  /** Request/response time */
  readonly responseTime?: number;

  /** Queue size or backlog */
  readonly queueSize?: number;

  /** Active connection count */
  readonly activeConnections?: number;
}

/**
 * Environment information at time of error
 */
export interface EnvironmentInfo {
  /** Node.js version */
  readonly nodeVersion?: string;

  /** Operating system */
  readonly platform?: string;

  /** Architecture */
  readonly architecture?: string;

  /** Application version */
  readonly appVersion?: string;

  /** Environment mode (development, production, test) */
  readonly environment?: string;

  /** Available memory */
  readonly availableMemory?: number;

  /** Working directory */
  readonly workingDirectory?: string;

  /** Environment variables (sanitized) */
  readonly environmentVariables?: Record<string, string>;
}

/**
 * External service information
 */
export interface ExternalServiceInfo {
  /** Service name */
  readonly serviceName?: string;

  /** Service URL or endpoint */
  readonly serviceUrl?: string;

  /** Service version */
  readonly serviceVersion?: string;

  /** HTTP status code */
  readonly httpStatus?: number;

  /** Service response time */
  readonly responseTime?: number;

  /** Service availability */
  readonly isAvailable?: boolean;

  /** Rate limit information */
  readonly rateLimitInfo?: RateLimitInfo;
}

/**
 * Rate limit information
 */
export interface RateLimitInfo {
  /** Remaining requests */
  readonly remaining?: number;

  /** Request limit */
  readonly limit?: number;

  /** Reset time */
  readonly resetTime?: Date;

  /** Retry after time */
  readonly retryAfter?: number;
}

/**
 * Retry delay configuration
 */
export interface RetryDelayConfig {
  /** Initial delay in milliseconds */
  readonly initialDelay: number;

  /** Maximum delay in milliseconds */
  readonly maxDelay: number;

  /** Backoff multiplier */
  readonly backoffMultiplier: number;

  /** Whether to add jitter */
  readonly useJitter: boolean;
}

/**
 * Error correlation information for tracking related errors
 */
export interface ErrorCorrelation {
  /** Parent error ID */
  readonly parentErrorId?: string;

  /** Root cause error ID */
  readonly rootCauseId?: string;

  /** Related error IDs */
  readonly relatedErrorIds?: readonly string[];

  /** Error chain depth */
  readonly chainDepth?: number;

  /** Session correlation ID */
  readonly sessionId?: string;

  /** Operation correlation ID */
  readonly operationId?: string;
}

/**
 * Error impact assessment
 */
export interface ErrorImpact {
  /** Number of users affected */
  readonly usersAffected?: number;

  /** Number of operations failed */
  readonly operationsFailed?: number;

  /** Business impact level */
  readonly businessImpact?: 'low' | 'medium' | 'high' | 'critical';

  /** Financial impact estimate */
  readonly financialImpact?: number;

  /** Performance impact */
  readonly performanceImpact?: PerformanceImpact;

  /** Data integrity impact */
  readonly dataIntegrityImpact?: boolean;

  /** Security impact */
  readonly securityImpact?: boolean;
}

/**
 * Performance impact details
 */
export interface PerformanceImpact {
  /** Response time degradation percentage */
  readonly responseTimeDegradation?: number;

  /** Throughput reduction percentage */
  readonly throughputReduction?: number;

  /** Memory usage increase percentage */
  readonly memoryUsageIncrease?: number;

  /** CPU usage increase percentage */
  readonly cpuUsageIncrease?: number;
}

/**
 * Create basic error context with minimal required information
 */
export function createErrorContext(
  code: ErrorCode,
  category: ErrorCategory,
  options?: Partial<ErrorContext>
): ErrorContext {
  return {
    code,
    category,
    severity: options?.severity || ErrorSeverity.MEDIUM,
    priority: options?.priority || ErrorPriority.NORMAL,
    strategy: options?.strategy || ErrorHandlingStrategy.FAIL_FAST,
    timestamp: new Date(),
    isRetriable: options?.isRetriable ?? false,
    ...options
  };
}

/**
 * Create error context with automatic defaults based on code
 */
export function createContextFromCode(
  code: ErrorCode,
  overrides?: Partial<ErrorContext>
): ErrorContext {
  // Auto-determine category from error code
  const codeString = code.toString();
  const categoryPrefix = codeString.split('_')[0].toLowerCase();

  let category: ErrorCategory;
  switch (categoryPrefix) {
    case 'system':
      category = ErrorCategory.SYSTEM;
      break;
    case 'validation':
      category = ErrorCategory.VALIDATION;
      break;
    case 'config':
      category = ErrorCategory.CONFIGURATION;
      break;
    case 'mcp':
      category = ErrorCategory.MCP;
      break;
    case 'template':
      category = ErrorCategory.TEMPLATE;
      break;
    case 'session':
      category = ErrorCategory.SESSION;
      break;
    case 'cli':
      category = ErrorCategory.CLI;
      break;
    case 'tui':
      category = ErrorCategory.TUI;
      break;
    case 'network':
      category = ErrorCategory.NETWORK;
      break;
    case 'security':
      category = ErrorCategory.SECURITY;
      break;
    case 'internal':
      category = ErrorCategory.INTERNAL;
      break;
    default:
      category = ErrorCategory.INTERNAL;
  }

  return createErrorContext(code, category, overrides);
}

/**
 * Enrich error context with additional metadata
 */
export function enrichErrorContext(
  context: ErrorContext,
  metadata: Partial<ErrorMetadata>
): ErrorContext {
  return {
    ...context,
    metadata: {
      ...context.metadata,
      ...metadata
    }
  };
}

/**
 * Create correlation information for error chaining
 */
export function createErrorCorrelation(
  parentError?: Error,
  operationId?: string
): ErrorCorrelation {
  return {
    parentErrorId: parentError ? generateErrorId(parentError) : undefined,
    operationId,
    chainDepth: getErrorChainDepth(parentError),
    sessionId: generateSessionId()
  };
}

/**
 * Generate unique error ID for correlation
 */
function generateErrorId(error: Error): string {
  const timestamp = Date.now();
  const hash = simpleHash(error.message + error.stack);
  return `err_${timestamp}_${hash}`;
}

/**
 * Generate session ID for correlation
 */
function generateSessionId(): string {
  return `sess_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Get error chain depth for correlation
 */
function getErrorChainDepth(error?: Error): number {
  let depth = 0;
  let currentError = error;

  while (currentError && 'cause' in currentError && currentError.cause) {
    depth++;
    currentError = currentError.cause as Error;
  }

  return depth;
}

/**
 * Simple hash function for error ID generation
 */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36).substr(0, 8);
}