/**
 * TUI Renderer Utilities for juno-task-ts
 *
 * Core rendering utilities for TUI applications, including render management,
 * cleanup, and integration with Ink's rendering system.
 */

import React from 'react';
import { render, RenderOptions, Instance } from 'ink';
import { isHeadlessEnvironment } from '../../utils/environment.js';
import type { TUIRenderOptions, TUIError } from '../types.js';

/**
 * TUI render result with cleanup capabilities
 */
export interface TUIRenderResult {
  /** The Ink instance */
  instance: Instance;
  /** Cleanup function to stop rendering */
  cleanup: () => Promise<void>;
  /** Wait for the app to exit */
  waitUntilExit: () => Promise<void>;
  /** Re-render the component */
  rerender: (component: React.ReactElement) => void;
  /** Clear the output */
  clear: () => void;
  /** Unmount the component */
  unmount: () => void;
}

/**
 * Enhanced TUI renderer with error handling and cleanup
 */
export class TUIRenderer {
  private instances: Map<string, Instance> = new Map();
  private cleanupHandlers: Map<string, () => Promise<void>> = new Map();

  /**
   * Render a TUI component with enhanced options
   */
  async render(
    component: React.ReactElement,
    options: TUIRenderOptions = {}
  ): Promise<TUIRenderResult> {
    const {
      exitOnCtrlC = true,
      debug = false,
      stdout = process.stdout,
      stdin = process.stdin,
      waitUntilExit = false
    } = options;

    // Check for headless environment
    if (isHeadlessEnvironment()) {
      throw new TUIError(
        'Cannot render TUI in headless environment',
        'TUI_HEADLESS_ERROR'
      );
    }

    // Prepare render options
    const renderOptions: RenderOptions = {
      exitOnCtrlC,
      debug,
      stdout,
      stdin
    };

    try {
      // Render the component
      const instance = render(component, renderOptions);
      const instanceId = this.generateInstanceId();

      // Store instance for cleanup
      this.instances.set(instanceId, instance);

      // Create cleanup handler
      const cleanup = async () => {
        try {
          instance.unmount();
          this.instances.delete(instanceId);
          this.cleanupHandlers.delete(instanceId);
        } catch (error) {
          if (debug) {
            console.error('Cleanup error:', error);
          }
        }
      };

      this.cleanupHandlers.set(instanceId, cleanup);

      // Create result object
      const result: TUIRenderResult = {
        instance,
        cleanup,
        waitUntilExit: () => instance.waitUntilExit(),
        rerender: (newComponent: React.ReactElement) => {
          instance.rerender(newComponent);
        },
        clear: () => {
          if (stdout.isTTY) {
            stdout.write('\x1b[2J\x1b[3J\x1b[H');
          }
        },
        unmount: () => {
          instance.unmount();
          this.instances.delete(instanceId);
          this.cleanupHandlers.delete(instanceId);
        }
      };

      // Wait for exit if requested
      if (waitUntilExit) {
        await instance.waitUntilExit();
      }

      return result;

    } catch (error) {
      throw new TUIError(
        `Failed to render TUI component: ${error}`,
        'TUI_RENDER_ERROR'
      );
    }
  }

  /**
   * Render a temporary TUI component (auto-cleanup)
   */
  async renderTemporary(
    component: React.ReactElement,
    duration?: number,
    options: TUIRenderOptions = {}
  ): Promise<void> {
    const result = await this.render(component, options);

    try {
      if (duration) {
        // Auto-cleanup after duration
        setTimeout(async () => {
          await result.cleanup();
        }, duration);
      } else {
        // Wait for exit and cleanup
        await result.waitUntilExit();
      }
    } finally {
      await result.cleanup();
    }
  }

  /**
   * Render in test mode (for testing components)
   */
  async renderTest(
    component: React.ReactElement,
    options: TUIRenderOptions = {}
  ): Promise<TUIRenderResult> {
    const testOptions: TUIRenderOptions = {
      ...options,
      debug: true,
      exitOnCtrlC: false,
      waitUntilExit: false
    };

    return this.render(component, testOptions);
  }

  /**
   * Create a headless fallback renderer
   */
  createHeadlessFallback<T>(
    fallbackFn: () => Promise<T>
  ): Promise<T> {
    if (isHeadlessEnvironment()) {
      return fallbackFn();
    }

    throw new TUIError(
      'Headless fallback called in interactive environment',
      'TUI_INVALID_FALLBACK'
    );
  }

  /**
   * Cleanup all active instances
   */
  async cleanupAll(): Promise<void> {
    const cleanupPromises = Array.from(this.cleanupHandlers.values()).map(
      cleanup => cleanup()
    );

    await Promise.allSettled(cleanupPromises);
    this.instances.clear();
    this.cleanupHandlers.clear();
  }

  /**
   * Get active instance count
   */
  getActiveInstanceCount(): number {
    return this.instances.size;
  }

  /**
   * Generate unique instance ID
   */
  private generateInstanceId(): string {
    return `tui_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}

/**
 * Global TUI renderer instance
 */
export const tuiRenderer = new TUIRenderer();

/**
 * High-level render function for simple use cases
 */
export async function renderTUI(
  component: React.ReactElement,
  options: TUIRenderOptions = {}
): Promise<TUIRenderResult> {
  return tuiRenderer.render(component, options);
}

/**
 * Render and wait for TUI component to complete
 */
export async function renderAndWait(
  component: React.ReactElement,
  options: TUIRenderOptions = {}
): Promise<void> {
  const result = await tuiRenderer.render(component, {
    ...options,
    waitUntilExit: true
  });

  try {
    await result.waitUntilExit();
  } finally {
    await result.cleanup();
  }
}

/**
 * Quick TUI alert/notification
 */
export async function showTUIAlert(
  message: string,
  duration: number = 3000,
  options: TUIRenderOptions = {}
): Promise<void> {
  const AlertComponent = React.createElement(
    'div',
    {},
    React.createElement('text', { color: 'cyan' }, message)
  );

  await tuiRenderer.renderTemporary(AlertComponent, duration, options);
}

/**
 * Utility to check if TUI rendering is available
 */
export function isTUIAvailable(): boolean {
  return !isHeadlessEnvironment() && process.stdout.isTTY;
}

/**
 * Safe TUI render with automatic fallback
 */
export async function safeTUIRender<T>(
  component: React.ReactElement,
  fallbackFn: () => Promise<T>,
  options: TUIRenderOptions = {}
): Promise<T | TUIRenderResult> {
  if (!isTUIAvailable()) {
    return fallbackFn();
  }

  try {
    return await tuiRenderer.render(component, options);
  } catch (error) {
    console.warn('TUI render failed, falling back:', error);
    return fallbackFn();
  }
}

/**
 * Process exit cleanup handler
 */
let cleanupRegistered = false;

export function registerCleanupHandlers(): void {
  if (cleanupRegistered) return;

  const cleanup = async () => {
    await tuiRenderer.cleanupAll();
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('exit', cleanup);
  process.on('uncaughtException', async (error) => {
    console.error('Uncaught exception:', error);
    await cleanup();
    process.exit(1);
  });

  cleanupRegistered = true;
}

/**
 * Initialize TUI renderer with cleanup handlers
 */
export function initializeTUIRenderer(): TUIRenderer {
  registerCleanupHandlers();
  return tuiRenderer;
}

// Auto-register cleanup handlers
registerCleanupHandlers();