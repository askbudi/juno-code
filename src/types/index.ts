/**
 * Core type definitions for juno-code
 */

// Subagent types
export type SubagentType = 'claude' | 'cursor' | 'codex' | 'gemini';

// Backend types for execution
export type BackendType = 'mcp' | 'shell';

// Session status
export type SessionStatus = 'running' | 'completed' | 'failed' | 'cancelled';

// Log levels
export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

// Hook types
export type HookType = 'START_RUN' | 'START_ITERATION' | 'END_ITERATION' | 'END_RUN';

// Hook configuration
export interface Hook {
  commands: string[];
}

// Hooks configuration mapping
export type Hooks = Record<HookType, Hook>;

// Progress event types
export type ProgressEventType = 'tool_start' | 'tool_result' | 'thinking' | 'error' | 'info';

// Base configuration interface
export interface JunoTaskConfig {
  // Core settings
  defaultSubagent: SubagentType;
  defaultMaxIterations: number;
  defaultModel?: string;
  defaultBackend: BackendType;

  // Logging settings
  logLevel: LogLevel;
  logFile?: string;
  verbose: boolean;
  quiet: boolean;

  // MCP settings
  mcpTimeout: number;
  mcpRetries: number;
  mcpServerPath?: string;
  mcpServerName?: string;

  // Hook settings
  hookCommandTimeout?: number;

  // TUI settings
  interactive: boolean;
  headlessMode: boolean;

  // Paths
  workingDirectory: string;
  sessionDirectory: string;

  // Hooks configuration
  hooks?: Hooks;
}

// Re-export metrics types for convenience
export type {
  PerformanceTiming,
  ToolCallMetrics,
  SessionMetrics,
  SystemMetrics,
  ToolCallStatistics,
  PerformanceRecommendation,
  AnalyticsReport,
  MetricsExportFormat,
  MetricsExportOptions,
} from '../core/metrics';

// Global declarations for build-time constants
declare global {
  const __VERSION__: string;
  const __DEV__: boolean;
}