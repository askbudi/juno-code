import * as mod from './dist/index.mjs';

const capitalExports = Object.keys(mod).filter(k =>
  k[0] === k[0].toUpperCase() &&
  !k.includes('_') &&
  (k.includes('Client') || k.includes('MCP'))
);

console.log('MCP/Client related exports:', capitalExports);

// Also check if there's any way to access client functionality
const allClientRelated = Object.keys(mod).filter(k =>
  k.toLowerCase().includes('client') ||
  k.toLowerCase().includes('mcp')
);

console.log('All client/MCP related exports:', allClientRelated);