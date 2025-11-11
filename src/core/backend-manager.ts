/**
 * Backend Manager for juno-code
 *
 * Manages backend selection and execution between MCP and shell backends.
 * Supports both MCP servers and shell scripts in ~/.juno_code/services/
 */

import type { JunoTaskConfig, SubagentType } from '../types/index.js';
import type { ProgressEvent, ProgressCallback, ToolCallRequest, ToolCallResult } from '../mcp/types.js';

// =============================================================================
// Type Definitions
// =============================================================================

/**
 * Supported backend types
 */
export type BackendType = 'mcp' | 'shell';

/**
 * Backend interface that all backends must implement
 */
export interface Backend {
  /** Backend type identifier */
  readonly type: BackendType;

  /** Backend name for display */
  readonly name: string;

  /** Initialize the backend */
  initialize(): Promise<void>;

  /** Execute a tool call request */
  execute(request: ToolCallRequest): Promise<ToolCallResult>;

  /** Clean up backend resources */
  cleanup(): Promise<void>;

  /** Check if backend is available */
  isAvailable(): Promise<boolean>;

  /** Set progress callback */
  onProgress(callback: ProgressCallback): () => void;
}

/**
 * Backend selection options
 */
export interface BackendOptions {
  /** Backend type to use */
  type: BackendType;

  /** Configuration for the backend */
  config: JunoTaskConfig;

  /** Working directory */
  workingDirectory: string;

  /** Optional MCP server name (for MCP backend) */
  mcpServerName?: string;

  /** Additional backend-specific options */
  additionalOptions?: Record<string, any>;
}

/**
 * Backend manager configuration
 */
export interface BackendManagerConfig {
  /** Default backend type */
  defaultBackend: BackendType;

  /** Available backends */
  availableBackends: BackendType[];

  /** Backend-specific configuration */
  backendConfigs: Record<BackendType, any>;
}

// =============================================================================
// Backend Manager Class
// =============================================================================

/**
 * Manages backend selection and lifecycle
 */
export class BackendManager {
  private currentBackend: Backend | null = null;
  private availableBackends: Map<BackendType, () => Promise<Backend>> = new Map();

  constructor(private config: BackendManagerConfig) {
    this.registerBackends();
  }

  /**
   * Register available backend implementations
   */
  private registerBackends(): void {
    // MCP backend factory
    this.availableBackends.set('mcp', async () => {
      const { MCPBackend } = await import('./backends/mcp-backend.js');
      return new MCPBackend();
    });

    // Shell backend factory
    this.availableBackends.set('shell', async () => {
      const { ShellBackend } = await import('./backends/shell-backend.js');
      return new ShellBackend();
    });
  }

  /**
   * Select and initialize a backend
   */
  async selectBackend(options: BackendOptions): Promise<Backend> {
    // Clean up current backend if exists
    if (this.currentBackend) {
      await this.currentBackend.cleanup();
      this.currentBackend = null;
    }

    // Validate backend type
    if (!this.availableBackends.has(options.type)) {
      throw new Error(`Unsupported backend type: ${options.type}`);
    }

    // Create backend instance
    const backendFactory = this.availableBackends.get(options.type)!;
    const backend = await backendFactory();

    // Configure backend based on type
    if (options.type === 'mcp') {
      const mcpBackend = backend as any;
      mcpBackend.configure({
        serverName: options.mcpServerName || options.config.mcpServerPath,
        workingDirectory: options.workingDirectory,
        timeout: options.config.mcpTimeout,
        retries: options.config.mcpRetries,
        debug: options.config.verbose,
        enableProgressStreaming: true,
        ...options.additionalOptions
      });
    } else if (options.type === 'shell') {
      const shellBackend = backend as any;
      shellBackend.configure({
        workingDirectory: options.workingDirectory,
        servicesPath: `${process.env.HOME || process.env.USERPROFILE}/.juno_code/services`,
        debug: options.config.verbose,
        timeout: options.config.mcpTimeout || 300000,
        enableJsonStreaming: true,
        outputRawJson: options.config.verbose, // Output full JSON in verbose mode
        environment: process.env,
        ...options.additionalOptions
      });
    }

    // Initialize the backend
    await backend.initialize();

    // Check availability
    const isAvailable = await backend.isAvailable();
    if (!isAvailable) {
      throw new Error(`Backend ${options.type} is not available`);
    }

    this.currentBackend = backend;
    return backend;
  }

  /**
   * Get the current active backend
   */
  getCurrentBackend(): Backend | null {
    return this.currentBackend;
  }

  /**
   * Execute a tool call using the current backend
   */
  async execute(request: ToolCallRequest): Promise<ToolCallResult> {
    if (!this.currentBackend) {
      throw new Error('No backend selected. Call selectBackend() first.');
    }

    return this.currentBackend.execute(request);
  }

  /**
   * Check if a backend type is available
   */
  async isBackendAvailable(type: BackendType): Promise<boolean> {
    if (!this.availableBackends.has(type)) {
      return false;
    }

    try {
      const factory = this.availableBackends.get(type)!;
      const backend = await factory();

      // For shell backend, check if services directory exists
      if (type === 'shell') {
        const shellBackend = backend as any;
        shellBackend.configure({
          servicesPath: `${process.env.HOME || process.env.USERPROFILE}/.juno_code/services`,
          workingDirectory: process.cwd()
        });
      }

      const available = await backend.isAvailable();
      await backend.cleanup();
      return available;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get all available backend types
   */
  getAvailableBackends(): BackendType[] {
    return Array.from(this.availableBackends.keys());
  }

  /**
   * Set progress callback on current backend
   */
  onProgress(callback: ProgressCallback): () => void {
    if (!this.currentBackend) {
      throw new Error('No backend selected');
    }

    return this.currentBackend.onProgress(callback);
  }

  /**
   * Clean up all resources
   */
  async cleanup(): Promise<void> {
    if (this.currentBackend) {
      await this.currentBackend.cleanup();
      this.currentBackend = null;
    }
  }
}

// =============================================================================
// Backend Selection Utilities
// =============================================================================

/**
 * Determine backend type from environment variable or CLI argument
 */
export function determineBackendType(
  cliBackend?: string,
  envVariable?: string,
  defaultType: BackendType = 'mcp'
): BackendType {
  // CLI argument takes precedence
  if (cliBackend) {
    const normalized = cliBackend.toLowerCase().trim();
    if (normalized === 'mcp' || normalized === 'shell') {
      return normalized as BackendType;
    }
    throw new Error(`Invalid backend type: ${cliBackend}. Use 'mcp' or 'shell'.`);
  }

  // Environment variable is second priority
  if (envVariable) {
    const normalized = envVariable.toLowerCase().trim();
    if (normalized === 'mcp' || normalized === 'shell') {
      return normalized as BackendType;
    }
    console.warn(`Invalid JUNO_CODE_AGENT value: ${envVariable}. Using default: ${defaultType}`);
  }

  return defaultType;
}

/**
 * Validate backend type string
 */
export function isValidBackendType(type: string): type is BackendType {
  return type === 'mcp' || type === 'shell';
}

/**
 * Get backend display name
 */
export function getBackendDisplayName(type: BackendType): string {
  switch (type) {
    case 'mcp':
      return 'MCP (Model Context Protocol)';
    case 'shell':
      return 'Shell Scripts';
    default:
      return type;
  }
}

/**
 * Create default backend manager configuration
 */
export function createDefaultBackendManagerConfig(): BackendManagerConfig {
  return {
    defaultBackend: 'mcp',
    availableBackends: ['mcp', 'shell'],
    backendConfigs: {
      mcp: {
        timeout: 30000,
        retries: 3,
        enableProgressStreaming: true
      },
      shell: {
        timeout: 30000,
        enableJsonStreaming: true,
        servicesPaths: [`${process.env.HOME || process.env.USERPROFILE}/.juno_code/services`]
      }
    }
  };
}

/**
 * Factory function to create a configured backend manager
 */
export function createBackendManager(config?: Partial<BackendManagerConfig>): BackendManager {
  const defaultConfig = createDefaultBackendManagerConfig();
  const finalConfig = { ...defaultConfig, ...config };
  return new BackendManager(finalConfig);
}