/**
 * Unified Error Hierarchy for juno-task-ts
 *
 * Provides a comprehensive error handling system with:
 * - Hierarchical error categories
 * - Rich error context and metadata
 * - Recovery strategies and retry mechanisms
 * - Unified error reporting and formatting
 *
 * This system consolidates error handling patterns from all modules
 * while preserving the sophistication of the MCP error framework.
 */

// Core error types and interfaces
export * from './base';
export * from './categories';
export * from './codes';
export * from './context';
export * from './recovery';

// Specialized error classes
export * from './system';
export * from './validation';
export * from './configuration';
export * from './mcp';
export * from './template';
export * from './session';
export * from './cli';
export * from './tui';

// Error utilities and managers
export * from './utils';
export * from './manager';
export * from './reporter';

// Legacy compatibility layer
export * from './legacy';