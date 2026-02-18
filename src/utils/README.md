# Validation Utilities Module

The validation utilities module provides comprehensive validation capabilities for the juno-task-ts CLI tool. It includes Zod schemas, type guards, input sanitization, error handling, and configuration validation.

## Overview

The module is designed to ensure data integrity and provide user-friendly error messages throughout the juno-task-ts application. It supports:

- ✅ **Core validation functions** for subagents, models, iterations, log levels, and paths
- ✅ **Zod schemas** for runtime type validation and transformation
- ✅ **Type guards** for compile-time type checking
- ✅ **Input sanitization** for secure data processing
- ✅ **Error handling** with detailed messages and suggestions
- ✅ **Configuration validation** for CLI options and environment variables

## Core Validation Functions

### `validateSubagent(subagent: string): SubagentType`

Validates and normalizes subagent names including aliases.

```typescript
import { validateSubagent } from '@/utils/validation';

// Direct subagent names
const subagent1 = validateSubagent('claude'); // Returns 'claude'
const subagent2 = validateSubagent('cursor'); // Returns 'cursor'

// Aliases are automatically normalized
const subagent3 = validateSubagent('claude-code'); // Returns 'claude'
const subagent4 = validateSubagent('gemini-cli'); // Returns 'gemini'

// Throws ValidationError for invalid subagents
try {
  validateSubagent('invalid');
} catch (error) {
  console.log(error.message); // "Invalid subagent: invalid. Valid options: claude, cursor, codex, gemini"
}
```

### `validateModel(model: string, subagent?: SubagentType): string`

Validates model names with optional subagent-specific validation.

```typescript
import { validateModel } from '@/utils/validation';

const model1 = validateModel('claude-3-sonnet'); // Returns 'claude-3-sonnet'
const model2 = validateModel('gpt-4-turbo'); // Returns 'gpt-4-turbo'

// Warns for potentially incompatible models
validateModel('gpt-4', 'claude'); // Console warning but doesn't throw
```

### `validateIterations(iterations: number): number`

Validates iteration counts (positive integers or -1 for infinite).

```typescript
import { validateIterations } from '@/utils/validation';

const iterations1 = validateIterations(50); // Returns 50
const iterations2 = validateIterations(-1); // Returns Infinity
const iterations3 = validateIterations(0); // Throws ValidationError
```

### `validateLogLevel(logLevel: string): LogLevel`

Validates log level strings.

```typescript
import { validateLogLevel } from '@/utils/validation';

const level1 = validateLogLevel('info'); // Returns 'info'
const level2 = validateLogLevel('debug'); // Returns 'debug'
const level3 = validateLogLevel('invalid'); // Throws ValidationError
```

### `validatePaths(filePath: string, type: 'file' | 'directory'): Promise<string>`

Validates file and directory paths with existence checks.

```typescript
import { validatePaths } from '@/utils/validation';

// Validates existing file
const filePath = await validatePaths('/path/to/file.txt', 'file');

// Validates existing directory
const dirPath = await validatePaths('/path/to/directory', 'directory');

// Throws ValidationError for non-existent paths
try {
  await validatePaths('/non/existent/path', 'file');
} catch (error) {
  console.log(error.message); // "File does not exist or is not accessible"
}
```

## Zod Schemas

### `SubagentSchema`

Validates and transforms subagent names including aliases.

```typescript
import { SubagentSchema } from '@/utils/validation';

const result1 = SubagentSchema.parse('claude'); // 'claude'
const result2 = SubagentSchema.parse('claude-code'); // 'claude' (transformed)
const result3 = SubagentSchema.parse('invalid'); // Throws ZodError
```

### `LogLevelSchema`

Validates log levels with enum constraints.

```typescript
import { LogLevelSchema } from '@/utils/validation';

const level = LogLevelSchema.parse('info'); // 'info'
```

### `IterationsSchema`

Validates iteration counts with transformation for infinite iterations.

```typescript
import { IterationsSchema } from '@/utils/validation';

const iterations1 = IterationsSchema.parse(50); // 50
const iterations2 = IterationsSchema.parse(-1); // Infinity
```

### `FilePathSchema` / `DirectoryPathSchema`

Validates file and directory paths with existence checks.

```typescript
import { FilePathSchema, DirectoryPathSchema } from '@/utils/validation';

// Async validation with existence check
const filePath = await FilePathSchema.parseAsync('/path/to/file.txt');
const dirPath = await DirectoryPathSchema.parseAsync('/path/to/directory');
```

### `GitUrlSchema`

Validates Git repository URLs.

```typescript
import { GitUrlSchema } from '@/utils/validation';

const url1 = GitUrlSchema.parse('https://github.com/user/repo.git'); // Valid
const url2 = GitUrlSchema.parse('git@github.com:user/repo.git'); // Valid
const url3 = GitUrlSchema.parse('invalid-url'); // Throws ZodError
```

## Type Guards

Type guards provide compile-time type checking for better TypeScript support.

```typescript
import {
  isValidSubagent,
  isValidSessionStatus,
  isValidLogLevel,
  isValidPath
} from '@/utils/validation';

// Type guards return boolean and narrow types
if (isValidSubagent(value)) {
  // value is now typed as SubagentType
  console.log(`Valid subagent: ${value}`);
}

if (isValidLogLevel(level)) {
  // level is now typed as LogLevel
  console.log(`Log level: ${level}`);
}

// Async path validation
if (await isValidPath('/path/to/file', 'file')) {
  console.log('File exists');
}
```

## Input Sanitization

### `sanitizePromptText(text: string): string`

Cleans user input for prompts by removing control characters and normalizing line endings.

```typescript
import { sanitizePromptText } from '@/utils/validation';

const dirty = '  Hello\x00World\r\n\x1FTest  ';
const clean = sanitizePromptText(dirty); // 'HelloWorld\nTest'
```

### `sanitizeFilePath(filePath: string): string`

Normalizes and validates file paths by removing dangerous characters.

```typescript
import { sanitizeFilePath } from '@/utils/validation';

const dirty = 'file<>name:"|?*.txt';
const clean = sanitizeFilePath(dirty); // Absolute path to 'filename.txt'
```

### `sanitizeGitUrl(url: string): string`

Validates and normalizes Git repository URLs.

```typescript
import { sanitizeGitUrl } from '@/utils/validation';

const url = sanitizeGitUrl('https://github.com/user/repo.git');
// Returns validated URL or throws ValidationError
```

### `sanitizeSessionId(sessionId: string): string`

Validates session ID format.

```typescript
import { sanitizeSessionId } from '@/utils/validation';

const sessionId = sanitizeSessionId('session_12345-abc');
// Returns validated session ID or throws ValidationError
```

## Error Handling

### `ValidationError`

Custom error class with enhanced context and suggestions.

```typescript
import { ValidationError, formatValidationError } from '@/utils/validation';

const error = new ValidationError(
  'Invalid subagent type',
  'subagent',
  'invalid-type',
  ['Use: claude, cursor, codex, or gemini', 'Check for typos']
);

console.log(formatValidationError(error));
// Outputs formatted error with field, value, and suggestions
```

### `validateWithFallback<T>(validator, value, defaultValue, silent?): T`

Provides validation with fallback values for graceful error handling.

```typescript
import { validateWithFallback, validateLogLevel } from '@/utils/validation';

const level = validateWithFallback(
  validateLogLevel,
  'invalid-level',
  'info', // fallback
  true // silent
); // Returns 'info' without throwing
```

## Configuration Validation

### `validateConfig(config: unknown): JunoTaskConfig`

Validates complete configuration objects with enhanced error reporting.

```typescript
import { validateConfig } from '@/utils/validation';

const config = {
  defaultSubagent: 'claude',
  defaultMaxIterations: 50,
  logLevel: 'info',
  // ... other config properties
};

const validatedConfig = validateConfig(config);
```

### `validateEnvironmentVars(envVars: Record<string, string | undefined>): Partial<JunoTaskConfig>`

Validates environment variables and converts them to config format.

```typescript
import { validateEnvironmentVars } from '@/utils/validation';

const envConfig = validateEnvironmentVars({
  JUNO_TASK_DEFAULT_SUBAGENT: 'claude',
  JUNO_TASK_LOG_LEVEL: 'debug',
  JUNO_TASK_VERBOSE: 'true'
});
```

### `validateCommandOptions(options: Record<string, unknown>): Record<string, unknown>`

Validates CLI command options.

```typescript
import { validateCommandOptions } from '@/utils/validation';

const options = {
  subagent: 'claude',
  verbose: true,
  maxIterations: 50
};

const validatedOptions = validateCommandOptions(options);
```

## Utility Functions

### `validateJson(jsonString: string): unknown`

Safely parses JSON with validation error handling.

```typescript
import { validateJson } from '@/utils/validation';

const parsed = validateJson('{"key": "value"}');
```

### `validateUniqueArray<T>(array: T[], field?: string): T[]`

Validates that an array contains only unique values.

```typescript
import { validateUniqueArray } from '@/utils/validation';

const unique = validateUniqueArray(['claude', 'cursor', 'gemini']);
const duplicate = validateUniqueArray(['claude', 'claude']); // Throws ValidationError
```

### `validateNumberRange(value: number, min: number, max: number, field?: string): number`

Validates that a number is within a specified range.

```typescript
import { validateNumberRange } from '@/utils/validation';

const value = validateNumberRange(25, 1, 100, 'iterations'); // Returns 25
const invalid = validateNumberRange(150, 1, 100); // Throws ValidationError
```

### `validateStringLength(value: string, minLength: number, maxLength: number, field?: string): string`

Validates string length constraints.

```typescript
import { validateStringLength } from '@/utils/validation';

const value = validateStringLength('hello', 1, 10); // Returns 'hello'
const invalid = validateStringLength('', 1, 10); // Throws ValidationError
```

## Advanced Features

### Safe Validation

The module provides safe validation wrappers that return result objects instead of throwing:

```typescript
import { safeValidate, safeValidateAsync } from '@/utils';

// Synchronous safe validation
const result = safeValidate(validateSubagent, 'claude');
if (result.success) {
  console.log('Valid:', result.data);
} else {
  console.log('Error:', result.error);
  console.log('Suggestions:', result.suggestions);
}

// Asynchronous safe validation
const asyncResult = await safeValidateAsync(validatePaths, '/path/to/file');
```

### Validation Caching

For expensive validations, use the `ValidationCache` class:

```typescript
import { ValidationCache } from '@/utils';

const cache = new ValidationCache<string, string>(5 * 60 * 1000); // 5 minute TTL

const result = await cache.validate(
  'file-validation',
  '/path/to/file',
  async (path) => {
    // Expensive validation logic
    return path;
  }
);
```

### Batch Validation

Validate multiple values efficiently:

```typescript
import { batchValidate, safeValidate, validateSubagent } from '@/utils';

const subagents = ['claude', 'cursor', 'invalid'];
const results = await batchValidate(
  subagents,
  (value) => Promise.resolve(safeValidate(validateSubagent, value))
);
```

### Validation Pipeline

Create complex validation pipelines with middleware:

```typescript
import { createValidationPipeline, ValidationMiddleware } from '@/utils';

const sanitize: ValidationMiddleware<string> = async (value, next) => {
  const cleaned = value.trim();
  return next(cleaned);
};

const validate: ValidationMiddleware<string> = async (value, next) => {
  if (value.length < 3) {
    throw new Error('Too short');
  }
  return next(value);
};

const pipeline = createValidationPipeline([sanitize, validate]);
const result = await pipeline('  hello  '); // 'hello'
```

## Error Messages and Suggestions

All validation functions provide detailed error messages with suggestions for resolution:

- **Field context**: Identifies which field failed validation
- **Value information**: Shows the invalid value that was provided
- **Actionable suggestions**: Provides specific steps to fix the error
- **Type safety**: Maintains TypeScript type information throughout

## TypeScript Support

The validation utilities are built with TypeScript-first design:

- Full type inference for validated values
- Generic type parameters for flexible validation
- Strict type checking with `exactOptionalPropertyTypes`
- Comprehensive JSDoc documentation
- Type guards for runtime type narrowing

## Testing

The module includes comprehensive test coverage with Vitest:

```bash
npm test src/utils/__tests__/validation.test.ts
```

Tests cover:
- All core validation functions
- Zod schema transformations
- Type guard functionality
- Input sanitization
- Error handling scenarios
- Edge cases and error conditions

## Performance Considerations

- **Lazy evaluation**: Schemas are only parsed when needed
- **Caching support**: Built-in caching for expensive validations
- **Minimal dependencies**: Uses only Zod and Node.js built-ins
- **Tree shaking**: Supports ES modules for optimal bundling
- **Memory efficient**: Proper cleanup and garbage collection

## Best Practices

1. **Use type guards** for runtime type checking
2. **Prefer safe validation** in user-facing code
3. **Cache expensive validations** like file system checks
4. **Provide meaningful field names** in error contexts
5. **Handle validation errors gracefully** with fallbacks
6. **Use batch validation** for multiple related values
7. **Leverage TypeScript inference** for better developer experience

## Contributing

When adding new validation functions:

1. Include comprehensive JSDoc documentation
2. Add corresponding Zod schemas where appropriate
3. Implement type guards for TypeScript support
4. Provide detailed error messages with suggestions
5. Write comprehensive test coverage
6. Update this documentation