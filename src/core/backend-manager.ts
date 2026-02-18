/**
 * Backend interface for juno-code
 *
 * Defines the contract that backend implementations must satisfy.
 * Currently only the shell backend exists (see backends/shell-backend.ts).
 */

import type { ToolCallRequest, ToolCallResult, ProgressCallback } from '../types/execution.js';

/**
 * Backend interface that all backends must implement
 */
export interface Backend {
  /** Backend type identifier */
  readonly type: string;

  /** Backend name for display */
  readonly name: string;

  /** Initialize the backend */
  initialize(): Promise<void>;

  /** Execute a tool call request */
  execute(request: ToolCallRequest): Promise<ToolCallResult>;

  /** Clean up backend resources */
  cleanup(): Promise<void>;

  /** Check if backend is available */
  isAvailable(): Promise<boolean>;

  /** Set progress callback */
  onProgress(callback: ProgressCallback): () => void;
}
