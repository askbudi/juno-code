/**
 * Progress Stream Manager for juno-task-ts
 *
 * Real-time progress streaming display for MCP operations.
 * Provides live streaming of tool execution progress and performance metrics.
 */

import { EventEmitter } from 'node:events';
import type { ProgressEvent, ProgressCallback } from '../types.js';

export interface ProgressStreamUpdate {
  sessionId: string;
  timestamp: Date;
  type: 'tool_start' | 'tool_progress' | 'tool_complete' | 'iteration_start' | 'iteration_complete' | 'stream_start' | 'stream_end';
  data: {
    toolName?: string;
    progress?: number;
    message?: string;
    metadata?: Record<string, any>;
    duration?: number;
    error?: string;
    totalSteps?: number;
    currentStep?: number;
    rate?: number; // operations per second
    eta?: Date;
  };
}

export interface ExecutionMetrics {
  startTime: Date;
  endTime?: Date;
  totalDuration: number;
  toolCalls: number;
  successfulCalls: number;
  failedCalls: number;
  averageResponseTime: number;
  iterationsCompleted: number;
  totalIterations?: number;
  currentIteration?: number;
  operationsPerSecond: number;
  estimatedTimeRemaining?: number;
}

export interface StreamSession {
  sessionId: string;
  startTime: Date;
  isActive: boolean;
  metrics: ExecutionMetrics;
  updates: ProgressStreamUpdate[];
  callbacks: Array<(update: ProgressStreamUpdate) => void>;
}

export class ProgressStreamManager extends EventEmitter {
  private sessions: Map<string, StreamSession> = new Map();
  private globalCallbacks: Array<(update: ProgressStreamUpdate) => void> = [];
  private updateInterval?: NodeJS.Timeout;
  private metricsUpdateInterval: number = 1000; // 1 second

  constructor() {
    super();
    this.startMetricsUpdater();
  }

  /**
   * Start progress streaming for a session
   */
  async startStream(sessionId: string): Promise<void> {
    if (this.sessions.has(sessionId)) {
      throw new Error(`Progress stream already active for session: ${sessionId}`);
    }

    const session: StreamSession = {
      sessionId,
      startTime: new Date(),
      isActive: true,
      metrics: {
        startTime: new Date(),
        totalDuration: 0,
        toolCalls: 0,
        successfulCalls: 0,
        failedCalls: 0,
        averageResponseTime: 0,
        iterationsCompleted: 0,
        operationsPerSecond: 0
      },
      updates: [],
      callbacks: []
    };

    this.sessions.set(sessionId, session);

    // Emit stream start event
    const startUpdate: ProgressStreamUpdate = {
      sessionId,
      timestamp: new Date(),
      type: 'stream_start',
      data: {
        message: 'Progress stream started'
      }
    };

    this.emitUpdate(startUpdate);
    this.emit('streamStarted', sessionId);
  }

  /**
   * Stop progress streaming for a session
   */
  async stopStream(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return; // Session doesn't exist or already stopped
    }

    session.isActive = false;
    session.metrics.endTime = new Date();
    session.metrics.totalDuration = session.metrics.endTime.getTime() - session.metrics.startTime.getTime();

    // Emit stream end event
    const endUpdate: ProgressStreamUpdate = {
      sessionId,
      timestamp: new Date(),
      type: 'stream_end',
      data: {
        message: 'Progress stream ended',
        duration: session.metrics.totalDuration,
        metadata: {
          totalToolCalls: session.metrics.toolCalls,
          successRate: session.metrics.toolCalls > 0 ? (session.metrics.successfulCalls / session.metrics.toolCalls) * 100 : 0,
          averageResponseTime: session.metrics.averageResponseTime
        }
      }
    };

    this.emitUpdate(endUpdate);
    this.emit('streamEnded', sessionId, session.metrics);

    // Clean up session after a delay to allow final metrics collection
    setTimeout(() => {
      this.sessions.delete(sessionId);
    }, 5000);
  }

  /**
   * Add progress update callback for a session
   */
  onProgressUpdate(callback: (update: ProgressStreamUpdate) => void, sessionId?: string): void {
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (session) {
        session.callbacks.push(callback);
      }
    } else {
      this.globalCallbacks.push(callback);
    }
  }

  /**
   * Remove progress update callback
   */
  removeProgressCallback(callback: (update: ProgressStreamUpdate) => void, sessionId?: string): void {
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (session) {
        const index = session.callbacks.indexOf(callback);
        if (index !== -1) {
          session.callbacks.splice(index, 1);
        }
      }
    } else {
      const index = this.globalCallbacks.indexOf(callback);
      if (index !== -1) {
        this.globalCallbacks.splice(index, 1);
      }
    }
  }

  /**
   * Check if streaming is active for a session
   */
  isStreaming(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return session?.isActive || false;
  }

  /**
   * Get current metrics for a session
   */
  getMetrics(sessionId: string): ExecutionMetrics | null {
    const session = this.sessions.get(sessionId);
    return session?.metrics || null;
  }

  /**
   * Get all active session IDs
   */
  getActiveSessions(): string[] {
    return Array.from(this.sessions.entries())
      .filter(([_, session]) => session.isActive)
      .map(([sessionId]) => sessionId);
  }

  /**
   * Record tool execution start
   */
  recordToolStart(sessionId: string, toolName: string, metadata?: Record<string, any>): void {
    const session = this.sessions.get(sessionId);
    if (!session || !session.isActive) return;

    const update: ProgressStreamUpdate = {
      sessionId,
      timestamp: new Date(),
      type: 'tool_start',
      data: {
        toolName,
        message: `Starting ${toolName}`,
        metadata
      }
    };

    this.emitUpdate(update);
  }

  /**
   * Record tool execution progress
   */
  recordToolProgress(sessionId: string, toolName: string, progress: number, message?: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || !session.isActive) return;

    const update: ProgressStreamUpdate = {
      sessionId,
      timestamp: new Date(),
      type: 'tool_progress',
      data: {
        toolName,
        progress: Math.max(0, Math.min(100, progress)),
        message: message || `${toolName} progress: ${progress.toFixed(1)}%`,
        rate: this.calculateOperationRate(sessionId)
      }
    };

    this.emitUpdate(update);
  }

  /**
   * Record tool execution completion
   */
  recordToolComplete(sessionId: string, toolName: string, duration: number, success: boolean = true, error?: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || !session.isActive) return;

    // Update metrics
    session.metrics.toolCalls++;
    if (success) {
      session.metrics.successfulCalls++;
    } else {
      session.metrics.failedCalls++;
    }

    // Update average response time
    session.metrics.averageResponseTime = this.calculateAverageResponseTime(session, duration);

    const update: ProgressStreamUpdate = {
      sessionId,
      timestamp: new Date(),
      type: 'tool_complete',
      data: {
        toolName,
        message: success ? `${toolName} completed successfully` : `${toolName} failed`,
        duration,
        error,
        metadata: {
          success,
          totalCalls: session.metrics.toolCalls,
          successRate: (session.metrics.successfulCalls / session.metrics.toolCalls) * 100
        }
      }
    };

    this.emitUpdate(update);
  }

  /**
   * Record iteration start
   */
  recordIterationStart(sessionId: string, iterationNumber: number, totalIterations?: number): void {
    const session = this.sessions.get(sessionId);
    if (!session || !session.isActive) return;

    session.metrics.currentIteration = iterationNumber;
    session.metrics.totalIterations = totalIterations;

    const update: ProgressStreamUpdate = {
      sessionId,
      timestamp: new Date(),
      type: 'iteration_start',
      data: {
        message: `Starting iteration ${iterationNumber}${totalIterations ? ` of ${totalIterations}` : ''}`,
        currentStep: iterationNumber,
        totalSteps: totalIterations,
        progress: totalIterations ? (iterationNumber / totalIterations) * 100 : undefined
      }
    };

    this.emitUpdate(update);
  }

  /**
   * Record iteration completion
   */
  recordIterationComplete(sessionId: string, iterationNumber: number): void {
    const session = this.sessions.get(sessionId);
    if (!session || !session.isActive) return;

    session.metrics.iterationsCompleted = iterationNumber;

    // Calculate ETA if we have total iterations
    let eta: Date | undefined;
    if (session.metrics.totalIterations && session.metrics.totalIterations > iterationNumber) {
      const remainingIterations = session.metrics.totalIterations - iterationNumber;
      const iterationRate = this.calculateIterationRate(session);
      if (iterationRate > 0) {
        const remainingTime = (remainingIterations / iterationRate) * 1000;
        eta = new Date(Date.now() + remainingTime);
      }
    }

    const update: ProgressStreamUpdate = {
      sessionId,
      timestamp: new Date(),
      type: 'iteration_complete',
      data: {
        message: `Iteration ${iterationNumber} completed`,
        currentStep: iterationNumber,
        totalSteps: session.metrics.totalIterations,
        progress: session.metrics.totalIterations ? (iterationNumber / session.metrics.totalIterations) * 100 : undefined,
        rate: this.calculateIterationRate(session),
        eta
      }
    };

    this.emitUpdate(update);
  }

  /**
   * Create a progress callback for MCP client integration
   */
  createProgressCallback(sessionId: string): ProgressCallback {
    return (event: ProgressEvent) => {
      const session = this.sessions.get(sessionId);
      if (!session || !session.isActive) return;

      const update: ProgressStreamUpdate = {
        sessionId,
        timestamp: new Date(),
        type: 'tool_progress',
        data: {
          toolName: event.toolName,
          progress: event.progress,
          message: event.message,
          metadata: event.metadata
        }
      };

      this.emitUpdate(update);
    };
  }

  /**
   * Emit update to all callbacks
   */
  private emitUpdate(update: ProgressStreamUpdate): void {
    const session = this.sessions.get(update.sessionId);

    // Store update in session history
    if (session) {
      session.updates.push(update);
      // Keep only last 100 updates per session to prevent memory leaks
      if (session.updates.length > 100) {
        session.updates = session.updates.slice(-100);
      }

      // Call session-specific callbacks
      session.callbacks.forEach(callback => {
        try {
          callback(update);
        } catch (error) {
          console.error('Error in progress callback:', error);
        }
      });
    }

    // Call global callbacks
    this.globalCallbacks.forEach(callback => {
      try {
        callback(update);
      } catch (error) {
        console.error('Error in global progress callback:', error);
      }
    });

    // Emit as event
    this.emit('progressUpdate', update);
  }

  /**
   * Calculate operation rate (ops/second)
   */
  private calculateOperationRate(sessionId: string): number {
    const session = this.sessions.get(sessionId);
    if (!session) return 0;

    const elapsedTime = (Date.now() - session.startTime.getTime()) / 1000;
    return elapsedTime > 0 ? session.metrics.toolCalls / elapsedTime : 0;
  }

  /**
   * Calculate iteration rate (iterations/second)
   */
  private calculateIterationRate(session: StreamSession): number {
    const elapsedTime = (Date.now() - session.startTime.getTime()) / 1000;
    return elapsedTime > 0 ? session.metrics.iterationsCompleted / elapsedTime : 0;
  }

  /**
   * Calculate rolling average response time
   */
  private calculateAverageResponseTime(session: StreamSession, newDuration: number): number {
    const totalCalls = session.metrics.toolCalls;
    if (totalCalls === 1) {
      return newDuration;
    }

    const currentAverage = session.metrics.averageResponseTime;
    return ((currentAverage * (totalCalls - 1)) + newDuration) / totalCalls;
  }

  /**
   * Start periodic metrics updater
   */
  private startMetricsUpdater(): void {
    this.updateInterval = setInterval(() => {
      for (const [sessionId, session] of this.sessions.entries()) {
        if (session.isActive) {
          // Update current duration
          session.metrics.totalDuration = Date.now() - session.startTime.getTime();
          session.metrics.operationsPerSecond = this.calculateOperationRate(sessionId);

          // Emit metrics update
          this.emit('metricsUpdate', sessionId, session.metrics);
        }
      }
    }, this.metricsUpdateInterval);
  }

  /**
   * Cleanup and stop all streams
   */
  destroy(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }

    // Stop all active streams
    for (const sessionId of this.getActiveSessions()) {
      this.stopStream(sessionId);
    }

    this.sessions.clear();
    this.globalCallbacks.length = 0;
  }
}

export default ProgressStreamManager;