/**
 * Configuration Module Usage Examples
 *
 * This file demonstrates how to use the juno-task-ts configuration system
 * with various configuration sources and precedence levels.
 */

import {
  loadConfig,
  ConfigLoader,
  validateConfig,
  DEFAULT_CONFIG,
  ENV_VAR_MAPPING
} from '../src/core/config.js';
import type { JunoTaskConfig } from '../src/types/index.js';

/**
 * Example 1: Basic configuration loading with auto-discovery
 */
async function basicConfigLoading() {
  console.log('=== Basic Configuration Loading ===');

  try {
    // Load configuration with auto-discovery
    // This will search for config files and load environment variables
    const config = await loadConfig();

    console.log('Loaded configuration:', {
      defaultSubagent: config.defaultSubagent,
      logLevel: config.logLevel,
      workingDirectory: config.workingDirectory,
      mcpTimeout: config.mcpTimeout
    });
  } catch (error) {
    console.error('Configuration loading failed:', error);
  }
}

/**
 * Example 2: Loading with specific configuration file
 */
async function loadWithConfigFile() {
  console.log('\n=== Loading with Specific Config File ===');

  try {
    // Create a sample config file (in real usage, this would exist)
    const sampleConfig: Partial<JunoTaskConfig> = {
      defaultSubagent: 'cursor',
      defaultMaxIterations: 100,
      logLevel: 'debug',
      verbose: true,
      mcpTimeout: 45000
    };

    // In real usage, you would load from an actual file:
    // const config = await loadConfig({ configFile: './my-config.json' });

    console.log('Sample config that would be loaded:', sampleConfig);
  } catch (error) {
    console.error('File config loading failed:', error);
  }
}

/**
 * Example 3: Manual configuration with ConfigLoader class
 */
async function manualConfigLoading() {
  console.log('\n=== Manual Configuration with ConfigLoader ===');

  try {
    const loader = new ConfigLoader();

    // Load from environment variables
    loader.fromEnvironment();

    // Add CLI overrides
    const cliOverrides: Partial<JunoTaskConfig> = {
      verbose: true,
      logLevel: 'trace',
      interactive: false
    };
    loader.fromCli(cliOverrides);

    // Merge all sources
    const config = loader.merge();

    console.log('Manually loaded configuration:', {
      verbose: config.verbose,
      logLevel: config.logLevel,
      interactive: config.interactive,
      defaultSubagent: config.defaultSubagent
    });
  } catch (error) {
    console.error('Manual config loading failed:', error);
  }
}

/**
 * Example 4: Environment variable usage
 */
async function environmentVariableExample() {
  console.log('\n=== Environment Variable Usage ===');

  // Set some environment variables
  process.env.JUNO_TASK_DEFAULT_SUBAGENT = 'gemini';
  process.env.JUNO_TASK_VERBOSE = 'true';
  process.env.JUNO_TASK_LOG_LEVEL = 'debug';
  process.env.JUNO_TASK_MCP_TIMEOUT = '60000';

  try {
    const config = await loadConfig();

    console.log('Configuration with environment variables:', {
      defaultSubagent: config.defaultSubagent,
      verbose: config.verbose,
      logLevel: config.logLevel,
      mcpTimeout: config.mcpTimeout
    });

    console.log('\nAvailable environment variables:');
    Object.entries(ENV_VAR_MAPPING).forEach(([envVar, configKey]) => {
      console.log(`  ${envVar} -> ${configKey}`);
    });
  } catch (error) {
    console.error('Environment variable config failed:', error);
  } finally {
    // Clean up environment variables
    delete process.env.JUNO_TASK_DEFAULT_SUBAGENT;
    delete process.env.JUNO_TASK_VERBOSE;
    delete process.env.JUNO_TASK_LOG_LEVEL;
    delete process.env.JUNO_TASK_MCP_TIMEOUT;
  }
}

/**
 * Example 5: Configuration validation
 */
function configValidationExample() {
  console.log('\n=== Configuration Validation ===');

  try {
    // Valid configuration
    const validConfig = {
      ...DEFAULT_CONFIG,
      defaultSubagent: 'claude',
      defaultMaxIterations: 25,
      logLevel: 'warn'
    };

    const validated = validateConfig(validConfig);
    console.log('✅ Valid configuration passed validation');

    // Invalid configuration
    try {
      const invalidConfig = {
        ...DEFAULT_CONFIG,
        defaultSubagent: 'invalid-agent', // This will fail validation
        defaultMaxIterations: -5 // This will also fail
      };

      validateConfig(invalidConfig);
    } catch (validationError) {
      console.log('❌ Invalid configuration failed validation (as expected):',
        validationError instanceof Error ? validationError.message : validationError);
    }
  } catch (error) {
    console.error('Validation example failed:', error);
  }
}

/**
 * Example 6: Configuration precedence demonstration
 */
async function configPrecedenceExample() {
  console.log('\n=== Configuration Precedence ===');

  try {
    // Set environment variable
    process.env.JUNO_TASK_LOG_LEVEL = 'error';

    const loader = new ConfigLoader();

    // Load defaults (lowest precedence)
    console.log('1. Defaults - logLevel:', DEFAULT_CONFIG.logLevel);

    // Load environment (medium precedence)
    loader.fromEnvironment();
    let config = loader.merge();
    console.log('2. With Environment - logLevel:', config.logLevel);

    // Add CLI override (highest precedence)
    loader.fromCli({ logLevel: 'trace' });
    config = loader.merge();
    console.log('3. With CLI Override - logLevel:', config.logLevel);

    console.log('Final precedence order: CLI > Environment > File > Defaults');
  } catch (error) {
    console.error('Precedence example failed:', error);
  } finally {
    delete process.env.JUNO_TASK_LOG_LEVEL;
  }
}

/**
 * Example 7: Path resolution
 */
async function pathResolutionExample() {
  console.log('\n=== Path Resolution ===');

  try {
    const configWithRelativePaths: Partial<JunoTaskConfig> = {
      workingDirectory: './my-project',
      sessionDirectory: '../sessions',
      logFile: './logs/app.log'
    };

    const loader = new ConfigLoader('/home/user/workspace');
    loader.fromCli(configWithRelativePaths);

    const config = loader.merge();

    console.log('Path resolution example:');
    console.log('  Relative workingDirectory "./my-project" resolved to:', config.workingDirectory);
    console.log('  Relative sessionDirectory "../sessions" resolved to:', config.sessionDirectory);
    console.log('  Relative logFile "./logs/app.log" resolved to:', config.logFile);
  } catch (error) {
    console.error('Path resolution example failed:', error);
  }
}

/**
 * Run all examples
 */
async function runAllExamples() {
  console.log('Configuration Module Usage Examples\n');

  await basicConfigLoading();
  await loadWithConfigFile();
  await manualConfigLoading();
  await environmentVariableExample();
  configValidationExample();
  await configPrecedenceExample();
  await pathResolutionExample();

  console.log('\n=== All Examples Complete ===');
}

// Run examples if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runAllExamples().catch(console.error);
}

export {
  basicConfigLoading,
  loadWithConfigFile,
  manualConfigLoading,
  environmentVariableExample,
  configValidationExample,
  configPrecedenceExample,
  pathResolutionExample
};