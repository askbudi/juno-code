/**
 * Core type definitions for juno-task-ts
 */

// Subagent types
export type SubagentType = 'claude' | 'cursor' | 'codex' | 'gemini';

// Session status
export type SessionStatus = 'running' | 'completed' | 'failed' | 'cancelled';

// Log levels
export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

// Progress event types
export type ProgressEventType = 'tool_start' | 'tool_result' | 'thinking' | 'error' | 'info';

// Base configuration interface
export interface JunoTaskConfig {
  // Core settings
  defaultSubagent: SubagentType;
  defaultMaxIterations: number;
  defaultModel?: string;

  // Logging settings
  logLevel: LogLevel;
  logFile?: string;
  verbose: boolean;
  quiet: boolean;

  // MCP settings
  mcpTimeout: number;
  mcpRetries: number;
  mcpServerPath?: string;

  // TUI settings
  interactive: boolean;
  headlessMode: boolean;

  // Paths
  workingDirectory: string;
  sessionDirectory: string;
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