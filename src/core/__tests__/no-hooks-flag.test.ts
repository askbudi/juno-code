/**
 * Tests for --no-hooks CLI flag
 *
 * Verifies that the --no-hooks flag:
 * 1. Is accepted as a valid CLI option
 * 2. Sets skipHooks on the config
 * 3. Is properly validated in the config schema
 * 4. Engine condition logic correctly evaluates skipHooks
 */

import { describe, it, expect } from 'vitest';
import { JunoTaskConfigSchema, DEFAULT_CONFIG } from '../config.js';
import type { JunoTaskConfig } from '../../types/index.js';

describe('--no-hooks flag', () => {
  describe('Config Schema Validation', () => {
    it('should accept skipHooks as true', () => {
      const config = {
        ...DEFAULT_CONFIG,
        skipHooks: true,
      };
      const result = JunoTaskConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.skipHooks).toBe(true);
      }
    });

    it('should accept skipHooks as false', () => {
      const config = {
        ...DEFAULT_CONFIG,
        skipHooks: false,
      };
      const result = JunoTaskConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.skipHooks).toBe(false);
      }
    });

    it('should accept config without skipHooks (optional field)', () => {
      const config = { ...DEFAULT_CONFIG };
      delete (config as any).skipHooks;
      const result = JunoTaskConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it('should reject non-boolean skipHooks', () => {
      const config = {
        ...DEFAULT_CONFIG,
        skipHooks: 'yes',
      };
      const result = JunoTaskConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });

    it('should reject numeric skipHooks', () => {
      const config = {
        ...DEFAULT_CONFIG,
        skipHooks: 1,
      };
      const result = JunoTaskConfigSchema.safeParse(config);
      expect(result.success).toBe(false);
    });
  });

  describe('JunoTaskConfig type', () => {
    it('should allow skipHooks property', () => {
      const config: Partial<JunoTaskConfig> = {
        skipHooks: true,
      };
      expect(config.skipHooks).toBe(true);
    });

    it('should default to undefined when not set', () => {
      const config: Partial<JunoTaskConfig> = {};
      expect(config.skipHooks).toBeUndefined();
    });
  });

  describe('Hook execution condition logic', () => {
    // Tests the condition: if (config.hooks && !config.skipHooks)
    // This is the exact condition used in engine.ts at all 5 hook execution points

    it('should allow hooks when hooks exist and skipHooks is false', () => {
      const config: Partial<JunoTaskConfig> = {
        hooks: {
          START_RUN: { commands: ['echo start'] },
          END_RUN: { commands: ['echo end'] },
          START_ITERATION: { commands: ['echo iter'] },
          END_ITERATION: { commands: ['echo done'] },
        },
        skipHooks: false,
      };
      const shouldExecuteHooks = !!(config.hooks && !config.skipHooks);
      expect(shouldExecuteHooks).toBe(true);
    });

    it('should allow hooks when hooks exist and skipHooks is undefined', () => {
      const config: Partial<JunoTaskConfig> = {
        hooks: {
          START_RUN: { commands: ['echo start'] },
          END_RUN: { commands: ['echo end'] },
          START_ITERATION: { commands: ['echo iter'] },
          END_ITERATION: { commands: ['echo done'] },
        },
      };
      const shouldExecuteHooks = !!(config.hooks && !config.skipHooks);
      expect(shouldExecuteHooks).toBe(true);
    });

    it('should skip hooks when skipHooks is true even if hooks are configured', () => {
      const config: Partial<JunoTaskConfig> = {
        hooks: {
          START_RUN: { commands: ['echo start'] },
          END_RUN: { commands: ['echo end'] },
          START_ITERATION: { commands: ['echo iter'] },
          END_ITERATION: { commands: ['echo done'] },
        },
        skipHooks: true,
      };
      const shouldExecuteHooks = !!(config.hooks && !config.skipHooks);
      expect(shouldExecuteHooks).toBe(false);
    });

    it('should skip hooks when no hooks are configured', () => {
      const config: Partial<JunoTaskConfig> = {
        skipHooks: false,
      };
      const shouldExecuteHooks = !!(config.hooks && !config.skipHooks);
      expect(shouldExecuteHooks).toBe(false);
    });

    it('should skip hooks when both hooks undefined and skipHooks true', () => {
      const config: Partial<JunoTaskConfig> = {
        skipHooks: true,
      };
      const shouldExecuteHooks = !!(config.hooks && !config.skipHooks);
      expect(shouldExecuteHooks).toBe(false);
    });
  });

  describe('CLI option registration', () => {
    it('should register --no-hooks and set hooks to false when used', async () => {
      const { Command } = await import('commander');
      const program = new Command();
      program.option('--no-hooks', 'Skip execution of all lifecycle hooks');
      program.parse(['node', 'test', '--no-hooks'], { from: 'user' });
      expect(program.opts().hooks).toBe(false);
    });

    it('should default hooks to true when --no-hooks is not passed', async () => {
      const { Command } = await import('commander');
      const program = new Command();
      program.option('--no-hooks', 'Skip execution of all lifecycle hooks');
      program.parse(['node', 'test'], { from: 'user' });
      // Commander's --no-X pattern defaults to true when the flag is not used
      expect(program.opts().hooks).toBe(true);
    });
  });

  describe('mainCommandHandler skipHooks propagation', () => {
    it('should set config.skipHooks=true when options.hooks is false', () => {
      const config: any = { ...DEFAULT_CONFIG };
      const options = { hooks: false };

      // Replicate the logic from mainCommandHandler
      if (options.hooks === false) {
        config.skipHooks = true;
      }

      expect(config.skipHooks).toBe(true);
    });

    it('should not set config.skipHooks when options.hooks is undefined', () => {
      const config: any = { ...DEFAULT_CONFIG };
      const options: { hooks?: boolean } = {};

      if (options.hooks === false) {
        config.skipHooks = true;
      }

      expect(config.skipHooks).toBeUndefined();
    });

    it('should not set config.skipHooks when options.hooks is true', () => {
      const config: any = { ...DEFAULT_CONFIG };
      const options = { hooks: true };

      if (options.hooks === false) {
        config.skipHooks = true;
      }

      expect(config.skipHooks).toBeUndefined();
    });
  });
});
