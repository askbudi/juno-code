/**
 * Validation Error Classes
 *
 * Handles input validation, schema validation, and data integrity errors
 * across all modules with rich context and recovery suggestions.
 */

import { JunoTaskError, RecoveryAction, RecoveryActionType } from './base';
import { ErrorCategory } from './categories';
import { ErrorCode } from './codes';
import type { ErrorContext } from './context';

/**
 * Base class for all validation-related errors
 */
export abstract class ValidationError extends JunoTaskError {
  public abstract readonly code: ErrorCode;
  public readonly category = ErrorCategory.VALIDATION;
}

/**
 * Required field missing error
 */
export class RequiredFieldError extends ValidationError {
  public readonly code = ErrorCode.VALIDATION_REQUIRED_FIELD;

  constructor(
    fieldName: string,
    context?: {
      fieldPath?: string;
      expectedType?: string;
      parentObject?: string;
      validationContext?: Record<string, unknown>;
      errorContext?: Partial<ErrorContext>;
      cause?: Error;
    }
  ) {
    const message = context?.fieldPath
      ? `Required field '${fieldName}' is missing at path: ${context.fieldPath}`
      : `Required field '${fieldName}' is missing`;

    super(message, {
      code: ErrorCode.VALIDATION_REQUIRED_FIELD,
      context: {
        ...context?.errorContext,
        metadata: {
          fieldName,
          fieldPath: context?.fieldPath,
          expectedType: context?.expectedType,
          parentObject: context?.parentObject,
          validationContext: context?.validationContext,
          ...context?.errorContext?.metadata
        },
        recoverySuggestions: [
          `Provide a value for the required field '${fieldName}'`,
          context?.expectedType ? `Expected type: ${context.expectedType}` : 'Check the expected data type',
          'Review the input data structure',
          'Check API documentation for required fields'
        ].filter(Boolean),
        isRetriable: false
      },
      cause: context?.cause,
      recoveryActions: [
        {
          id: 'provide_default_value',
          description: `Provide default value for '${fieldName}'`,
          type: RecoveryActionType.REPAIR,
          canAutomate: true,
          successProbability: 0.7
        },
        {
          id: 'make_field_optional',
          description: `Make field '${fieldName}' optional`,
          type: RecoveryActionType.FALLBACK,
          canAutomate: false,
          successProbability: 0.9
        }
      ]
    });
  }
}

/**
 * Invalid format error for field values
 */
export class InvalidFormatError extends ValidationError {
  public readonly code = ErrorCode.VALIDATION_INVALID_FORMAT;

  constructor(
    fieldName: string,
    actualValue: unknown,
    expectedFormat: string,
    context?: {
      fieldPath?: string;
      formatPattern?: string;
      examples?: readonly string[];
      validationContext?: Record<string, unknown>;
      errorContext?: Partial<ErrorContext>;
      cause?: Error;
    }
  ) {
    const message = `Invalid format for field '${fieldName}': expected ${expectedFormat}, got ${typeof actualValue}`;

    super(message, {
      code: ErrorCode.VALIDATION_INVALID_FORMAT,
      context: {
        ...context?.errorContext,
        metadata: {
          fieldName,
          actualValue,
          expectedFormat,
          fieldPath: context?.fieldPath,
          formatPattern: context?.formatPattern,
          examples: context?.examples,
          validationContext: context?.validationContext,
          ...context?.errorContext?.metadata
        },
        recoverySuggestions: [
          `Format '${fieldName}' as ${expectedFormat}`,
          context?.formatPattern ? `Use pattern: ${context.formatPattern}` : 'Check the expected pattern',
          ...(context?.examples ? [`Examples: ${context.examples.join(', ')}`] : []),
          'Validate input before processing'
        ].filter(Boolean),
        isRetriable: false
      },
      cause: context?.cause,
      recoveryActions: [
        {
          id: 'auto_format',
          description: `Automatically format '${fieldName}' to ${expectedFormat}`,
          type: RecoveryActionType.REPAIR,
          canAutomate: true,
          successProbability: 0.6
        },
        {
          id: 'suggest_format',
          description: 'Suggest correct format with examples',
          type: RecoveryActionType.MANUAL,
          canAutomate: true,
          successProbability: 1.0
        }
      ]
    });
  }
}

/**
 * Out of range error for numeric values
 */
export class OutOfRangeError extends ValidationError {
  public readonly code = ErrorCode.VALIDATION_OUT_OF_RANGE;

  constructor(
    fieldName: string,
    actualValue: number,
    minValue?: number,
    maxValue?: number,
    context?: {
      fieldPath?: string;
      isInclusive?: boolean;
      validationContext?: Record<string, unknown>;
      errorContext?: Partial<ErrorContext>;
      cause?: Error;
    }
  ) {
    let message = `Value for field '${fieldName}' is out of range: ${actualValue}`;
    if (minValue !== undefined && maxValue !== undefined) {
      message += ` (range: ${minValue} - ${maxValue})`;
    } else if (minValue !== undefined) {
      message += ` (minimum: ${minValue})`;
    } else if (maxValue !== undefined) {
      message += ` (maximum: ${maxValue})`;
    }

    super(message, {
      code: ErrorCode.VALIDATION_OUT_OF_RANGE,
      context: {
        ...context?.errorContext,
        metadata: {
          fieldName,
          actualValue,
          minValue,
          maxValue,
          fieldPath: context?.fieldPath,
          isInclusive: context?.isInclusive,
          validationContext: context?.validationContext,
          ...context?.errorContext?.metadata
        },
        recoverySuggestions: [
          minValue !== undefined && maxValue !== undefined
            ? `Provide a value between ${minValue} and ${maxValue}`
            : minValue !== undefined
            ? `Provide a value greater than ${context?.isInclusive ? 'or equal to ' : ''}${minValue}`
            : maxValue !== undefined
            ? `Provide a value less than ${context?.isInclusive ? 'or equal to ' : ''}${maxValue}`
            : 'Provide a value within the valid range',
          'Check the field constraints',
          'Use the nearest valid value'
        ].filter(Boolean),
        isRetriable: false
      },
      cause: context?.cause,
      recoveryActions: [
        {
          id: 'clamp_to_range',
          description: 'Clamp value to valid range',
          type: RecoveryActionType.REPAIR,
          canAutomate: true,
          successProbability: 0.9
        },
        {
          id: 'suggest_valid_range',
          description: 'Display valid range information',
          type: RecoveryActionType.MANUAL,
          canAutomate: true,
          successProbability: 1.0
        }
      ]
    });
  }
}

/**
 * Invalid choice error for enumerated values
 */
export class InvalidChoiceError extends ValidationError {
  public readonly code = ErrorCode.VALIDATION_INVALID_CHOICE;

  constructor(
    fieldName: string,
    actualValue: unknown,
    validChoices: readonly unknown[],
    context?: {
      fieldPath?: string;
      caseSensitive?: boolean;
      validationContext?: Record<string, unknown>;
      errorContext?: Partial<ErrorContext>;
      cause?: Error;
    }
  ) {
    const message = `Invalid choice for field '${fieldName}': '${actualValue}'. Valid choices: ${validChoices.join(', ')}`;

    super(message, {
      code: ErrorCode.VALIDATION_INVALID_CHOICE,
      context: {
        ...context?.errorContext,
        metadata: {
          fieldName,
          actualValue,
          validChoices,
          fieldPath: context?.fieldPath,
          caseSensitive: context?.caseSensitive,
          validationContext: context?.validationContext,
          ...context?.errorContext?.metadata
        },
        recoverySuggestions: [
          `Choose one of: ${validChoices.join(', ')}`,
          'Check spelling and case sensitivity',
          'Use exact match for the choices',
          'Check if new choices need to be added'
        ],
        isRetriable: false
      },
      cause: context?.cause,
      recoveryActions: [
        {
          id: 'suggest_closest_match',
          description: 'Suggest closest valid choice',
          type: RecoveryActionType.FALLBACK,
          canAutomate: true,
          successProbability: 0.8
        },
        {
          id: 'list_valid_choices',
          description: 'Display all valid choices',
          type: RecoveryActionType.MANUAL,
          canAutomate: true,
          successProbability: 1.0
        }
      ]
    });
  }
}

/**
 * Schema validation error
 */
export class SchemaValidationError extends ValidationError {
  public readonly code = ErrorCode.VALIDATION_SCHEMA_ERROR;

  constructor(
    schemaPath: string,
    validationErrors: readonly string[],
    context?: {
      schemaName?: string;
      schemaVersion?: string;
      inputData?: unknown;
      validationContext?: Record<string, unknown>;
      errorContext?: Partial<ErrorContext>;
      cause?: Error;
    }
  ) {
    const message = `Schema validation failed at ${schemaPath}: ${validationErrors.join(', ')}`;

    super(message, {
      code: ErrorCode.VALIDATION_SCHEMA_ERROR,
      context: {
        ...context?.errorContext,
        metadata: {
          schemaPath,
          validationErrors,
          schemaName: context?.schemaName,
          schemaVersion: context?.schemaVersion,
          inputData: context?.inputData,
          validationContext: context?.validationContext,
          ...context?.errorContext?.metadata
        },
        recoverySuggestions: [
          'Check data structure against schema requirements',
          'Validate all required fields are present',
          'Verify data types match schema definitions',
          'Check for additional properties that are not allowed'
        ],
        isRetriable: false
      },
      cause: context?.cause,
      recoveryActions: [
        {
          id: 'auto_fix_schema',
          description: 'Automatically fix common schema issues',
          type: RecoveryActionType.REPAIR,
          canAutomate: true,
          successProbability: 0.4
        },
        {
          id: 'generate_valid_example',
          description: 'Generate example of valid data',
          type: RecoveryActionType.MANUAL,
          canAutomate: true,
          successProbability: 1.0
        }
      ]
    });
  }
}

/**
 * Type validation error
 */
export class TypeValidationError extends ValidationError {
  public readonly code = ErrorCode.VALIDATION_TYPE_ERROR;

  constructor(
    fieldName: string,
    actualType: string,
    expectedType: string,
    context?: {
      fieldPath?: string;
      actualValue?: unknown;
      allowedTypes?: readonly string[];
      validationContext?: Record<string, unknown>;
      errorContext?: Partial<ErrorContext>;
      cause?: Error;
    }
  ) {
    const message = `Type validation failed for field '${fieldName}': expected ${expectedType}, got ${actualType}`;

    super(message, {
      code: ErrorCode.VALIDATION_TYPE_ERROR,
      context: {
        ...context?.errorContext,
        metadata: {
          fieldName,
          actualType,
          expectedType,
          fieldPath: context?.fieldPath,
          actualValue: context?.actualValue,
          allowedTypes: context?.allowedTypes,
          validationContext: context?.validationContext,
          ...context?.errorContext?.metadata
        },
        recoverySuggestions: [
          `Convert value to ${expectedType}`,
          context?.allowedTypes ? `Allowed types: ${context.allowedTypes.join(', ')}` : 'Check allowed types',
          'Validate input data types before processing',
          'Use type conversion functions if appropriate'
        ].filter(Boolean),
        isRetriable: false
      },
      cause: context?.cause,
      recoveryActions: [
        {
          id: 'auto_convert_type',
          description: `Convert value to ${expectedType}`,
          type: RecoveryActionType.REPAIR,
          canAutomate: true,
          successProbability: 0.7
        },
        {
          id: 'suggest_conversion',
          description: 'Suggest type conversion approach',
          type: RecoveryActionType.MANUAL,
          canAutomate: true,
          successProbability: 1.0
        }
      ]
    });
  }
}

/**
 * Constraint validation error (custom validation rules)
 */
export class ConstraintValidationError extends ValidationError {
  public readonly code = ErrorCode.VALIDATION_CONSTRAINT_ERROR;

  constructor(
    constraintName: string,
    fieldName: string,
    constraintDetails: string,
    context?: {
      fieldPath?: string;
      actualValue?: unknown;
      constraintConfig?: Record<string, unknown>;
      validationContext?: Record<string, unknown>;
      errorContext?: Partial<ErrorContext>;
      cause?: Error;
    }
  ) {
    const message = `Constraint '${constraintName}' validation failed for field '${fieldName}': ${constraintDetails}`;

    super(message, {
      code: ErrorCode.VALIDATION_CONSTRAINT_ERROR,
      context: {
        ...context?.errorContext,
        metadata: {
          constraintName,
          fieldName,
          constraintDetails,
          fieldPath: context?.fieldPath,
          actualValue: context?.actualValue,
          constraintConfig: context?.constraintConfig,
          validationContext: context?.validationContext,
          ...context?.errorContext?.metadata
        },
        recoverySuggestions: [
          `Ensure field '${fieldName}' meets constraint: ${constraintName}`,
          'Check constraint configuration and requirements',
          'Validate data against all defined constraints',
          'Consider adjusting constraint rules if appropriate'
        ],
        isRetriable: false
      },
      cause: context?.cause,
      recoveryActions: [
        {
          id: 'fix_constraint_violation',
          description: `Fix ${constraintName} constraint violation`,
          type: RecoveryActionType.REPAIR,
          canAutomate: false,
          successProbability: 0.5
        },
        {
          id: 'explain_constraint',
          description: `Explain ${constraintName} constraint requirements`,
          type: RecoveryActionType.MANUAL,
          canAutomate: true,
          successProbability: 1.0
        }
      ]
    });
  }
}

/**
 * Cross-field dependency validation error
 */
export class DependencyValidationError extends ValidationError {
  public readonly code = ErrorCode.VALIDATION_DEPENDENCY_ERROR;

  constructor(
    dependentField: string,
    requiredField: string,
    dependencyRule: string,
    context?: {
      dependentValue?: unknown;
      requiredValue?: unknown;
      validationContext?: Record<string, unknown>;
      errorContext?: Partial<ErrorContext>;
      cause?: Error;
    }
  ) {
    const message = `Dependency validation failed: field '${dependentField}' requires '${requiredField}' to ${dependencyRule}`;

    super(message, {
      code: ErrorCode.VALIDATION_DEPENDENCY_ERROR,
      context: {
        ...context?.errorContext,
        metadata: {
          dependentField,
          requiredField,
          dependencyRule,
          dependentValue: context?.dependentValue,
          requiredValue: context?.requiredValue,
          validationContext: context?.validationContext,
          ...context?.errorContext?.metadata
        },
        recoverySuggestions: [
          `Ensure '${requiredField}' ${dependencyRule} when '${dependentField}' is set`,
          'Check field dependencies and conditional requirements',
          'Review the complete data structure for consistency',
          'Consider making fields optional if dependencies are complex'
        ],
        isRetriable: false
      },
      cause: context?.cause,
      recoveryActions: [
        {
          id: 'fix_dependency',
          description: `Fix dependency between '${dependentField}' and '${requiredField}'`,
          type: RecoveryActionType.REPAIR,
          canAutomate: true,
          successProbability: 0.6
        },
        {
          id: 'explain_dependencies',
          description: 'Explain field dependency requirements',
          type: RecoveryActionType.MANUAL,
          canAutomate: true,
          successProbability: 1.0
        }
      ]
    });
  }
}