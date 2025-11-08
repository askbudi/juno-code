/**
 * Configuration Profile Management for juno-code
 *
 * Provides comprehensive profile management including creation, switching,
 * inheritance, and import/export functionality as specified in config.md.
 *
 * @module core/profiles
 */

import { z } from 'zod';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import * as yaml from 'js-yaml';
import type { JunoTaskConfig, SubagentType, LogLevel } from '../types/index.js';

/**
 * Profile metadata interface
 */
export interface ProfileMetadata {
  /** Profile creation timestamp */
  created: string;
  /** Profile author */
  author?: string;
  /** Profile tags for organization */
  tags?: string[];
  /** Profile version for migrations */
  version?: string;
  /** Profile description */
  description?: string;
}

/**
 * Profile configuration interface
 */
export interface ProfileConfig {
  /** Profile name (must be unique) */
  name: string;
  /** Profile description */
  description?: string;
  /** Profiles to inherit from (applied in order) */
  inherits?: string[];
  /** Partial configuration for this profile */
  config: Partial<JunoTaskConfig>;
  /** Profile metadata */
  metadata?: ProfileMetadata;
}

/**
 * Profile storage format for persistence
 */
export interface ProfileStorage {
  /** Profile configuration */
  profile: ProfileConfig;
  /** Storage format version */
  version: string;
  /** Resolved configuration (computed, not stored) */
  resolvedConfig?: JunoTaskConfig;
}

/**
 * Zod schema for JunoTaskConfig (partial definition for profiles)
 * This is defined here to avoid circular dependency with config.ts
 */
const PartialJunoTaskConfigSchema = z.object({
  defaultSubagent: z.enum(['claude', 'cursor', 'codex', 'gemini']).optional(),
  defaultMaxIterations: z.number().int().min(1).max(1000).optional(),
  defaultModel: z.string().optional(),
  logLevel: z.enum(['error', 'warn', 'info', 'debug', 'trace']).optional(),
  logFile: z.string().optional(),
  verbose: z.boolean().optional(),
  quiet: z.boolean().optional(),
  mcpTimeout: z.number().int().min(1000).max(300000).optional(),
  mcpRetries: z.number().int().min(0).max(10).optional(),
  mcpServerPath: z.string().optional(),
  interactive: z.boolean().optional(),
  headlessMode: z.boolean().optional(),
  workingDirectory: z.string().optional(),
  sessionDirectory: z.string().optional(),
}).partial();

/**
 * Zod schema for profile validation
 */
const ProfileMetadataSchema = z.object({
  created: z.string(),
  author: z.string().optional(),
  tags: z.array(z.string()).optional(),
  version: z.string().optional(),
  description: z.string().optional(),
});

const ProfileConfigSchema = z.object({
  name: z.string()
    .min(1)
    .max(50)
    .regex(/^[a-zA-Z0-9_-]+$/, 'Profile name must contain only alphanumeric characters, underscores, and hyphens'),
  description: z.string().optional(),
  inherits: z.array(z.string()).optional(),
  config: PartialJunoTaskConfigSchema,
  metadata: ProfileMetadataSchema.optional(),
});

const ProfileStorageSchema = z.object({
  profile: ProfileConfigSchema,
  version: z.string(),
  resolvedConfig: PartialJunoTaskConfigSchema.optional(),
});

/**
 * Configuration Profile Manager
 *
 * Manages multiple named configuration profiles with inheritance,
 * switching, and import/export functionality.
 */
export class ProfileManager {
  private readonly profilesDir: string;
  private readonly activeProfileFile: string;
  private readonly defaultConfigFile: string;
  private profileCache = new Map<string, ProfileConfig>();
  private activeProfile: string | null = null;

  constructor(configDir: string) {
    this.profilesDir = path.join(configDir, 'profiles');
    this.activeProfileFile = path.join(configDir, 'active-profile.txt');
    this.defaultConfigFile = path.join(configDir, 'config.json');
  }

  /**
   * Initialize the profile system
   */
  async initialize(): Promise<void> {
    // Ensure profiles directory exists
    await fsPromises.mkdir(this.profilesDir, { recursive: true });

    // Create default profile if it doesn't exist
    if (!await this.profileExists('default')) {
      await this.createDefaultProfile();
    }

    // Load active profile or set default
    try {
      const activeProfileContent = await fsPromises.readFile(this.activeProfileFile, 'utf-8');
      this.activeProfile = activeProfileContent.trim();

      // Verify active profile exists
      if (!await this.profileExists(this.activeProfile)) {
        console.warn(`Active profile '${this.activeProfile}' not found, switching to default`);
        await this.setActiveProfile('default');
      }
    } catch {
      // No active profile set, use default
      await this.setActiveProfile('default');
    }
  }

  /**
   * List all available profiles
   */
  async listProfiles(): Promise<string[]> {
    try {
      const files = await fsPromises.readdir(this.profilesDir);
      const profiles: string[] = [];

      for (const file of files) {
        if (file.endsWith('.json') || file.endsWith('.yaml') || file.endsWith('.yml')) {
          const profileName = this.getProfileNameFromFile(file);
          if (profileName) {
            profiles.push(profileName);
          }
        }
      }

      return profiles.sort();
    } catch {
      return [];
    }
  }

  /**
   * Get a specific profile configuration
   */
  async getProfile(name: string): Promise<ProfileConfig | null> {
    // Check cache first
    if (this.profileCache.has(name)) {
      return this.profileCache.get(name)!;
    }

    const profilePath = await this.findProfileFile(name);
    if (!profilePath) {
      return null;
    }

    try {
      const content = await fsPromises.readFile(profilePath, 'utf-8');
      const data = profilePath.endsWith('.json')
        ? JSON.parse(content)
        : yaml.load(content);

      const storage = ProfileStorageSchema.parse(data);
      const profile = storage.profile;

      // Cache the profile
      this.profileCache.set(name, profile);
      return profile;
    } catch (error) {
      throw new Error(`Failed to load profile '${name}': ${error}`);
    }
  }

  /**
   * Get the currently active profile
   */
  getActiveProfileName(): string {
    return this.activeProfile || 'default';
  }

  /**
   * Get the active profile configuration with inheritance resolved
   */
  async getActiveProfile(): Promise<JunoTaskConfig> {
    const activeProfileName = this.getActiveProfileName();
    return await this.resolveProfile(activeProfileName);
  }

  /**
   * Set the active profile
   */
  async setActiveProfile(name: string): Promise<void> {
    if (!await this.profileExists(name)) {
      throw new Error(`Profile '${name}' does not exist`);
    }

    this.activeProfile = name;
    await fsPromises.writeFile(this.activeProfileFile, name, 'utf-8');
  }

  /**
   * Create a new profile
   */
  async createProfile(profile: ProfileConfig): Promise<void> {
    // Validate profile
    ProfileConfigSchema.parse(profile);

    // Check if profile already exists
    if (await this.profileExists(profile.name)) {
      throw new Error(`Profile '${profile.name}' already exists`);
    }

    // Validate inheritance chain
    if (profile.inherits) {
      await this.validateInheritanceChain(profile.inherits, [profile.name]);
    }

    // Add metadata if not provided
    if (!profile.metadata) {
      profile.metadata = {
        created: new Date().toISOString(),
        version: '1.0.0',
      };
    }

    // Create storage object
    const storage: ProfileStorage = {
      profile,
      version: '1.0.0',
    };

    // Save profile
    const profilePath = path.join(this.profilesDir, `${profile.name}.json`);
    await fsPromises.writeFile(profilePath, JSON.stringify(storage, null, 2), 'utf-8');

    // Clear cache
    this.profileCache.delete(profile.name);
  }

  /**
   * Update an existing profile
   */
  async updateProfile(name: string, updates: Partial<ProfileConfig>): Promise<void> {
    const existing = await this.getProfile(name);
    if (!existing) {
      throw new Error(`Profile '${name}' does not exist`);
    }

    // Merge updates
    const updated: ProfileConfig = {
      ...existing,
      ...updates,
      name, // Ensure name doesn't change
      metadata: {
        ...existing.metadata,
        ...updates.metadata,
      },
    };

    // Validate updated profile
    ProfileConfigSchema.parse(updated);

    // Validate inheritance chain if changed
    if (updates.inherits) {
      await this.validateInheritanceChain(updates.inherits, [name]);
    }

    // Save updated profile
    const storage: ProfileStorage = {
      profile: updated,
      version: '1.0.0',
    };

    const profilePath = await this.findProfileFile(name);
    if (profilePath) {
      await fsPromises.writeFile(profilePath, JSON.stringify(storage, null, 2), 'utf-8');
    }

    // Clear cache
    this.profileCache.delete(name);
  }

  /**
   * Delete a profile
   */
  async deleteProfile(name: string): Promise<void> {
    if (name === 'default') {
      throw new Error('Cannot delete the default profile');
    }

    if (!await this.profileExists(name)) {
      throw new Error(`Profile '${name}' does not exist`);
    }

    // If this is the active profile, switch to default
    if (this.getActiveProfileName() === name) {
      await this.setActiveProfile('default');
    }

    // Delete profile file
    const profilePath = await this.findProfileFile(name);
    if (profilePath) {
      await fsPromises.unlink(profilePath);
    }

    // Clear cache
    this.profileCache.delete(name);
  }

  /**
   * Export a profile to string format
   */
  async exportProfile(name: string, format: 'json' | 'yaml' = 'json'): Promise<string> {
    const profile = await this.getProfile(name);
    if (!profile) {
      throw new Error(`Profile '${name}' does not exist`);
    }

    const storage: ProfileStorage = {
      profile,
      version: '1.0.0',
    };

    if (format === 'yaml') {
      return yaml.dump(storage, { indent: 2 });
    } else {
      return JSON.stringify(storage, null, 2);
    }
  }

  /**
   * Import a profile from string data
   */
  async importProfile(data: string, format: 'json' | 'yaml' = 'json'): Promise<void> {
    let parsed: any;

    try {
      if (format === 'yaml') {
        parsed = yaml.load(data);
      } else {
        parsed = JSON.parse(data);
      }
    } catch (error) {
      throw new Error(`Failed to parse ${format}: ${error}`);
    }

    // Validate storage format
    const storage = ProfileStorageSchema.parse(parsed);

    // Create the profile
    await this.createProfile(storage.profile);
  }

  /**
   * Resolve a profile with all inheritance applied
   */
  async resolveProfile(name: string): Promise<JunoTaskConfig> {
    const profile = await this.getProfile(name);
    if (!profile) {
      throw new Error(`Profile '${name}' does not exist`);
    }

    // Start with an empty config and build up through inheritance
    let resolvedConfig: Partial<JunoTaskConfig> = {};

    // Apply inheritance chain in order
    if (profile.inherits) {
      for (const inheritedName of profile.inherits) {
        const inheritedConfig = await this.resolveProfile(inheritedName);
        resolvedConfig = this.mergeConfigs(resolvedConfig, inheritedConfig);
      }
    }

    // Apply this profile's config
    resolvedConfig = this.mergeConfigs(resolvedConfig, profile.config);

    // Apply defaults for any missing required fields
    const defaultConfig = this.getDefaultConfig();
    const finalConfig = this.mergeConfigs(defaultConfig, resolvedConfig);

    // Return the merged configuration (validation happens in config.ts)
    return finalConfig as JunoTaskConfig;
  }

  /**
   * Check if a profile exists
   */
  async profileExists(name: string): Promise<boolean> {
    const profilePath = await this.findProfileFile(name);
    return profilePath !== null;
  }

  /**
   * Get profile information including resolved configuration
   */
  async getProfileInfo(name: string): Promise<{
    profile: ProfileConfig;
    resolvedConfig: JunoTaskConfig;
    inheritance: string[];
  }> {
    const profile = await this.getProfile(name);
    if (!profile) {
      throw new Error(`Profile '${name}' does not exist`);
    }

    const resolvedConfig = await this.resolveProfile(name);
    const inheritance = await this.getInheritanceChain(name);

    return {
      profile,
      resolvedConfig,
      inheritance,
    };
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private async createDefaultProfile(): Promise<void> {
    const defaultProfile: ProfileConfig = {
      name: 'default',
      description: 'Default configuration profile',
      config: this.getDefaultConfig(),
      metadata: {
        created: new Date().toISOString(),
        author: 'system',
        version: '1.0.0',
        description: 'System-generated default profile',
      },
    };

    await this.createProfile(defaultProfile);
  }

  private async findProfileFile(name: string): Promise<string | null> {
    const extensions = ['.json', '.yaml', '.yml'];

    for (const ext of extensions) {
      const filePath = path.join(this.profilesDir, `${name}${ext}`);
      try {
        await fsPromises.access(filePath);
        return filePath;
      } catch {
        // File doesn't exist, try next extension
      }
    }

    return null;
  }

  private getProfileNameFromFile(filename: string): string | null {
    const match = filename.match(/^(.+)\.(json|yaml|yml)$/);
    return match ? match[1] : null;
  }

  private async validateInheritanceChain(inherits: string[], visited: string[] = []): Promise<void> {
    for (const inheritedName of inherits) {
      if (visited.includes(inheritedName)) {
        throw new Error(`Circular inheritance detected: ${visited.join(' -> ')} -> ${inheritedName}`);
      }

      if (!await this.profileExists(inheritedName)) {
        throw new Error(`Inherited profile '${inheritedName}' does not exist`);
      }

      const inheritedProfile = await this.getProfile(inheritedName);
      if (inheritedProfile?.inherits) {
        await this.validateInheritanceChain(inheritedProfile.inherits, [...visited, inheritedName]);
      }
    }
  }

  private async getInheritanceChain(name: string): Promise<string[]> {
    const profile = await this.getProfile(name);
    if (!profile?.inherits) {
      return [name];
    }

    const chain: string[] = [];
    for (const inheritedName of profile.inherits) {
      const inheritedChain = await this.getInheritanceChain(inheritedName);
      chain.push(...inheritedChain);
    }
    chain.push(name);

    return chain;
  }

  private mergeConfigs(base: Partial<JunoTaskConfig>, override: Partial<JunoTaskConfig>): Partial<JunoTaskConfig> {
    const result = { ...base };

    for (const [key, value] of Object.entries(override)) {
      if (value !== undefined) {
        (result as any)[key] = value;
      }
    }

    return result;
  }

  private getDefaultConfig(): JunoTaskConfig {
    return {
      // Core settings
      defaultSubagent: 'claude',
      defaultMaxIterations: 1,
      defaultModel: undefined,

      // Logging settings
      logLevel: 'info',
      logFile: undefined,
      verbose: false,
      quiet: false,

      // MCP settings
      mcpTimeout: 30000,
      mcpRetries: 3,
      mcpServerPath: undefined,

      // TUI settings
      interactive: false,
      headlessMode: false,

      // Paths
      workingDirectory: process.cwd(),
      sessionDirectory: path.join(process.cwd(), '.juno_task', 'sessions'),
    };
  }
}

/**
 * Create a profile manager instance
 */
export function createProfileManager(configDir: string): ProfileManager {
  return new ProfileManager(configDir);
}

/**
 * Profile management errors
 */
export class ProfileError extends Error {
  constructor(message: string, public readonly code: string = 'PROFILE_ERROR') {
    super(message);
    this.name = 'ProfileError';
  }
}

export class ProfileNotFoundError extends ProfileError {
  constructor(profileName: string) {
    super(`Profile '${profileName}' not found`, 'PROFILE_NOT_FOUND');
    this.name = 'ProfileNotFoundError';
  }
}

export class ProfileExistsError extends ProfileError {
  constructor(profileName: string) {
    super(`Profile '${profileName}' already exists`, 'PROFILE_EXISTS');
    this.name = 'ProfileExistsError';
  }
}

export class CircularInheritanceError extends ProfileError {
  constructor(chain: string[]) {
    super(`Circular inheritance detected: ${chain.join(' -> ')}`, 'CIRCULAR_INHERITANCE');
    this.name = 'CircularInheritanceError';
  }
}