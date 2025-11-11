/**
 * Shell Backend Implementation for juno-code
 *
 * Executes shell scripts from ~/.juno_code/services/ directory
 * Supports JSON streaming output and converts to progress events
 */

import { spawn, ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { Backend } from '../backend-manager.js';
import type { ToolCallRequest, ToolCallResult, ProgressEvent, ProgressCallback } from '../../mcp/types.js';
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
      // Find appropriate script for the subagent
      const subagentType = this.extractSubagentFromToolName(request.toolName);
      const scriptPath = await this.findScriptForSubagent(subagentType);

      // Execute the script
      const result = await this.executeScript(scriptPath, request, toolId);

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

      return {
        content: result.output,
        status: result.success ? 'completed' : 'failed',
        startTime: new Date(startTime),
        endTime: new Date(),
        duration,
        error: result.error ? { type: 'shell_execution', message: result.error, timestamp: new Date() } : undefined,
        progressEvents: [], // Progress events are handled via callbacks
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
    toolId: string
  ): Promise<ScriptExecutionResult> {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const isPython = scriptPath.endsWith('.py');

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

      // Build command arguments for the script
      const command = isPython ? 'python3' : 'bash';
      const args = [scriptPath];

      // For Python scripts, add the prompt as -p argument
      if (isPython && request.arguments?.instruction) {
        args.push('-p', request.arguments.instruction);
      }

      if (this.config!.debug) {
        engineLogger.debug(`Executing script: ${command} ${args.join(' ')}`);
        engineLogger.debug(`Working directory: ${this.config!.workingDirectory}`);
        engineLogger.debug(`Environment variables: ${Object.keys(env).filter(k => k.startsWith('JUNO_')).join(', ')}`);
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

      // Handle stdout (JSON streaming or regular output)
      child.stdout?.on('data', (chunk: Buffer) => {
        const data = chunk.toString();
        stdout += data;

        if (this.config!.debug) {
          engineLogger.debug(`Script stdout chunk: ${data.length} bytes`);
        }

        // Try to parse as JSON streaming events
        if (this.config!.enableJsonStreaming !== false) {
          try {
            this.parseAndEmitStreamingEvents(data, request.metadata?.sessionId as string || 'unknown');
          } catch (error) {
            if (this.config!.debug) {
              engineLogger.warn(`JSON streaming parse error: ${error instanceof Error ? error.message : String(error)}`);
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
        if (isProcessKilled) return; // Prevent double resolution

        const duration = Date.now() - startTime;
        const success = exitCode === 0;

        if (this.config!.debug) {
          engineLogger.debug(`Script execution completed with exit code: ${exitCode}, duration: ${duration}ms`);
          engineLogger.debug(`Stdout length: ${stdout.length}, Stderr length: ${stderr.length}`);
        }

        resolve({
          success,
          output: stdout,
          error: stderr || undefined,
          exitCode: exitCode || 0,
          duration
        });
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
      const timeout = this.config!.timeout || 300000; // 5 minutes default
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
   * Parse JSON streaming events from script output
   * Handles both generic StreamingEvent format and Claude CLI specific format
   */
  private parseAndEmitStreamingEvents(data: string, sessionId: string): void {
    // Handle partial JSON objects by maintaining a buffer
    if (!this.jsonBuffer) {
      this.jsonBuffer = '';
    }

    this.jsonBuffer += data;

    // Split by lines, but keep the last potentially incomplete line in buffer
    const lines = this.jsonBuffer.split('\n');
    this.jsonBuffer = lines.pop() || ''; // Keep last incomplete line

    // Process complete lines
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine) continue;

      try {
        const jsonEvent = JSON.parse(trimmedLine);

        // Detect format: Claude CLI or generic StreamingEvent
        let progressEvent: ProgressEvent;

        if (this.isClaudeCliEvent(jsonEvent)) {
          // Handle Claude CLI specific format
          // Pass the original trimmedLine for raw JSON output mode
          progressEvent = this.convertClaudeEventToProgress(jsonEvent, sessionId, trimmedLine);
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
        } else {
          // Unknown format, skip or emit as thinking
          if (this.config?.debug) {
            engineLogger.debug(`Unknown JSON format: ${trimmedLine}`);
          }
          continue;
        }

        // Emit the progress event
        this.emitProgressEvent(progressEvent).catch(error => {
          if (this.config?.debug) {
            engineLogger.warn(`Failed to emit progress event: ${error instanceof Error ? error.message : String(error)}`);
          }
        });

      } catch (error) {
        // Not JSON, might be regular output - emit as thinking event if it looks meaningful
        if (trimmedLine.length > 0 && !trimmedLine.startsWith('#')) {
          this.emitProgressEvent({
            sessionId,
            timestamp: new Date(),
            backend: 'shell',
            count: ++this.eventCounter,
            type: 'thinking',
            content: trimmedLine,
            metadata: { raw: true, parseError: true }
          }).catch(error => {
            if (this.config?.debug) {
              engineLogger.warn(`Failed to emit thinking event: ${error instanceof Error ? error.message : String(error)}`);
            }
          });
        }
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

    // If outputRawJson is enabled, format into MCP-style human-readable display
    // Extract key fields and present them in a structured format similar to MCP backend
    if (this.config?.outputRawJson) {
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

      // Format into MCP-style human-readable format
      content = this.formatClaudeEventMCPStyle(event);
      metadata.mcpStyleFormat = true;
      metadata.originalType = event.type;

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
        // Extract content from message.content array
        if (event.message?.content && Array.isArray(event.message.content)) {
          const textContent = event.message.content.find((c: any) => c.type === 'text');
          content = textContent?.text || 'Processing...';
        } else {
          content = 'Processing...';
        }
        metadata.messageId = event.message?.id;
        metadata.model = event.message?.model;
        metadata.usage = event.message?.usage;
        metadata.sessionId = event.session_id;
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