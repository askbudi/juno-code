/**
 * Example: Integrating Metrics with Session Management
 *
 * This example demonstrates how to integrate the comprehensive metrics system
 * with the existing session management functionality in juno-task-ts.
 */

import {
  createSessionManager,
  createMetricsCollector,
  createMetricsReporter,
  type JunoTaskConfig,
  type MetricsCollector,
  type SessionManager,
  type MetricsReporter,
} from '../src/index.js';

/**
 * Enhanced session manager with integrated metrics collection
 */
export class MetricsEnabledSessionManager {
  private sessionManager: SessionManager;
  private metricsCollector: MetricsCollector;
  private metricsReporter: MetricsReporter;

  constructor(sessionManager: SessionManager, metricsCollector: MetricsCollector) {
    this.sessionManager = sessionManager;
    this.metricsCollector = metricsCollector;
    this.metricsReporter = createMetricsReporter(metricsCollector);

    // Set up event listeners for automatic metrics collection
    this.setupEventListeners();
  }

  /**
   * Set up event listeners for automatic metrics collection
   */
  private setupEventListeners(): void {
    // Listen to session events
    this.sessionManager.on('session_created', (event) => {
      const session = event.data.session;
      this.metricsCollector.startSession(
        session.id,
        session.subagent,
        session.workingDirectory,
        session.config.defaultModel
      );
    });

    this.sessionManager.on('session_completed', (event) => {
      this.metricsCollector.endSession(
        event.sessionId,
        event.data.result.success ? 'completed' : 'failed'
      );
    });

    this.sessionManager.on('session_cancelled', (event) => {
      this.metricsCollector.endSession(event.sessionId, 'cancelled');
    });

    // Listen to metrics events for enhanced session tracking
    this.metricsCollector.on('tool_call_recorded', (toolCall) => {
      // Update session statistics when tool calls are recorded
      this.metricsCollector.updateSession(toolCall.sessionId, {
        toolCalls: this.getCurrentToolCallCount(toolCall.sessionId),
      });
    });
  }

  /**
   * Get current tool call count for a session
   */
  private getCurrentToolCallCount(sessionId: string): number {
    const sessionMetrics = this.metricsCollector.getSessionMetrics(sessionId);
    return sessionMetrics?.toolCalls || 0;
  }

  /**
   * Start a new session with metrics collection
   */
  async createSession(options: {
    name?: string;
    subagent: 'claude' | 'cursor' | 'codex' | 'gemini';
    config: JunoTaskConfig;
    tags?: string[];
    metadata?: Record<string, any>;
  }) {
    // Start metrics collection if not already started
    this.metricsCollector.startCollection();

    // Create the session
    const session = await this.sessionManager.createSession(options);

    // The metrics collection is automatically handled by event listeners
    return session;
  }

  /**
   * Record a tool call with comprehensive metrics
   */
  async recordToolCall(
    sessionId: string,
    toolName: string,
    parameters: Record<string, any>,
    duration: number,
    success: boolean,
    error?: string,
    resultPreview?: string
  ): Promise<void> {
    const session = await this.sessionManager.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Record the tool call in session history
    await this.sessionManager.addHistoryEntry(sessionId, {
      type: 'tool_call',
      content: `${toolName}: ${success ? 'SUCCESS' : 'FAILED'}`,
      data: {
        toolName,
        parameters,
        duration,
        success,
        error,
        resultPreview,
      },
      duration,
    });

    // Record in metrics collector
    this.metricsCollector.recordToolCall({
      name: toolName,
      duration,
      success,
      error,
      parameters,
      resultPreview,
      sessionId,
      iteration: session.statistics.iterations,
      subagent: session.info.subagent,
    });

    // Update session statistics
    await this.sessionManager.recordToolCall(sessionId, {
      name: toolName,
      duration,
      success,
    });
  }

  /**
   * Record iteration completion
   */
  async recordIteration(
    sessionId: string,
    iterationNumber: number,
    duration: number,
    success: boolean
  ): Promise<void> {
    // Update session metrics
    this.metricsCollector.updateSession(sessionId, {
      iterations: iterationNumber,
      avgIterationDuration: duration, // Will be recalculated based on history
    });

    // Record in session history
    await this.sessionManager.addHistoryEntry(sessionId, {
      type: 'system',
      content: `Iteration ${iterationNumber} ${success ? 'completed' : 'failed'}`,
      data: {
        iterationNumber,
        duration,
        success,
      },
      duration,
      iteration: iterationNumber,
    });
  }

  /**
   * Generate verbose statistics report for a session
   */
  async generateSessionReport(sessionId: string): Promise<string> {
    return this.metricsReporter.generateVerboseReport(sessionId);
  }

  /**
   * Generate comprehensive analytics report
   */
  generateAnalyticsReport(timeRange?: { start: Date; end: Date }): string {
    const analyticsReport = this.metricsCollector.getAnalyticsReport(timeRange);
    return this.metricsReporter.generateVerboseReport();
  }

  /**
   * Export metrics to file
   */
  async exportMetrics(
    outputPath: string,
    format: 'json' | 'csv' | 'yaml' = 'json',
    timeRange?: { start: Date; end: Date }
  ): Promise<void> {
    await this.metricsReporter.exportMetrics({
      format,
      outputPath,
      timeRange,
      includeRawData: true,
      includeSystemMetrics: true,
    });
  }

  /**
   * Get performance recommendations
   */
  getPerformanceRecommendations() {
    const analyticsReport = this.metricsCollector.getAnalyticsReport();
    return analyticsReport.recommendations;
  }

  /**
   * Clean up resources
   */
  dispose(): void {
    this.metricsCollector.dispose();
    this.sessionManager.removeAllListeners();
  }
}

/**
 * Example usage of the metrics-enabled session manager
 */
export async function demonstrateMetricsIntegration(): Promise<void> {
  // Load configuration
  const config: JunoTaskConfig = {
    defaultSubagent: 'claude',
    defaultMaxIterations: 50,
    logLevel: 'info',
    verbose: true,
    quiet: false,
    mcpTimeout: 30000,
    mcpRetries: 3,
    interactive: true,
    headlessMode: false,
    workingDirectory: process.cwd(),
    sessionDirectory: './.juno-task',
  };

  // Create session manager and metrics collector
  const sessionManager = await createSessionManager(config);
  const metricsCollector = createMetricsCollector();

  // Create enhanced session manager with metrics
  const enhancedManager = new MetricsEnabledSessionManager(
    sessionManager,
    metricsCollector
  );

  try {
    // Create a new session
    const session = await enhancedManager.createSession({
      name: 'Example Task Session',
      subagent: 'claude',
      config,
      tags: ['example', 'demonstration'],
      metadata: { purpose: 'metrics integration demo' },
    });

    console.log(`Created session: ${session.info.id}`);

    // Simulate some tool calls
    await enhancedManager.recordToolCall(
      session.info.id,
      'file_read',
      { path: '/example/file.txt' },
      150, // 150ms duration
      true,
      undefined,
      'File content preview...'
    );

    await enhancedManager.recordToolCall(
      session.info.id,
      'code_analysis',
      { language: 'typescript', file: 'example.ts' },
      2300, // 2.3s duration
      true,
      undefined,
      'Analysis complete: 5 functions found'
    );

    await enhancedManager.recordToolCall(
      session.info.id,
      'file_write',
      { path: '/example/output.txt', content: 'Generated content' },
      75, // 75ms duration
      false,
      'Permission denied',
      undefined
    );

    // Record iteration completion
    await enhancedManager.recordIteration(
      session.info.id,
      1,
      2525, // Total iteration duration
      false // Failed due to file write error
    );

    // Generate and display session report
    const sessionReport = await enhancedManager.generateSessionReport(session.info.id);
    console.log('\n--- SESSION PERFORMANCE REPORT ---');
    console.log(sessionReport);

    // Get performance recommendations
    const recommendations = enhancedManager.getPerformanceRecommendations();
    if (recommendations.length > 0) {
      console.log('\n--- PERFORMANCE RECOMMENDATIONS ---');
      for (const rec of recommendations) {
        console.log(`[${rec.severity.toUpperCase()}] ${rec.title}`);
        console.log(`  ${rec.description}`);
        console.log(`  Action: ${rec.action}\n`);
      }
    }

    // Export metrics to file
    await enhancedManager.exportMetrics(
      './example-metrics-export.json',
      'json'
    );
    console.log('Metrics exported to: ./example-metrics-export.json');

    // Complete the session
    await sessionManager.completeSession(session.info.id, {
      success: false,
      error: 'Failed due to file write permissions',
      output: 'Partial completion - analysis successful, write failed',
    });

  } finally {
    // Clean up
    enhancedManager.dispose();
  }
}

/**
 * Example of monitoring multiple sessions with real-time metrics
 */
export class SessionMonitor {
  private enhancedManager: MetricsEnabledSessionManager;
  private monitoringInterval?: NodeJS.Timeout;

  constructor(enhancedManager: MetricsEnabledSessionManager) {
    this.enhancedManager = enhancedManager;
  }

  /**
   * Start real-time monitoring
   */
  startMonitoring(intervalMs: number = 5000): void {
    this.monitoringInterval = setInterval(() => {
      this.displayCurrentMetrics();
    }, intervalMs);

    console.log(`Started session monitoring (update interval: ${intervalMs}ms)`);
  }

  /**
   * Stop monitoring
   */
  stopMonitoring(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = undefined;
      console.log('Stopped session monitoring');
    }
  }

  /**
   * Display current metrics summary
   */
  private displayCurrentMetrics(): void {
    const analyticsReport = this.enhancedManager['metricsCollector'].getAnalyticsReport();

    console.clear();
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('                    REAL-TIME SESSION MONITOR                    ');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`Last Updated: ${new Date().toISOString()}`);
    console.log('');
    console.log('ACTIVE SESSIONS:');
    console.log(`  Total: ${analyticsReport.summary.totalSessions}`);
    console.log(`  Tool Calls: ${analyticsReport.summary.totalToolCalls}`);
    console.log(`  Success Rate: ${(analyticsReport.summary.overallSuccessRate * 100).toFixed(1)}%`);
    console.log('');
    console.log('SYSTEM PERFORMANCE:');
    console.log(`  Memory Usage: ${analyticsReport.systemPerformance.memoryUsage.percentage.toFixed(1)}%`);
    console.log(`  Network Requests: ${analyticsReport.systemPerformance.networkMetrics.totalRequests}`);
    console.log('');

    if (analyticsReport.recommendations.length > 0) {
      console.log('ACTIVE ALERTS:');
      for (const rec of analyticsReport.recommendations.slice(0, 3)) {
        console.log(`  [${rec.severity.toUpperCase()}] ${rec.title}`);
      }
    }

    console.log('═══════════════════════════════════════════════════════════════');
  }
}

// Export the example functions for use
export default {
  MetricsEnabledSessionManager,
  SessionMonitor,
  demonstrateMetricsIntegration,
};