/**
 * Shell Backend Implementation for juno-code
 *
 * Executes shell scripts from ~/.juno_code/services/ directory
 * Supports JSON streaming output and converts to progress events
 */

import { spawn, ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import os from 'node:os';
import fsExtra from 'fs-extra';
import type { Backend } from '../backend-manager.js';
import type { ToolCallRequest, ToolCallResult, ProgressEvent, ProgressCallback, ToolExecutionMetadata } from '../../mcp/types.js';
import { engineLogger } from '../../cli/utils/advanced-logger.js';

// =============================================================================
// Type Definitions
// =============================================================================

/**
 * Shell backend configuration
 */
export interface ShellBackendConfig {
  /** Working directory for execution */
  workingDirectory: string;

  /** Path to services directory (default: ~/.juno_code/services) */
  servicesPath: string;

  /** Enable debug logging */
  debug?: boolean;

  /** Timeout for script execution in milliseconds */
  timeout?: number;

  /** Environment variables to pass to shell scripts */
  environment?: Record<string, string>;

  /** Enable JSON streaming parsing */
  enableJsonStreaming?: boolean;

  /** Output full JSON format instead of simplified messages (for verbose mode) */
  outputRawJson?: boolean;
}

/**
 * Script execution result
 */
interface ScriptExecutionResult {
  success: boolean;
  output: string;
  error?: string;
  exitCode: number;
  duration: number;
  subAgentResponse?: any;
  metadata?: Record<string, any>;
}

/**
 * JSON streaming event from shell script
 */
interface StreamingEvent {
  type: 'progress' | 'result' | 'error' | 'thinking' | 'tool_start' | 'tool_result';
  content: string;
  metadata?: Record<string, any>;
  timestamp?: string;
}

/**
 * Quota limit information extracted from Claude response
 */
export interface QuotaLimitInfo {
  /** Whether a quota limit was detected */
  detected: boolean;
  /** The parsed reset time as a Date object */
  resetTime?: Date;
  /** Sleep duration in milliseconds until the reset time */
  sleepDurationMs?: number;
  /** The timezone extracted from the message */
  timezone?: string;
  /** Original error message from Claude */
  originalMessage?: string;
}

// =============================================================================
// Quota Limit Detection Utilities
// =============================================================================

/**
 * Common timezone aliases and their UTC offsets
 */
const TIMEZONE_OFFSETS: Record<string, number> = {
  // North American timezones
  'America/Toronto': -5,
  'America/New_York': -5,
  'US/Eastern': -5,
  'America/Chicago': -6,
  'US/Central': -6,
  'America/Denver': -7,
  'US/Mountain': -7,
  'America/Los_Angeles': -8,
  'US/Pacific': -8,
  // European timezones
  'Europe/London': 0,
  'UTC': 0,
  'GMT': 0,
  'Europe/Paris': 1,
  'Europe/Berlin': 1,
  'CET': 1,
  // Other common timezones
  'Asia/Tokyo': 9,
  'Asia/Shanghai': 8,
  'Australia/Sydney': 11,
};

/**
 * Parse reset time from Claude quota limit message
 * Handles formats like:
 * - "resets 8pm (America/Toronto)"
 * - "resets 10am (UTC)"
 * - "resets 11:30pm (US/Eastern)"
 * - "resets 2:00 PM (America/New_York)"
 */
function parseResetTime(message: string): { resetTime: Date; timezone: string } | null {
  // Pattern to match: "resets HH[:MM] [AM/PM] (TIMEZONE)"
  const resetPattern = /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(([^)]+)\)/i;
  const match = message.match(resetPattern);

  if (!match) {
    return null;
  }

  let hours = parseInt(match[1], 10);
  const minutes = match[2] ? parseInt(match[2], 10) : 0;
  const ampm = match[3]?.toLowerCase();
  const timezone = match[4].trim();

  // Convert to 24-hour format
  if (ampm === 'pm' && hours !== 12) {
    hours += 12;
  } else if (ampm === 'am' && hours === 12) {
    hours = 0;
  }

  // Get timezone offset (default to local if unknown)
  const timezoneOffset = TIMEZONE_OFFSETS[timezone];

  // Create reset time in the specified timezone
  const now = new Date();
  const resetTime = new Date();

  if (timezoneOffset !== undefined) {
    // Calculate the current time in the target timezone
    const utcNow = now.getTime() + (now.getTimezoneOffset() * 60000);
    const targetNow = new Date(utcNow + (timezoneOffset * 3600000));

    // Set the reset time in the target timezone
    resetTime.setUTCHours(hours - timezoneOffset, minutes, 0, 0);

    // If the reset time is in the past, add a day
    if (resetTime.getTime() <= now.getTime()) {
      resetTime.setTime(resetTime.getTime() + 24 * 60 * 60 * 1000);
    }
  } else {
    // Fallback: assume it's in the local timezone
    resetTime.setHours(hours, minutes, 0, 0);

    // If the reset time is in the past, add a day
    if (resetTime.getTime() <= now.getTime()) {
      resetTime.setTime(resetTime.getTime() + 24 * 60 * 60 * 1000);
    }
  }

  return { resetTime, timezone };
}

/**
 * Detect and parse Claude quota limit error from response
 */
export function detectQuotaLimit(message: string | undefined | null): QuotaLimitInfo {
  if (!message || typeof message !== 'string') {
    return { detected: false };
  }

  // Check for the quota limit pattern
  const quotaPattern = /you'?ve hit your limit/i;
  if (!quotaPattern.test(message)) {
    return { detected: false };
  }

  // Try to parse the reset time
  const parsed = parseResetTime(message);

  if (parsed) {
    const now = new Date();
    const sleepDurationMs = Math.max(0, parsed.resetTime.getTime() - now.getTime());

    return {
      detected: true,
      resetTime: parsed.resetTime,
      sleepDurationMs,
      timezone: parsed.timezone,
      originalMessage: message,
    };
  }

  // Quota limit detected but couldn't parse reset time
  // Default to 5 minutes wait
  return {
    detected: true,
    sleepDurationMs: 5 * 60 * 1000, // 5 minutes default
    originalMessage: message,
  };
}

/**
 * Format duration in human-readable form
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);

  return parts.join(' ');
}

// =============================================================================
// Shell Backend Implementation
// =============================================================================

/**
 * Shell backend that executes scripts from ~/.juno_code/services/
 */
export class ShellBackend implements Backend {
  readonly type = 'shell' as const;
  readonly name = 'Shell Scripts Backend';

  private config: ShellBackendConfig | null = null;
  private progressCallbacks: ProgressCallback[] = [];
  private eventCounter = 0;
  private jsonBuffer = ''; // Buffer for handling partial JSON objects
  private logFilePath: string | null = null; // Path to current log file

  /**
   * Configure the shell backend
   */
  configure(config: ShellBackendConfig): void {
    this.config = config;
  }

  /**
   * Initialize the backend
   */
  async initialize(): Promise<void> {
    if (!this.config) {
      throw new Error('Shell backend not configured. Call configure() first.');
    }

    // Ensure services directory exists
    try {
      await fs.access(this.config.servicesPath);
    } catch (error) {
      throw new Error(`Services directory not found: ${this.config.servicesPath}. Please create the directory and add subagent scripts.`);
    }

    if (this.config.debug) {
      engineLogger.info(`Shell backend initialized with services path: ${this.config.servicesPath}`);
    }
  }

  /**
   * Execute a tool call request using shell scripts
   */
  async execute(request: ToolCallRequest): Promise<ToolCallResult> {
    if (!this.config) {
      throw new Error('Shell backend not configured');
    }

    const startTime = Date.now();
    const toolId = `shell_${request.toolName}_${startTime}`;

    // Extract subagent name and create log file
    const subagentType = this.extractSubagentFromToolName(request.toolName);
    try {
      this.logFilePath = await this.createLogFile(subagentType);
    } catch (error) {
      // Log creation failed - continue without file logging
      if (this.config.debug) {
        engineLogger.warn(`Failed to create log file, continuing without file logging: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.logFilePath = null;
    }

    // Emit tool start event
    await this.emitProgressEvent({
      sessionId: request.metadata?.sessionId as string || 'unknown',
      timestamp: new Date(),
      backend: 'shell',
      count: ++this.eventCounter,
      type: 'tool_start',
      content: `Starting ${request.toolName} via shell script`,
      toolId,
      metadata: {
        toolName: request.toolName,
        arguments: request.arguments,
        phase: 'initialization'
      }
    });

    try {
      // Find appropriate script for the subagent (already extracted above)
      const scriptPath = await this.findScriptForSubagent(subagentType);

      // Execute the script
      const result = await this.executeScript(scriptPath, request, toolId, subagentType);

      const duration = Date.now() - startTime;

      // Emit completion event
      await this.emitProgressEvent({
        sessionId: request.metadata?.sessionId as string || 'unknown',
        timestamp: new Date(),
        backend: 'shell',
        count: ++this.eventCounter,
        type: 'tool_result',
        content: `${request.toolName} completed successfully (${duration}ms)`,
        toolId,
        metadata: {
          toolName: request.toolName,
          duration,
          success: result.success,
          phase: 'completion'
        }
      });

      const structuredResult = this.buildStructuredOutput(subagentType, result);

      return {
        content: structuredResult.content,
        status: result.success ? 'completed' : 'failed',
        startTime: new Date(startTime),
        endTime: new Date(),
        duration,
        error: result.error ? { type: 'shell_execution', message: result.error, timestamp: new Date() } : undefined,
        progressEvents: [], // Progress events are handled via callbacks
        ...(structuredResult.metadata ? { metadata: structuredResult.metadata } : undefined),
        request
      };

    } catch (error) {
      const duration = Date.now() - startTime;

      // Emit error event
      await this.emitProgressEvent({
        sessionId: request.metadata?.sessionId as string || 'unknown',
        timestamp: new Date(),
        backend: 'shell',
        count: ++this.eventCounter,
        type: 'error',
        content: `${request.toolName} failed: ${error instanceof Error ? error.message : String(error)}`,
        toolId,
        metadata: {
          toolName: request.toolName,
          duration,
          success: false,
          error: error instanceof Error ? error.message : String(error),
          phase: 'error'
        }
      });

      throw error;
    }
  }

  /**
   * Check if shell backend is available
   */
  async isAvailable(): Promise<boolean> {
    if (!this.config) {
      return false;
    }

    try {
      // Check if services directory exists
      const stats = await fs.stat(this.config.servicesPath);
      if (!stats.isDirectory()) {
        return false;
      }

      // Check if at least one subagent script exists
      const scripts = await this.findAvailableScripts();
      return scripts.length > 0;
    } catch (error) {
      return false;
    }
  }

  /**
   * Set progress callback
   */
  onProgress(callback: ProgressCallback): () => void {
    this.progressCallbacks.push(callback);
    return () => {
      const index = this.progressCallbacks.indexOf(callback);
      if (index !== -1) {
        this.progressCallbacks.splice(index, 1);
      }
    };
  }

  /**
   * Clean up resources
   */
  async cleanup(): Promise<void> {
    // Nothing to clean up for shell backend
    this.progressCallbacks = [];
  }

  // =============================================================================
  // Private Implementation Methods
  // =============================================================================

  /**
   * Create log file path and ensure log directory exists
   */
  private async createLogFile(subagentName: string): Promise<string> {
    // Format timestamp as YYYYMMDD_HHMMSS
    const now = new Date();
    const timestamp = now.getFullYear().toString() +
      (now.getMonth() + 1).toString().padStart(2, '0') +
      now.getDate().toString().padStart(2, '0') +
      '_' +
      now.getHours().toString().padStart(2, '0') +
      now.getMinutes().toString().padStart(2, '0') +
      now.getSeconds().toString().padStart(2, '0');

    // Create log directory path
    const logDir = path.join(this.config!.workingDirectory, '.juno_task', 'logs');

    // Ensure log directory exists
    try {
      await fsExtra.ensureDir(logDir);
    } catch (error) {
      if (this.config?.debug) {
        engineLogger.warn(`Failed to create log directory: ${error instanceof Error ? error.message : String(error)}`);
      }
      throw new Error(`Failed to create log directory: ${logDir}`);
    }

    // Create log file path
    const logFileName = `${subagentName}_shell_${timestamp}.log`;
    const logFilePath = path.join(logDir, logFileName);

    if (this.config?.debug) {
      engineLogger.debug(`Created log file path: ${logFilePath}`);
    }

    return logFilePath;
  }

  /**
   * Write log entry to file
   */
  private async writeToLogFile(message: string): Promise<void> {
    if (!this.logFilePath) {
      return; // No log file configured
    }

    try {
      // Append to log file with timestamp
      const timestamp = new Date().toISOString();
      const logEntry = `[${timestamp}] ${message}\n`;
      await fsExtra.appendFile(this.logFilePath, logEntry, 'utf-8');
    } catch (error) {
      // Don't throw - just log the error if debug is enabled
      if (this.config?.debug) {
        engineLogger.warn(`Failed to write to log file: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /**
   * Extract subagent type from tool name
   */
  private extractSubagentFromToolName(toolName: string): string {
    // Map tool names to subagent types
    const toolMapping: Record<string, string> = {
      claude_subagent: 'claude',
      cursor_subagent: 'cursor',
      codex_subagent: 'codex',
      gemini_subagent: 'gemini'
    };

    return toolMapping[toolName] || toolName.replace('_subagent', '');
  }

  /**
   * Find script for a specific subagent
   */
  private async findScriptForSubagent(subagent: string): Promise<string> {
    const possibleNames = [
      `${subagent}.py`,  // Subagent-specific Python script (e.g. claude.py, codex.py)
      `${subagent}.sh`,  // Subagent-specific shell script
      `subagent.py`,     // Generic Python script (fallback)
      `subagent.sh`,     // Generic shell script (fallback)
    ];

    const checkedPaths: string[] = [];

    for (const name of possibleNames) {
      const scriptPath = path.join(this.config!.servicesPath, name);
      checkedPaths.push(scriptPath);

      try {
        const stats = await fs.stat(scriptPath);
        if (stats.isFile()) {
          if (this.config!.debug) {
            engineLogger.debug(`Found script for ${subagent}: ${scriptPath}`);
          }
          return scriptPath;
        }
      } catch (error) {
        // Continue to next possibility
        if (this.config!.debug) {
          engineLogger.debug(`Script not found: ${scriptPath}`);
        }
      }
    }

    throw new Error(`No script found for subagent: ${subagent}. Checked paths: ${checkedPaths.join(', ')}`);
  }

  /**
   * Find all available scripts in services directory
   */
  private async findAvailableScripts(): Promise<string[]> {
    try {
      const files = await fs.readdir(this.config!.servicesPath);
      const scriptFiles = files.filter(file =>
        file.endsWith('.py') || file.endsWith('.sh')
      );
      return scriptFiles;
    } catch (error) {
      return [];
    }
  }

  /**
   * Execute a shell script
   */
  private async executeScript(
    scriptPath: string,
    request: ToolCallRequest,
    toolId: string,
    subagentType: string
  ): Promise<ScriptExecutionResult> {
    return new Promise(async (resolve, reject) => {
      const startTime = Date.now();
      const isPython = scriptPath.endsWith('.py');
      const isGemini = subagentType === 'gemini';

      // Prepare environment variables
      const env = {
        ...process.env,
        ...this.config!.environment,
        // Pass request data as environment variables
        JUNO_INSTRUCTION: request.arguments?.instruction || '',
        JUNO_PROJECT_PATH: request.arguments?.project_path || this.config!.workingDirectory,
        JUNO_MODEL: request.arguments?.model || '',
        JUNO_ITERATION: String(request.arguments?.iteration || 1),
        JUNO_TOOL_ID: toolId
      };

      if (isGemini) {
        env.GEMINI_OUTPUT_FORMAT = env.GEMINI_OUTPUT_FORMAT || 'stream-json';
      }

      // Capture file for structured subagent responses (claude.py support)
      let captureDir: string | null = null;
      let capturePath: string | null = null;
      if (subagentType === 'claude') {
        try {
          captureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'juno-shell-'));
          capturePath = path.join(captureDir, `subagent_${toolId}.json`);
          env.JUNO_SUBAGENT_CAPTURE_PATH = capturePath;
        } catch (error) {
          if (this.config?.debug) {
            engineLogger.warn(`Failed to prepare subagent capture path: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }

      // Build command arguments for the script
      const command = isPython ? 'python3' : 'bash';
      const args = [scriptPath];

      // For Python scripts, add the prompt as -p argument
      if (isPython && request.arguments?.instruction) {
        args.push('-p', request.arguments.instruction);
      }

      // For Python scripts, add the model as -m argument if provided
      if (isPython && request.arguments?.model) {
        args.push('-m', request.arguments.model);
      }

      // For Gemini, force stream-json output format by default to preserve headless parity
      if (isPython && isGemini) {
        args.push('--output-format', env.GEMINI_OUTPUT_FORMAT || 'stream-json');
      }

      // For Python scripts, add the agents configuration if provided
      if (isPython && request.arguments?.agents) {
        args.push('--agents', request.arguments.agents);
      }

      // For Python scripts, add available tools from built-in set if provided (--tools)
      if (isPython && request.arguments?.tools && Array.isArray(request.arguments.tools)) {
        args.push('--tools');
        args.push(...request.arguments.tools);
      }

      // For Python scripts, add permission-based allowed tools if provided (--allowedTools)
      if (isPython && request.arguments?.allowedTools && Array.isArray(request.arguments.allowedTools)) {
        args.push('--allowedTools');
        args.push(...request.arguments.allowedTools);
      }

      // For Python scripts, add append allowed tools if provided (--appendAllowedTools)
      if (isPython && request.arguments?.appendAllowedTools && Array.isArray(request.arguments.appendAllowedTools)) {
        args.push('--appendAllowedTools');
        args.push(...request.arguments.appendAllowedTools);
      }

      // For Python scripts, add disallowed tools if provided (--disallowedTools)
      if (isPython && request.arguments?.disallowedTools && Array.isArray(request.arguments.disallowedTools)) {
        args.push('--disallowedTools');
        args.push(...request.arguments.disallowedTools);
      }

      // For Python scripts, add resume flag if provided (--resume SESSION_ID)
      if (isPython && request.arguments?.resume) {
        args.push('--resume', request.arguments.resume);
      }

      // For Python scripts, add continue flag if provided (--continue)
      if (isPython && request.arguments?.continueConversation) {
        args.push('--continue');
      }

      if (this.config!.debug) {
        engineLogger.debug(`Executing script: ${command} ${args.join(' ')}`);
        engineLogger.debug(`Working directory: ${this.config!.workingDirectory}`);
        engineLogger.debug(`Environment variables: ${Object.keys(env).filter(k => k.startsWith('JUNO_')).join(', ')}`);
        engineLogger.debug(`Request arguments: ${JSON.stringify(request.arguments)}`);
      }

      // Spawn the process
      const child: ChildProcess = spawn(command, args, {
        env,
        cwd: this.config!.workingDirectory,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      // Close stdin immediately - we don't need it and it prevents the subprocess from waiting
      if (child.stdin) {
        child.stdin.end();
      }

      let stdout = '';
      let stderr = '';
      let isProcessKilled = false;

      // Handle stdout (JSON streaming or TEXT streaming)
      child.stdout?.on('data', (chunk: Buffer) => {
        const data = chunk.toString();
        stdout += data;

        if (this.config!.debug) {
          engineLogger.debug(`Script stdout chunk: ${data.length} bytes`);
        }

        // Try to parse and emit streaming events (handles both JSON and TEXT formats)
        if (this.config!.enableJsonStreaming !== false) {
          try {
            this.parseAndEmitStreamingEvents(data, request.metadata?.sessionId as string || 'unknown');
          } catch (error) {
            if (this.config!.debug) {
              engineLogger.warn(`Streaming parse error: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }
      });

      // Handle stderr
      child.stderr?.on('data', (chunk: Buffer) => {
        const errorData = chunk.toString();
        stderr += errorData;

        if (this.config!.debug) {
          engineLogger.debug(`Script stderr: ${errorData}`);
        }
      });

      // Handle process completion
      child.on('close', (exitCode) => {
        void (async () => {
          if (isProcessKilled) return; // Prevent double resolution

          const duration = Date.now() - startTime;
          const success = exitCode === 0;

          let subAgentResponse: any;
          if (capturePath) {
            try {
              const captured = await fs.readFile(capturePath, 'utf-8');
              if (captured.trim()) {
                subAgentResponse = JSON.parse(captured);
              }
            } catch (error) {
              if (this.config?.debug) {
                engineLogger.warn(`Failed to read subagent capture: ${error instanceof Error ? error.message : String(error)}`);
              }
            } finally {
              if (captureDir) {
                try {
                  await fs.rm(captureDir, { recursive: true, force: true });
                } catch (cleanupError) {
                  if (this.config?.debug) {
                    engineLogger.warn(`Failed to clean capture directory: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
                  }
                }
              }
            }
          }

          if (this.config!.debug) {
            engineLogger.debug(`Script execution completed with exit code: ${exitCode}, duration: ${duration}ms`);
            engineLogger.debug(`Stdout length: ${stdout.length}, Stderr length: ${stderr.length}`);
          }

          resolve({
            success,
            output: stdout,
            error: stderr || undefined,
            exitCode: exitCode || 0,
            duration,
            ...(subAgentResponse ? { subAgentResponse } : undefined)
          });
        })();
      });

      // Handle process errors
      child.on('error', (error) => {
        if (isProcessKilled) return; // Prevent double resolution

        if (this.config!.debug) {
          engineLogger.error(`Script execution error: ${error.message}`);
        }
        reject(new Error(`Failed to execute script: ${error.message}`));
      });

      // Apply timeout if configured
      const timeout = this.config!.timeout || 43200000; // 12 hours default for long-running operations
      const timer = setTimeout(() => {
        if (isProcessKilled) return;

        isProcessKilled = true;
        if (this.config!.debug) {
          engineLogger.warn(`Script execution timed out after ${timeout}ms, killing process`);
        }

        child.kill('SIGTERM');

        // Force kill after 5 seconds if SIGTERM doesn't work
        setTimeout(() => {
          if (!child.killed) {
            child.kill('SIGKILL');
          }
        }, 5000);

        reject(new Error(`Script execution timed out after ${timeout}ms`));
      }, timeout);

      // Clear timeout when process completes
      child.on('close', () => {
        clearTimeout(timer);
      });

      child.on('error', () => {
        clearTimeout(timer);
      });
    });
  }

  /**
   * Build a structured, JSON-parsable result payload for programmatic capture while
   * preserving the shell backend's existing on-screen streaming behavior.
   */
  private buildStructuredOutput(
    subagentType: string,
    result: ScriptExecutionResult
  ): { content: string; metadata?: ToolExecutionMetadata } {
    if (subagentType === 'claude') {
      const claudeEvent = result.subAgentResponse ?? this.extractLastJsonEvent(result.output);
      const isError = claudeEvent?.is_error ?? claudeEvent?.subtype === 'error' ?? !result.success;

      // Check for quota limit error
      const resultText = claudeEvent?.result ?? claudeEvent?.error ?? '';
      const quotaLimitInfo = detectQuotaLimit(resultText);

      const structuredPayload = {
        type: 'result',
        subtype: claudeEvent?.subtype || (isError ? 'error' : 'success'),
        is_error: isError,
        result: claudeEvent?.result ?? claudeEvent?.error ?? claudeEvent?.content ?? result.output,
        error: claudeEvent?.error,
        stderr: result.error,
        datetime: claudeEvent?.datetime,
        counter: claudeEvent?.counter,
        session_id: claudeEvent?.session_id,
        num_turns: claudeEvent?.num_turns,
        duration_ms: claudeEvent?.duration_ms ?? result.duration,
        exit_code: result.exitCode,
        total_cost_usd: claudeEvent?.total_cost_usd,
        usage: claudeEvent?.usage,
        modelUsage: claudeEvent?.modelUsage || claudeEvent?.model_usage || {},
        permission_denials: claudeEvent?.permission_denials || [],
        uuid: claudeEvent?.uuid,
        sub_agent_response: claudeEvent,
        // Add quota limit info if detected
        ...(quotaLimitInfo.detected && { quota_limit: quotaLimitInfo })
      };

      const metadata: ToolExecutionMetadata = {
        ...(claudeEvent ? { subAgentResponse: claudeEvent } : undefined),
        structuredOutput: true,
        contentType: 'application/json',
        rawOutput: result.output,
        // Add quota limit info to metadata as well for engine consumption
        ...(quotaLimitInfo.detected && { quotaLimitInfo })
      };

      return {
        content: JSON.stringify(structuredPayload),
        metadata
      };
    }

    return { content: result.output, metadata: result.metadata as ToolExecutionMetadata | undefined };
  }

  /**
   * Extract the last valid JSON object from a script's stdout to use as a structured payload fallback.
   */
  private extractLastJsonEvent(output: string): any | null {
    if (!output) {
      return null;
    }

    const lines = output.split('\n').map(line => line.trim()).filter(Boolean);

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i]);
        if (parsed && typeof parsed === 'object') {
          return parsed;
        }
      } catch {
        // Ignore parse failures and continue scanning earlier lines
      }
    }

    return null;
  }

  /**
   * Parse streaming events from script output
   * Handles both JSON format (Claude) and TEXT format (Codex)
   *
   * Strategy:
   * 1. Try to parse each line as JSON first (for Claude)
   * 2. If JSON parsing fails, treat as TEXT streaming (for Codex and other text-based subagents)
   * 3. Emit all text lines (including whitespace-only) as progress events for real-time display
   */
  private parseAndEmitStreamingEvents(data: string, sessionId: string): void {
    // Handle partial lines by maintaining a buffer
    if (!this.jsonBuffer) {
      this.jsonBuffer = '';
    }

    this.jsonBuffer += data;

    // Split by lines, but keep the last potentially incomplete line in buffer
    const lines = this.jsonBuffer.split('\n');
    this.jsonBuffer = lines.pop() || ''; // Keep last incomplete line

    // Process complete lines
    for (const line of lines) {
      const rawLine = line.endsWith('\r') ? line.slice(0, -1) : line;
      if (!rawLine) continue;

      const hasNonWhitespace = rawLine.trim().length > 0;

      // Preserve whitespace-only lines (tabs/spaces) as-is for accurate pretty output rendering
      if (!hasNonWhitespace) {
        this.emitProgressEvent({
          sessionId,
          timestamp: new Date(),
          backend: 'shell',
          count: ++this.eventCounter,
          type: 'thinking',
          content: rawLine,
          metadata: {
            format: 'text',
            raw: true
          }
        }).catch(error => {
          if (this.config?.debug) {
            engineLogger.warn(`Failed to emit whitespace-only streaming event: ${error instanceof Error ? error.message : String(error)}`);
          }
        });
        continue;
      }

      const trimmedLine = rawLine.trim();

      // Try JSON parsing first (for Claude and other JSON-outputting subagents)
      let isJsonParsed = false;
      try {
        const jsonEvent = JSON.parse(trimmedLine);

        // Detect format: Claude CLI or generic StreamingEvent
        let progressEvent: ProgressEvent;

        if (this.isClaudeCliEvent(jsonEvent)) {
          // Handle Claude CLI specific format
          // Pass the original trimmedLine for raw JSON output mode
          progressEvent = this.convertClaudeEventToProgress(jsonEvent, sessionId, rawLine);
          isJsonParsed = true;
        } else if (this.isGenericStreamingEvent(jsonEvent)) {
          // Handle generic StreamingEvent format
          progressEvent = {
            sessionId,
            timestamp: jsonEvent.timestamp ? new Date(jsonEvent.timestamp) : new Date(),
            backend: 'shell',
            count: ++this.eventCounter,
            type: jsonEvent.type as any,
            content: jsonEvent.content,
            metadata: jsonEvent.metadata
          };
          isJsonParsed = true;
        } else {
          // Unknown JSON format, treat as text below
          if (this.config?.debug) {
            engineLogger.debug(`Unknown JSON format, treating as text: ${trimmedLine}`);
          }
        }

        // Emit the progress event if JSON was successfully parsed
        if (isJsonParsed) {
          this.emitProgressEvent(progressEvent!).catch(error => {
            if (this.config?.debug) {
              engineLogger.warn(`Failed to emit progress event: ${error instanceof Error ? error.message : String(error)}`);
            }
          });
        }

      } catch (error) {
        // Not JSON - this is expected for text-based subagents like Codex
        // Treat as TEXT streaming and emit as thinking event
        isJsonParsed = false;
      }

      // If not JSON, handle as TEXT streaming (for Codex and other text-based outputs)
      if (!isJsonParsed && trimmedLine.length > 0) {
        this.emitProgressEvent({
          sessionId,
          timestamp: new Date(),
          backend: 'shell',
          count: ++this.eventCounter,
          type: 'thinking',
          content: rawLine,
          metadata: {
            format: 'text',
            raw: true
          }
        }).catch(error => {
          if (this.config?.debug) {
            engineLogger.warn(`Failed to emit text streaming event: ${error instanceof Error ? error.message : String(error)}`);
          }
        });
      }
    }
  }

  /**
   * Check if JSON event is Claude CLI format
   */
  private isClaudeCliEvent(event: any): boolean {
    return event && typeof event === 'object' &&
           event.type && ['system', 'assistant', 'result'].includes(event.type);
  }

  /**
   * Check if JSON event is generic StreamingEvent format
   */
  private isGenericStreamingEvent(event: any): boolean {
    return event && typeof event === 'object' &&
           event.type && event.content !== undefined;
  }

  /**
   * Convert Claude CLI event to ProgressEvent format
   */
  private convertClaudeEventToProgress(event: any, sessionId: string, originalLine?: string): ProgressEvent {
    let type: ProgressEvent['type'];
    let content: string;
    const metadata: Record<string, any> = {};

    // If outputRawJson is enabled, pass the original JSON line for jq-style formatting
    // This allows the progress display to format it with colors and indentation
    if (this.config?.outputRawJson && originalLine) {
      // Determine event type based on Claude CLI format
      switch (event.type) {
        case 'system':
          type = 'tool_start';
          break;
        case 'assistant':
          type = 'thinking';
          break;
        case 'result':
          type = event.is_error || event.subtype === 'error' ? 'error' : 'tool_result';
          break;
        default:
          type = 'thinking';
      }

      // Pass the raw JSON for jq-style formatting in the display layer
      content = originalLine;
      metadata.rawJsonOutput = true;
      metadata.originalType = event.type;
      metadata.parsedEvent = event; // Keep parsed version for metadata access

      return {
        sessionId,
        timestamp: new Date(),
        backend: 'shell',
        count: ++this.eventCounter,
        type,
        content,
        metadata
      };
    }

    // Original simplified format (when outputRawJson is false/undefined)
    switch (event.type) {
      case 'system':
        // System/init event
        type = 'tool_start';
        content = `Initializing Claude session`;
        metadata.subtype = event.subtype;
        metadata.sessionId = event.session_id;
        metadata.model = event.model;
        metadata.tools = event.tools;
        metadata.cwd = event.cwd;
        break;

      case 'assistant':
        // Assistant message event
        type = 'thinking';
        // Check if this is pretty-formatted JSON from claude.py
        if (!event.message && (event.content !== undefined || event.tool_use !== undefined)) {
          // Pretty-formatted: { "type": "assistant", "datetime": "...", "content": "...", "counter": "..." }
          // or with tool_use: { "type": "assistant", "datetime": "...", "tool_use": {...}, "counter": "..." }
          if (event.content && typeof event.content === 'string') {
            content = event.content;
          } else if (event.tool_use) {
            // For tool_use, show the tool name and input
            content = `Tool: ${event.tool_use.name}`;
            metadata.tool_use = event.tool_use; // Preserve tool_use data in metadata
          } else {
            content = ''; // Empty content (content was explicitly set to undefined/empty)
          }
        } else if (event.message?.content && Array.isArray(event.message.content)) {
          // Original format: Extract content from message.content array
          const textContent = event.message.content.find((c: any) => c.type === 'text');
          content = textContent?.text || 'Processing...';
        } else {
          content = 'Processing...';
        }
        metadata.messageId = event.message?.id;
        metadata.model = event.message?.model;
        metadata.usage = event.message?.usage;
        metadata.sessionId = event.session_id;
        metadata.datetime = event.datetime; // Preserve datetime from pretty format
        metadata.counter = event.counter; // Preserve counter from pretty format
        break;

      case 'result':
        // Result event
        if (event.is_error || event.subtype === 'error') {
          type = 'error';
          content = event.result || event.error || 'Execution failed';
        } else {
          type = 'tool_result';
          content = event.result || 'Execution completed';
        }
        metadata.subtype = event.subtype;
        metadata.duration = event.duration_ms;
        metadata.cost = event.total_cost_usd;
        metadata.usage = event.usage;
        metadata.sessionId = event.session_id;
        break;

      default:
        // Fallback to thinking
        type = 'thinking';
        content = JSON.stringify(event);
        metadata.unknownType = event.type;
    }

    return {
      sessionId,
      timestamp: new Date(),
      backend: 'shell',
      count: ++this.eventCounter,
      type,
      content,
      metadata
    };
  }

  /**
   * Format Claude CLI event into MCP-style human-readable format
   * Extracts key fields like num_turns, result, type, subtype, is_error and formats them
   */
  private formatClaudeEventMCPStyle(event: any): string {
    const parts: string[] = [];

    switch (event.type) {
      case 'system':
        // System initialization event
        parts.push(`type=${event.type}`);
        if (event.subtype) parts.push(`subtype=${event.subtype}`);
        if (event.session_id) parts.push(`session=${event.session_id}`);
        if (event.model) parts.push(`model=${event.model}`);
        if (event.cwd) parts.push(`cwd=${event.cwd}`);
        if (event.tools && Array.isArray(event.tools)) {
          parts.push(`tools=[${event.tools.join(', ')}]`);
        }
        break;

      case 'assistant':
        // Assistant message event
        parts.push(`type=${event.type}`);
        if (event.num_turns !== undefined) parts.push(`num_turns=${event.num_turns}`);
        if (event.message?.id) parts.push(`message_id=${event.message.id}`);
        if (event.message?.model) parts.push(`model=${event.message.model}`);

        // Extract and show the actual message content
        if (event.message?.content && Array.isArray(event.message.content)) {
          const textContent = event.message.content.find((c: any) => c.type === 'text');
          if (textContent?.text) {
            const preview = textContent.text.length > 100
              ? textContent.text.substring(0, 100) + '...'
              : textContent.text;
            parts.push(`content="${preview}"`);
          }
        }

        // Show usage/token information if available
        if (event.message?.usage) {
          const usage = event.message.usage;
          parts.push(`tokens=${usage.input_tokens || 0}/${usage.output_tokens || 0}`);
        }
        break;

      case 'result':
        // Result event
        parts.push(`type=${event.type}`);
        if (event.subtype) parts.push(`subtype=${event.subtype}`);
        if (event.num_turns !== undefined) parts.push(`num_turns=${event.num_turns}`);
        if (event.is_error !== undefined) parts.push(`is_error=${event.is_error}`);

        // Show result/error content
        if (event.result) {
          const resultPreview = event.result.length > 150
            ? event.result.substring(0, 150) + '...'
            : event.result;
          parts.push(`result="${resultPreview}"`);
        }

        // Show performance metrics
        if (event.duration_ms !== undefined) parts.push(`duration=${event.duration_ms}ms`);
        if (event.total_cost_usd !== undefined) parts.push(`cost=$${event.total_cost_usd.toFixed(6)}`);

        // Show usage summary if available
        if (event.usage) {
          const usage = event.usage;
          parts.push(`total_tokens=${usage.input_tokens || 0}+${usage.output_tokens || 0}`);
        }
        break;

      default:
        // Fallback for unknown event types
        parts.push(`type=${event.type}`);
        // Show a preview of the full JSON for debugging
        const jsonPreview = JSON.stringify(event).substring(0, 100) + '...';
        parts.push(`data=${jsonPreview}`);
    }

    return parts.join(' | ');
  }

  /**
   * Emit progress event to all callbacks
   */
  private async emitProgressEvent(event: ProgressEvent): Promise<void> {
    // Write to log file first
    if (this.logFilePath) {
      const logMessage = `[${event.type}] ${event.content}${event.metadata ? ' | metadata: ' + JSON.stringify(event.metadata) : ''}`;
      await this.writeToLogFile(logMessage);
    }

    // Then emit to callbacks for screen display
    for (const callback of this.progressCallbacks) {
      try {
        await callback(event);
      } catch (error) {
        // Don't break on callback errors
        if (this.config?.debug) {
          engineLogger.warn(`Progress callback error: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }
}
