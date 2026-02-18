/**
 * TUI Context Hook for juno-task-ts
 *
 * Custom hook for accessing TUI context throughout the application.
 * Re-exports the useTUIContext from TUIApp for convenience.
 */

import { useTUIContext } from '../apps/TUIApp.js';

// Re-export for convenience
export { useTUIContext } from '../apps/TUIApp.js';
export default useTUIContext;