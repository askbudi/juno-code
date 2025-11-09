/**
 * MCP Configuration System
 *
 * Handles loading and managing MCP server configurations from .juno_task/mcp.json
 * Eliminates hardcoded server paths and provides centralized configuration management.
 */

import fs from 'fs-extra';
import * as path from 'node:path';
import { MCPConnectionError, MCPValidationError } from './errors.js';

export interface MCPServerConfig {
  name: string;
  command: string;
  args: string[];
  timeout: number;
  enable_default_progress_callback: boolean;
  suppress_subprocess_logs: boolean;
  env?: Record<string, string>;
  _metadata?: {
    description: string;
    capabilities: string[];
    working_directory: string;
    verbose: boolean;
    created_at: string;
    project_name: string;
    main_task: string;
  };
}

export interface MCPConfig {
  mcpServers: Record<string, MCPServerConfig>;
  default_server: string;
  global_settings: {
    connection_timeout: number;
    default_retries: number;
    enable_progress_streaming: boolean;
    log_level: string;
    debug_mode: boolean;
  };
  project_config: {
    name: string;
    main_task: string;
    preferred_subagent: string;
    created_at: string;
    version: string;
  };
}

/**
 * MCP Configuration Loader
 *
 * Loads and validates MCP configuration from .juno_task/mcp.json files
 */
export class MCPConfigLoader {
  private static configCache = new Map<string, MCPConfig>();
  private static lastLoadTime = new Map<string, number>();
  private static readonly CACHE_TTL = 30000; // 30 seconds

  /**
   * Load MCP configuration from .juno_task/mcp.json
   */
  static async loadConfig(workingDirectory?: string): Promise<MCPConfig> {
    const baseDir = workingDirectory || process.cwd();
    const configPath = await this.findConfigFile(baseDir);

    // Check cache first
    const cached = this.getCachedConfig(configPath);
    if (cached) {
      return cached;
    }

    try {
      const configContent = await fs.readFile(configPath, 'utf-8');
      const config = JSON.parse(configContent) as MCPConfig;

      // Validate configuration
      this.validateConfig(config);

      // Resolve relative paths to absolute paths
      const resolvedConfig = this.resolveConfigPaths(config, path.dirname(configPath));

      // Cache the configuration
      this.configCache.set(configPath, resolvedConfig);
      this.lastLoadTime.set(configPath, Date.now());

      return resolvedConfig;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new MCPValidationError(`Invalid JSON in MCP config: ${error.message}`, configPath);
      }
      throw new MCPConnectionError(`Failed to load MCP config from ${configPath}: ${error}`);
    }
  }

  /**
   * Find the mcp.json configuration file
   */
  private static async findConfigFile(startDir: string): Promise<string> {
    let currentDir = path.resolve(startDir);
    const rootDir = path.parse(currentDir).root;

    while (currentDir !== rootDir) {
      const configPath = path.join(currentDir, '.juno_task', 'mcp.json');

      if (await fs.pathExists(configPath)) {
        return configPath;
      }

      currentDir = path.dirname(currentDir);
    }

    throw new MCPConnectionError(
      `MCP configuration not found. Please run 'juno-task init' to create .juno_task/mcp.json`
    );
  }

  /**
   * Get cached configuration if valid
   */
  private static getCachedConfig(configPath: string): MCPConfig | null {
    const lastLoad = this.lastLoadTime.get(configPath);
    const config = this.configCache.get(configPath);

    if (config && lastLoad && (Date.now() - lastLoad) < this.CACHE_TTL) {
      return config;
    }

    return null;
  }

  /**
   * Validate MCP configuration structure
   */
  private static validateConfig(config: MCPConfig): void {
    if (!config.mcpServers || typeof config.mcpServers !== 'object') {
      throw new MCPValidationError('Invalid MCP config: mcpServers section is required');
    }

    if (!config.default_server || typeof config.default_server !== 'string') {
      throw new MCPValidationError('Invalid MCP config: default_server is required');
    }

    if (!config.mcpServers[config.default_server]) {
      throw new MCPValidationError(
        `Invalid MCP config: default_server '${config.default_server}' not found in mcpServers`
      );
    }

    // Validate each server configuration
    for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
      this.validateServerConfig(serverName, serverConfig);
    }
  }

  /**
   * Validate individual server configuration
   */
  private static validateServerConfig(serverName: string, config: MCPServerConfig): void {
    const required = ['name', 'command', 'args', 'timeout'];
    for (const field of required) {
      if (!(field in config)) {
        throw new MCPValidationError(
          `Invalid server config for '${serverName}': missing required field '${field}'`
        );
      }
    }

    if (!Array.isArray(config.args)) {
      throw new MCPValidationError(
        `Invalid server config for '${serverName}': args must be an array`
      );
    }

    if (typeof config.timeout !== 'number' || config.timeout <= 0) {
      throw new MCPValidationError(
        `Invalid server config for '${serverName}': timeout must be a positive number`
      );
    }
  }

  /**
   * Resolve relative paths in configuration to absolute paths
   */
  private static resolveConfigPaths(config: MCPConfig, configDir: string): MCPConfig {
    const resolvedConfig = JSON.parse(JSON.stringify(config)); // Deep clone

    for (const [serverName, serverConfig] of Object.entries(resolvedConfig.mcpServers)) {
      // Resolve server script paths
      serverConfig.args = serverConfig.args.map(arg => {
        // If arg looks like a file path (contains /) and is not absolute, resolve it
        if (arg.includes('/') && !path.isAbsolute(arg)) {
          return path.resolve(configDir, '..', arg); // Go up from .juno_task to project root
        }
        return arg;
      });

      // Resolve environment variable paths
      if (serverConfig.env) {
        for (const [envKey, envValue] of Object.entries(serverConfig.env)) {
          // Skip URL values (http://, https://, etc.) - they are not file paths
          const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(envValue);

          // Only resolve relative file paths, not URLs or absolute paths
          if (!isUrl && envValue.includes('/') && !path.isAbsolute(envValue)) {
            serverConfig.env[envKey] = path.resolve(configDir, '..', envValue);
          }
        }
      }
    }

    return resolvedConfig;
  }

  /**
   * Get server configuration by name
   */
  static async getServerConfig(serverName?: string, workingDirectory?: string): Promise<MCPServerConfig> {
    const config = await this.loadConfig(workingDirectory);
    const targetServer = serverName || config.default_server;

    const serverConfig = config.mcpServers[targetServer];
    if (!serverConfig) {
      throw new MCPConnectionError(`Server '${targetServer}' not found in MCP configuration`);
    }

    return serverConfig;
  }

  /**
   * Get default server configuration
   */
  static async getDefaultServerConfig(workingDirectory?: string): Promise<MCPServerConfig> {
    const config = await this.loadConfig(workingDirectory);
    return config.mcpServers[config.default_server];
  }

  /**
   * List available servers
   */
  static async listServers(workingDirectory?: string): Promise<string[]> {
    const config = await this.loadConfig(workingDirectory);
    return Object.keys(config.mcpServers);
  }

  /**
   * Clear configuration cache (useful for testing)
   */
  static clearCache(): void {
    this.configCache.clear();
    this.lastLoadTime.clear();
  }

  /**
   * Check if configuration file exists
   */
  static async hasConfig(workingDirectory?: string): Promise<boolean> {
    try {
      await this.findConfigFile(workingDirectory || process.cwd());
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get configuration file path
   */
  static async getConfigPath(workingDirectory?: string): Promise<string> {
    return this.findConfigFile(workingDirectory || process.cwd());
  }
}