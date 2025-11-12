/**
 * Startup JSON configuration validation for juno-task-ts
 *
 * Validates JSON configuration files on CLI startup to ensure proper format
 * and structure before command execution. Shows clear error messages on screen
 * and logs detailed information to file.
 */

import fs from 'fs-extra';
import path from 'node:path';
import chalk from 'chalk';
import { getMCPLogger } from './logger.js';

export interface ValidationResult {
  isValid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

export interface ValidationError {
  file: string;
  type: 'parse_error' | 'structure_error' | 'missing_file' | 'permission_error';
  message: string;
  details?: string;
  suggestions?: string[];
}

export interface ValidationWarning {
  file: string;
  type: 'deprecated_field' | 'missing_optional' | 'unusual_value';
  message: string;
  suggestions?: string[];
}

export interface ConfigSchema {
  file: string;
  required: boolean;
  schema: {
    requiredFields?: string[];
    optionalFields?: string[];
    expectedTypes?: Record<string, string>;
    customValidator?: (data: any) => { isValid: boolean; errors: string[]; warnings: string[] };
  };
}

/**
 * Backend type for conditional validation
 */
type BackendType = 'mcp' | 'shell';

/**
 * Standard JSON configuration files to validate
 * Note: MCP configuration is only required for MCP backend
 */
function getConfigSchemas(backendType: BackendType): ConfigSchema[] {
  const schemas: ConfigSchema[] = [];

  // Only add MCP configuration validation if using MCP backend
  if (backendType === 'mcp') {
    schemas.push(
  {
    file: '.juno_task/mcp.json',
    required: true,
    schema: {
      requiredFields: ['mcpServers', 'default_server'],
      optionalFields: ['global_settings', 'project_config'],
      expectedTypes: {
        'mcpServers': 'object',
        'default_server': 'string',
        'global_settings': 'object',
        'project_config': 'object'
      },
      customValidator: (data: any) => {
        const errors: string[] = [];
        const warnings: string[] = [];

        // Validate mcpServers structure
        if (data.mcpServers && typeof data.mcpServers === 'object') {
          for (const [serverName, config] of Object.entries(data.mcpServers)) {
            const serverConfig = config as any;

            // Check required server fields
            const requiredServerFields = ['name', 'command', 'args'];
            for (const field of requiredServerFields) {
              if (!serverConfig[field]) {
                errors.push(`Server '${serverName}' missing required field: ${field}`);
              }
            }

            // Validate timeout if present
            if (serverConfig.timeout && typeof serverConfig.timeout !== 'number') {
              errors.push(`Server '${serverName}' timeout must be a number`);
            }

            // Validate env if present
            if (serverConfig.env && typeof serverConfig.env !== 'object') {
              errors.push(`Server '${serverName}' env must be an object`);
            }
          }
        }

        // Check if default_server exists in mcpServers
        if (data.default_server && data.mcpServers) {
          if (!data.mcpServers[data.default_server]) {
            errors.push(`default_server '${data.default_server}' not found in mcpServers`);
          }
        }

        return { isValid: errors.length === 0, errors, warnings };
      }
    }
    });
  }

  // Always add project configuration validation regardless of backend
  schemas.push({
    file: '.juno_task/config.json',
    required: false,
    schema: {
      optionalFields: ['defaultSubagent', 'defaultModel', 'defaultMaxIterations'],
      expectedTypes: {
        'defaultSubagent': 'string',
        'defaultModel': 'string',
        'defaultMaxIterations': 'number'
      },
      customValidator: (data: any) => {
        const errors: string[] = [];
        const warnings: string[] = [];

        // Validate subagent values
        if (data.defaultSubagent) {
          const validSubagents = ['claude', 'cursor', 'codex', 'gemini'];
          if (!validSubagents.includes(data.defaultSubagent)) {
            warnings.push(`defaultSubagent '${data.defaultSubagent}' is not a standard subagent. Valid options: ${validSubagents.join(', ')}`);
          }
        }

        // Validate max iterations
        if (data.defaultMaxIterations !== undefined) {
          if (typeof data.defaultMaxIterations !== 'number' || data.defaultMaxIterations < -1) {
            errors.push('defaultMaxIterations must be a number >= -1 (-1 for unlimited)');
          }
        }

        return { isValid: errors.length === 0, errors, warnings };
      }
    }
  });

  return schemas;
}

/**
 * Validate a single JSON file
 */
async function validateJSONFile(configSchema: ConfigSchema, baseDir: string): Promise<ValidationResult> {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];
  const filePath = path.join(baseDir, configSchema.file);

  try {
    // Check if file exists
    const exists = await fs.pathExists(filePath);

    if (!exists) {
      if (configSchema.required) {
        errors.push({
          file: configSchema.file,
          type: 'missing_file',
          message: `Required configuration file not found: ${configSchema.file}`,
          suggestions: [
            'Run "juno-task init" to create initial configuration',
            `Create ${configSchema.file} manually with proper structure`
          ]
        });
      } else {
        warnings.push({
          file: configSchema.file,
          type: 'missing_optional',
          message: `Optional configuration file not found: ${configSchema.file}`,
          suggestions: [`Create ${configSchema.file} to customize default settings`]
        });
      }
      return { isValid: !configSchema.required, errors, warnings };
    }

    // Check file permissions
    try {
      await fs.access(filePath, fs.constants.R_OK);
    } catch (accessError) {
      errors.push({
        file: configSchema.file,
        type: 'permission_error',
        message: `Cannot read configuration file: ${configSchema.file}`,
        details: `Permission denied: ${accessError}`,
        suggestions: [
          `Check file permissions for ${filePath}`,
          'Ensure the file is readable by the current user'
        ]
      });
      return { isValid: false, errors, warnings };
    }

    // Read and parse JSON
    let jsonData: any;
    try {
      const fileContent = await fs.readFile(filePath, 'utf8');
      jsonData = JSON.parse(fileContent);
    } catch (parseError) {
      const errorMessage = parseError instanceof Error ? parseError.message : String(parseError);
      errors.push({
        file: configSchema.file,
        type: 'parse_error',
        message: `Invalid JSON syntax in ${configSchema.file}`,
        details: errorMessage,
        suggestions: [
          'Check for missing commas, brackets, or quotes',
          'Use a JSON validator to identify syntax errors',
          'Ensure proper escaping of special characters'
        ]
      });
      return { isValid: false, errors, warnings };
    }

    // Validate structure
    const schema = configSchema.schema;

    // Check required fields
    if (schema.requiredFields) {
      for (const field of schema.requiredFields) {
        if (!(field in jsonData)) {
          errors.push({
            file: configSchema.file,
            type: 'structure_error',
            message: `Missing required field: ${field}`,
            suggestions: [`Add '${field}' field to ${configSchema.file}`]
          });
        }
      }
    }

    // Check field types
    if (schema.expectedTypes) {
      for (const [field, expectedType] of Object.entries(schema.expectedTypes)) {
        if (field in jsonData) {
          const actualType = typeof jsonData[field];
          if (actualType !== expectedType) {
            errors.push({
              file: configSchema.file,
              type: 'structure_error',
              message: `Field '${field}' has incorrect type: expected ${expectedType}, got ${actualType}`,
              suggestions: [`Change '${field}' to be of type ${expectedType}`]
            });
          }
        }
      }
    }

    // Run custom validation
    if (schema.customValidator) {
      const customResult = schema.customValidator(jsonData);
      if (!customResult.isValid) {
        errors.push(...customResult.errors.map(error => ({
          file: configSchema.file,
          type: 'structure_error' as const,
          message: error
        })));
      }
      warnings.push(...customResult.warnings.map(warning => ({
        file: configSchema.file,
        type: 'unusual_value' as const,
        message: warning
      })));
    }

  } catch (unexpectedError) {
    // For certain system-level errors, we should throw rather than treat as validation error
    if (unexpectedError instanceof Error) {
      const errorMessage = unexpectedError.message.toLowerCase();
      const isSystemError = errorMessage.includes('system error') ||
                           errorMessage.includes('enoent') ||
                           errorMessage.includes('cannot read') ||
                           errorMessage.includes('operation not permitted');

      if (isSystemError) {
        // Re-throw system errors so they can be handled at the validateStartupConfigs level
        throw unexpectedError;
      }
    }

    errors.push({
      file: configSchema.file,
      type: 'permission_error',
      message: `Unexpected error validating ${configSchema.file}`,
      details: unexpectedError instanceof Error ? unexpectedError.message : String(unexpectedError)
    });
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * Validate all JSON configuration files
 */
export async function validateJSONConfigs(baseDir: string = process.cwd(), backendType: BackendType = 'mcp'): Promise<ValidationResult> {
  const allErrors: ValidationError[] = [];
  const allWarnings: ValidationWarning[] = [];

  // Get schemas based on backend type
  const configSchemas = getConfigSchemas(backendType);

  // Validate each configuration file
  for (const configSchema of configSchemas) {
    const result = await validateJSONFile(configSchema, baseDir);
    allErrors.push(...result.errors);
    allWarnings.push(...result.warnings);
  }

  return {
    isValid: allErrors.length === 0,
    errors: allErrors,
    warnings: allWarnings
  };
}

/**
 * Display validation results to console with colored output
 */
export function displayValidationResults(result: ValidationResult): void {
  if (result.isValid && result.warnings.length === 0) {
    console.error(chalk.green('✅ All configuration files are valid\n'));
    return;
  }

  if (result.errors.length > 0) {
    console.error(chalk.red.bold('\n❌ Configuration Validation Errors:\n'));

    for (const error of result.errors) {
      console.error(chalk.red(`   📄 ${error.file}`));
      console.error(chalk.red(`      ${error.message}`));

      if (error.details) {
        console.error(chalk.gray(`      Details: ${error.details}`));
      }

      if (error.suggestions?.length) {
        console.error(chalk.yellow('      Suggestions:'));
        for (const suggestion of error.suggestions) {
          console.error(chalk.yellow(`      • ${suggestion}`));
        }
      }
      console.error();
    }
  }

  if (result.warnings.length > 0) {
    console.error(chalk.yellow.bold('\n⚠️  Configuration Warnings:\n'));

    for (const warning of result.warnings) {
      console.error(chalk.yellow(`   📄 ${warning.file}`));
      console.error(chalk.yellow(`      ${warning.message}`));

      if (warning.suggestions?.length) {
        console.error(chalk.gray('      Suggestions:'));
        for (const suggestion of warning.suggestions) {
          console.error(chalk.gray(`      • ${suggestion}`));
        }
      }
      console.error();
    }
  }
}

/**
 * Log validation results to startup validation log file
 */
export async function logValidationResults(result: ValidationResult, baseDir: string = process.cwd()): Promise<string> {
  const logDir = path.join(baseDir, '.juno_task', 'logs');
  await fs.ensureDir(logDir);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logFile = path.join(logDir, `startup-validation-${timestamp}.log`);

  const logContent = [
    `# Juno-Task Startup Validation Log - ${new Date().toISOString()}`,
    ``,
    `## Summary`,
    `Overall Status: ${result.isValid ? 'VALID' : 'INVALID'}`,
    `Errors: ${result.errors.length}`,
    `Warnings: ${result.warnings.length}`,
    ``,
  ];

  if (result.errors.length > 0) {
    logContent.push(`## Errors`);
    for (const error of result.errors) {
      logContent.push(`### ${error.file} - ${error.type}`);
      logContent.push(`Message: ${error.message}`);
      if (error.details) {
        logContent.push(`Details: ${error.details}`);
      }
      if (error.suggestions?.length) {
        logContent.push(`Suggestions:`);
        for (const suggestion of error.suggestions) {
          logContent.push(`- ${suggestion}`);
        }
      }
      logContent.push(``);
    }
  }

  if (result.warnings.length > 0) {
    logContent.push(`## Warnings`);
    for (const warning of result.warnings) {
      logContent.push(`### ${warning.file} - ${warning.type}`);
      logContent.push(`Message: ${warning.message}`);
      if (warning.suggestions?.length) {
        logContent.push(`Suggestions:`);
        for (const suggestion of warning.suggestions) {
          logContent.push(`- ${suggestion}`);
        }
      }
      logContent.push(``);
    }
  }

  await fs.writeFile(logFile, logContent.join('\n'));
  return logFile;
}

/**
 * Main validation function that checks configs, displays results, and logs details
 * Returns true if validation passes, false if critical errors found
 */
export async function validateStartupConfigs(baseDir: string = process.cwd(), verbose: boolean = false): Promise<boolean> {
  if (verbose) {
    console.error(chalk.blue('🔍 Validating JSON configuration files...\n'));
  }

  try {
    // Determine backend type from CLI arguments and environment variables
    // This logic mirrors the backend determination in the CLI
    let backendType: BackendType = 'mcp'; // default

    // Check CLI arguments for backend flag
    const backendArgIndex = process.argv.findIndex(arg => arg === '-b' || arg === '--backend');
    if (backendArgIndex !== -1 && process.argv[backendArgIndex + 1]) {
      const cliBackend = process.argv[backendArgIndex + 1].toLowerCase().trim();
      if (cliBackend === 'shell' || cliBackend === 'mcp') {
        backendType = cliBackend as BackendType;
      }
    }

    // Check environment variables if no CLI backend specified
    if (backendType === 'mcp') { // only override default if not set via CLI
      const envBackend = process.env.JUNO_CODE_AGENT || process.env.JUNO_CODE_BACKEND || process.env.JUNO_TASK_BACKEND;
      if (envBackend) {
        const normalized = envBackend.toLowerCase().trim();
        if (normalized === 'shell' || normalized === 'mcp') {
          backendType = normalized as BackendType;
        }
      }
    }

    if (verbose) {
      console.error(chalk.gray(`   Backend: ${backendType} (${backendType === 'mcp' ? 'validating MCP configuration' : 'skipping MCP configuration'})`));
    }

    // Run validation
    const result = await validateJSONConfigs(baseDir, backendType);

    // Display results to console
    displayValidationResults(result);

    // Log detailed results to file
    const logFile = await logValidationResults(result, baseDir);

    if (result.errors.length > 0) {
      console.error(chalk.red(`❌ Configuration validation failed. See details in:`));
      console.error(chalk.gray(`   ${logFile}\n`));
      return false;
    }

    if (result.warnings.length > 0 && verbose) {
      console.error(chalk.yellow(`⚠️  Configuration warnings logged to:`));
      console.error(chalk.gray(`   ${logFile}\n`));
    }

    return true;

  } catch (error) {
    // Log validation system error
    try {
      const logger = getMCPLogger();
      await logger.error(`Startup validation system error: ${error instanceof Error ? error.message : String(error)}`);
    } catch (logError) {
      // Ignore logging errors during validation
    }

    console.error(chalk.red.bold('\n❌ Configuration validation system error'));
    console.error(chalk.red(`   ${error instanceof Error ? error.message : String(error)}`));
    console.error(chalk.yellow('   Continuing with startup, but configuration may be invalid\n'));

    return true; // Don't block startup for validation system errors
  }
}