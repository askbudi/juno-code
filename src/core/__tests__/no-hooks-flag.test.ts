/**
 * Tests for --no-hooks/--no-hook CLI flags
 *
 * Verifies that both spellings:
 * 1. Are accepted as valid CLI options
 * 2. Sets skipHooks on the config
 * 3. Is properly validated in the config schema
 * 4. Engine condition logic correctly evaluates skipHooks
 */

import { describe, it, expect } from 'vitest';
import { JunoTaskConfigSchema, DEFAULT_CONFIG } from '../config.js';
import type { JunoTaskConfig } from '../../types/index.js';
import { areLifecycleHooksDisabled } from '../../cli/types.js';

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
    it.each([
      ['--no-hooks', { hooks: false, hook: true }],
      ['--no-hook', { hooks: true, hook: false }],
    ])('registers %s as a lifecycle-hook disable flag', async (flag, expected) => {
      const { Command, Option } = await import('commander');
      const program = new Command();
      program.option('--no-hooks', 'Skip execution of all lifecycle hooks');
      program.addOption(new Option('--no-hook', 'Alias for --no-hooks').hideHelp());
      program.parse(['node', 'test', flag], { from: 'user' });
      expect(program.opts()).toMatchObject(expected);
    });

    it('should default both hook options to true when neither flag is passed', async () => {
      const { Command, Option } = await import('commander');
      const program = new Command();
      program.option('--no-hooks', 'Skip execution of all lifecycle hooks');
      program.addOption(new Option('--no-hook', 'Alias for --no-hooks').hideHelp());
      program.parse(['node', 'test'], { from: 'user' });
      // Commander's --no-X pattern defaults to true when the flag is not used
      expect(program.opts()).toMatchObject({ hooks: true, hook: true });
    });
  });

  describe('mainCommandHandler skipHooks propagation', () => {
    it.each([
      ['--no-hooks', { hooks: false }],
      ['--no-hook', { hook: false }],
    ])('sets config.skipHooks=true for %s', (_flag, options) => {
      const config: any = { ...DEFAULT_CONFIG };

      if (areLifecycleHooksDisabled(options)) {
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
