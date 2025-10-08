import { MCPConnectionError, ErrorCategory } from './dist/index.mjs';

const error = new MCPConnectionError('test-server');
console.log('Error created:', error.constructor.name);
console.log('Category property:', error.category);
console.log('Context category:', error.context?.category);
console.log('ErrorCategory.MCP:', ErrorCategory.MCP);
console.log('Direct property access:', Object.getOwnPropertyDescriptor(error, 'category'));
console.log('Prototype property:', Object.getOwnPropertyDescriptor(Object.getPrototypeOf(error), 'category'));