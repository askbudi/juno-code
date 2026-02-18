/**
 * Backend Manager for juno-code
 *
 * Manages the shell backend for executing subagent service scripts
 * located in ~/.juno_code/services/
 */

import type { JunoTaskConfig, SubagentType } from '../types/index.js';
import type { ProgressEvent, ProgressCallback, ToolCallRequest, ToolCallResult } from '../types/execution.js';

// =============================================================================
// Type Definitions
// =============================================================================

/**
 * Supported backend types (shell only after MCP removal)
 */
export type BackendType = 'shell';

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
  backendConfigs: Record<string, any>;
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

    // Configure shell backend
    const shellBackend = backend as any;
    shellBackend.configure({
      workingDirectory: options.workingDirectory,
      servicesPath: `${process.env.HOME || process.env.USERPROFILE}/.juno_code/services`,
      debug: options.config.verbose,
      timeout: options.config.mcpTimeout || 43200000, // 12 hours default
      enableJsonStreaming: true,
      outputRawJson: options.config.verbose, // Output full JSON in verbose mode
      environment: process.env,
      ...options.additionalOptions
    });

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

      const shellBackend = backend as any;
      shellBackend.configure({
        servicesPath: `${process.env.HOME || process.env.USERPROFILE}/.juno_code/services`,
        workingDirectory: process.cwd()
      });

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
 * Determine backend type from environment variable or CLI argument.
 * Always returns 'shell' since MCP has been removed.
 */
export function determineBackendType(
  cliBackend?: string,
  envVariable?: string,
  defaultType: BackendType = 'shell'
): BackendType {
  // Accept 'shell' or legacy 'mcp' (map to shell)
  if (cliBackend) {
    const normalized = cliBackend.toLowerCase().trim();
    if (normalized === 'shell') {
      return 'shell';
    }
    if (normalized === 'mcp') {
      // Legacy: silently map MCP to shell
      return 'shell';
    }
    throw new Error(`Invalid backend type: ${cliBackend}. Use 'shell'.`);
  }

  if (envVariable) {
    const normalized = envVariable.toLowerCase().trim();
    if (normalized === 'shell' || normalized === 'mcp') {
      return 'shell';
    }
    console.warn(`Invalid JUNO_CODE_AGENT value: ${envVariable}. Using default: shell`);
  }

  return 'shell';
}

/**
 * Validate backend type string
 */
export function isValidBackendType(type: string): type is BackendType {
  return type === 'shell';
}

/**
 * Get backend display name
 */
export function getBackendDisplayName(type: BackendType): string {
  return 'Shell Scripts';
}

/**
 * Create default backend manager configuration
 */
export function createDefaultBackendManagerConfig(): BackendManagerConfig {
  return {
    defaultBackend: 'shell',
    availableBackends: ['shell'],
    backendConfigs: {
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
