/**
 * Core type definitions for juno-code
 */

// Subagent types
export type SubagentType = 'claude' | 'cursor' | 'codex' | 'gemini' | 'pi';

// Backend types for execution
export type BackendType = 'shell';

// Session status
export type SessionStatus = 'running' | 'completed' | 'failed' | 'cancelled';

// Log levels
export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

// On hourly limit behavior
export type OnHourlyLimit = 'wait' | 'raise';

// Hook types
export type HookType = 'START_RUN' | 'START_ITERATION' | 'END_ITERATION' | 'END_RUN' | 'ON_STALE';

// Hook configuration
export interface Hook {
  commands: string[];
}

// Hooks configuration mapping
export type Hooks = Record<HookType, Hook>;

export type PromptMacroOrder =
  | 'before_command_substitution'
  | 'after_command_substitution';

export interface PromptMacroConfig {
  enabled: boolean;
  order: PromptMacroOrder;
  maxDepth: number;
  global: Record<string, string>;
  local: Record<string, string>;
}

export interface GitCheckpointAgentConfig {
  enabled?: boolean;
  service?: string;
  model?: string;
  timeoutSeconds?: number;
}

export interface GitCheckpointConfig {
  include?: string[];
  agent?: GitCheckpointAgentConfig;
}

// Progress event types
export type ProgressEventType = 'tool_start' | 'tool_result' | 'thinking' | 'error' | 'info';

// Base configuration interface
export interface JunoTaskConfig {
  // Core settings
  defaultSubagent: SubagentType;
  defaultMaxIterations: number;
  defaultModel?: string;
  /** Optional per-subagent default model overrides */
  defaultModels?: Partial<Record<SubagentType, string>>;
  defaultBackend: BackendType;

  // Project metadata
  mainTask?: string;

  // Logging settings
  logLevel: LogLevel;
  logFile?: string;
  /** Verbosity level: 0=quiet, 1=normal+helping texts (default), 2=debug+hooks */
  verbose: number;
  quiet: boolean;

  // MCP settings
  mcpTimeout: number;
  mcpRetries: number;
  mcpServerPath?: string;
  mcpServerName?: string;

  // Hook settings
  hookCommandTimeout?: number;
  /** Set false to opt out of automatic START_RUN dependency update hook injection. */
  autoDependencyUpdate?: boolean;

  // Quota/hourly limit settings
  onHourlyLimit: OnHourlyLimit;

  // TUI settings
  interactive: boolean;
  headlessMode: boolean;

  // Paths
  workingDirectory: string;
  sessionDirectory: string;

  // Controller-owned Git checkpoint configuration
  gitCheckpoint?: GitCheckpointConfig;

  // Project environment bootstrap
  /** Path to project env file loaded on startup (relative to workingDirectory or absolute) */
  envFilePath?: string;
  /** Tracks whether the configured env file has been initialized from .env.juno */
  envFileCopied?: boolean;

  // Hooks configuration
  hooks?: Hooks;

  // Prompt macro dictionary expansion configuration
  promptMacros?: PromptMacroConfig;

  // Skip hooks execution
  skipHooks?: boolean;
}

// Global declarations for build-time constants
declare global {
  const __VERSION__: string;
  const __DEV__: boolean;
}
