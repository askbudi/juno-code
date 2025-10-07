/**
 * Log Viewer TUI Component for juno-task-ts
 *
 * Interactive log viewer with filtering, search, and real-time updates.
 * Provides rich display of structured logs with Python Rich aesthetics.
 */

import React, { useState, useEffect, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { LogEntry, LogLevel, LogContext, AdvancedLogger } from '../../cli/utils/advanced-logger.js';
import { RichFormatter } from '../../cli/utils/rich-formatter.js';

// ============================================================================
// Interfaces
// ============================================================================

export interface LogViewerProps {
  logger: AdvancedLogger;
  maxEntries?: number;
  refreshInterval?: number; // milliseconds
  onClose?: () => void;
  showFilters?: boolean;
  showSearch?: boolean;
  interactive?: boolean;
  autoScroll?: boolean;
}

interface LogFilter {
  level?: LogLevel;
  context?: LogContext;
  searchTerm?: string;
  timeRange?: {
    start: Date;
    end: Date;
  };
}

interface ViewState {
  selectedIndex: number;
  scrollOffset: number;
  filter: LogFilter;
  showHelp: boolean;
  showDetails: boolean;
}

// ============================================================================
// Utility Functions
// ============================================================================

function formatTimestamp(date: Date): string {
  return date.toLocaleTimeString();
}

function formatDuration(ms?: number): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function getLevelIcon(level: LogLevel): string {
  switch (level) {
    case LogLevel.TRACE: return '🔍';
    case LogLevel.DEBUG: return '🐛';
    case LogLevel.INFO: return 'ℹ️';
    case LogLevel.WARN: return '⚠️';
    case LogLevel.ERROR: return '❌';
    case LogLevel.FATAL: return '💀';
    default: return '📝';
  }
}

function getLevelColor(level: LogLevel): string {
  switch (level) {
    case LogLevel.TRACE: return 'gray';
    case LogLevel.DEBUG: return 'blue';
    case LogLevel.INFO: return 'green';
    case LogLevel.WARN: return 'yellow';
    case LogLevel.ERROR: return 'red';
    case LogLevel.FATAL: return 'redBright';
    default: return 'white';
  }
}

function getContextColor(context: LogContext): string {
  switch (context) {
    case LogContext.CLI: return 'cyan';
    case LogContext.MCP: return 'magenta';
    case LogContext.ENGINE: return 'blue';
    case LogContext.SESSION: return 'green';
    case LogContext.TEMPLATE: return 'yellow';
    case LogContext.CONFIG: return 'orange';
    case LogContext.PERFORMANCE: return 'purple';
    case LogContext.SYSTEM: return 'gray';
    default: return 'white';
  }
}

// ============================================================================
// Log Entry Component
// ============================================================================

const LogEntryComponent: React.FC<{
  entry: LogEntry;
  index: number;
  isSelected: boolean;
  showDetails: boolean;
}> = ({ entry, index, isSelected, showDetails }) => {
  const levelIcon = getLevelIcon(entry.level);
  const levelColor = getLevelColor(entry.level);
  const contextColor = getContextColor(entry.context);

  const prefix = isSelected ? '❯ ' : '  ';
  const timestamp = formatTimestamp(entry.timestamp);
  const duration = formatDuration(entry.duration);

  return (
    <Box flexDirection="column">
      {/* Main log line */}
      <Box>
        <Text color={isSelected ? 'blue' : 'gray'}>{prefix}</Text>
        <Text color="gray">{timestamp}</Text>
        <Text> </Text>
        <Text color={levelColor}>{levelIcon}</Text>
        <Text> </Text>
        <Text color={contextColor}>[{entry.context}]</Text>
        <Text> </Text>
        <Text bold={isSelected}>{entry.message}</Text>
        {duration && (
          <>
            <Text> </Text>
            <Text color="cyan">({duration})</Text>
          </>
        )}
      </Box>

      {/* Details when selected */}
      {isSelected && showDetails && (
        <Box marginLeft={4} flexDirection="column">
          {entry.requestId && (
            <Box>
              <Text color="gray">Request ID: </Text>
              <Text color="blue">{entry.requestId}</Text>
            </Box>
          )}
          {entry.sessionId && (
            <Box>
              <Text color="gray">Session ID: </Text>
              <Text color="green">{entry.sessionId}</Text>
            </Box>
          )}
          {entry.data && (
            <Box flexDirection="column">
              <Text color="gray">Data:</Text>
              <Text color="gray">
                {typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data, null, 2)}
              </Text>
            </Box>
          )}
          {entry.metadata && (
            <Box flexDirection="column">
              <Text color="gray">Metadata:</Text>
              <Text color="gray">{JSON.stringify(entry.metadata, null, 2)}</Text>
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
};

// ============================================================================
// Filter Panel Component
// ============================================================================

const FilterPanel: React.FC<{
  filter: LogFilter;
  onFilterChange: (filter: LogFilter) => void;
}> = ({ filter, onFilterChange }) => {
  const formatter = new RichFormatter();

  const levelOptions = Object.values(LogLevel)
    .filter(v => typeof v === 'number')
    .map(level => `${level as number}: ${LogLevel[level as number]}`);

  const contextOptions = Object.values(LogContext);

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="blue">🔍 Filters</Text>

      <Box marginTop={1}>
        <Text color="gray">Level: </Text>
        <Text color="yellow">
          {filter.level !== undefined ? LogLevel[filter.level] : 'ALL'}
        </Text>
      </Box>

      <Box>
        <Text color="gray">Context: </Text>
        <Text color="cyan">
          {filter.context || 'ALL'}
        </Text>
      </Box>

      <Box>
        <Text color="gray">Search: </Text>
        <Text color="green">
          {filter.searchTerm || 'none'}
        </Text>
      </Box>

      <Box marginTop={1}>
        <Text color="gray">
          Use 1-6 for levels, C for context, S for search, R to reset
        </Text>
      </Box>
    </Box>
  );
};

// ============================================================================
// Help Panel Component
// ============================================================================

const HelpPanel: React.FC = () => {
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="blue">📖 Help</Text>

      <Box marginTop={1} flexDirection="column">
        <Text color="gray">Navigation:</Text>
        <Text>  ↑/↓ or j/k - Move selection</Text>
        <Text>  Page Up/Down - Scroll by page</Text>
        <Text>  Home/End - Go to first/last</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color="gray">Filtering:</Text>
        <Text>  1-6 - Filter by log level (TRACE-FATAL)</Text>
        <Text>  c - Cycle through contexts</Text>
        <Text>  s - Search in messages</Text>
        <Text>  r - Reset all filters</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color="gray">View:</Text>
        <Text>  d - Toggle details view</Text>
        <Text>  f - Toggle filters panel</Text>
        <Text>  h or ? - Toggle this help</Text>
        <Text>  q or Esc - Quit</Text>
      </Box>
    </Box>
  );
};

// ============================================================================
// Statistics Panel Component
// ============================================================================

const StatsPanel: React.FC<{
  entries: LogEntry[];
  filteredEntries: LogEntry[];
}> = ({ entries, filteredEntries }) => {
  const levelCounts = filteredEntries.reduce((acc, entry) => {
    const level = LogLevel[entry.level];
    acc[level] = (acc[level] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const contextCounts = filteredEntries.reduce((acc, entry) => {
    acc[entry.context] = (acc[entry.context] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="blue">📊 Statistics</Text>

      <Box marginTop={1}>
        <Text color="gray">Total: </Text>
        <Text color="white">{entries.length}</Text>
        <Text color="gray"> | Filtered: </Text>
        <Text color="cyan">{filteredEntries.length}</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color="gray">Levels:</Text>
        {Object.entries(levelCounts).map(([level, count]) => (
          <Box key={level}>
            <Text>  {level}: </Text>
            <Text color={getLevelColor(LogLevel[level as keyof typeof LogLevel])}>{count}</Text>
          </Box>
        ))}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color="gray">Contexts:</Text>
        {Object.entries(contextCounts).slice(0, 5).map(([context, count]) => (
          <Box key={context}>
            <Text>  {context}: </Text>
            <Text color={getContextColor(context as LogContext)}>{count}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
};

// ============================================================================
// Main Log Viewer Component
// ============================================================================

export const LogViewer: React.FC<LogViewerProps> = ({
  logger,
  maxEntries = 1000,
  refreshInterval = 1000,
  onClose,
  showFilters = true,
  showSearch = true,
  interactive = true,
  autoScroll = true
}) => {
  const [viewState, setViewState] = useState<ViewState>({
    selectedIndex: 0,
    scrollOffset: 0,
    filter: {},
    showHelp: false,
    showDetails: false
  });

  const [lastUpdate, setLastUpdate] = useState<Date>(new Date());
  const [showFilterPanel, setShowFilterPanel] = useState(false);
  const [showStatsPanel, setShowStatsPanel] = useState(false);

  // Get entries from logger
  const allEntries = useMemo(() => {
    return logger.getRecentEntries(maxEntries).reverse(); // Most recent first
  }, [logger, maxEntries, lastUpdate]);

  // Filter entries
  const filteredEntries = useMemo(() => {
    let filtered = allEntries;

    if (viewState.filter.level !== undefined) {
      filtered = filtered.filter(entry => entry.level === viewState.filter.level);
    }

    if (viewState.filter.context) {
      filtered = filtered.filter(entry => entry.context === viewState.filter.context);
    }

    if (viewState.filter.searchTerm) {
      const searchLower = viewState.filter.searchTerm.toLowerCase();
      filtered = filtered.filter(entry =>
        entry.message.toLowerCase().includes(searchLower) ||
        (entry.data && JSON.stringify(entry.data).toLowerCase().includes(searchLower))
      );
    }

    if (viewState.filter.timeRange) {
      filtered = filtered.filter(entry =>
        entry.timestamp >= viewState.filter.timeRange!.start &&
        entry.timestamp <= viewState.filter.timeRange!.end
      );
    }

    return filtered;
  }, [allEntries, viewState.filter]);

  // Auto-refresh
  useEffect(() => {
    if (!refreshInterval) return;

    const interval = setInterval(() => {
      setLastUpdate(new Date());

      // Auto-scroll to bottom if enabled
      if (autoScroll && filteredEntries.length > 0) {
        setViewState(prev => ({
          ...prev,
          selectedIndex: Math.max(0, filteredEntries.length - 1)
        }));
      }
    }, refreshInterval);

    return () => clearInterval(interval);
  }, [refreshInterval, autoScroll, filteredEntries.length]);

  // Handle keyboard input
  useInput((input, key) => {
    if (!interactive) return;

    if (viewState.showHelp) {
      if (input === 'h' || input === '?' || key.escape) {
        setViewState(prev => ({ ...prev, showHelp: false }));
      }
      return;
    }

    // Navigation
    if (key.upArrow || input === 'k') {
      setViewState(prev => ({
        ...prev,
        selectedIndex: Math.max(0, prev.selectedIndex - 1)
      }));
    } else if (key.downArrow || input === 'j') {
      setViewState(prev => ({
        ...prev,
        selectedIndex: Math.min(filteredEntries.length - 1, prev.selectedIndex + 1)
      }));
    } else if (key.pageUp) {
      setViewState(prev => ({
        ...prev,
        selectedIndex: Math.max(0, prev.selectedIndex - 10)
      }));
    } else if (key.pageDown) {
      setViewState(prev => ({
        ...prev,
        selectedIndex: Math.min(filteredEntries.length - 1, prev.selectedIndex + 10)
      }));
    } else if (key.home) {
      setViewState(prev => ({ ...prev, selectedIndex: 0 }));
    } else if (key.end) {
      setViewState(prev => ({ ...prev, selectedIndex: Math.max(0, filteredEntries.length - 1) }));

    // Level filtering
    } else if (input >= '1' && input <= '6') {
      const level = parseInt(input) - 1;
      setViewState(prev => ({
        ...prev,
        filter: { ...prev.filter, level: level as LogLevel }
      }));
    } else if (input === '0') {
      setViewState(prev => ({
        ...prev,
        filter: { ...prev.filter, level: undefined }
      }));

    // Context cycling
    } else if (input === 'c') {
      const contexts = Object.values(LogContext);
      const currentIndex = viewState.filter.context ?
        contexts.indexOf(viewState.filter.context) : -1;
      const nextIndex = (currentIndex + 1) % (contexts.length + 1);
      const nextContext = nextIndex === contexts.length ? undefined : contexts[nextIndex];

      setViewState(prev => ({
        ...prev,
        filter: { ...prev.filter, context: nextContext }
      }));

    // Reset filters
    } else if (input === 'r') {
      setViewState(prev => ({ ...prev, filter: {} }));

    // Toggle panels
    } else if (input === 'd') {
      setViewState(prev => ({ ...prev, showDetails: !prev.showDetails }));
    } else if (input === 'f') {
      setShowFilterPanel(!showFilterPanel);
    } else if (input === 'g') {
      setShowStatsPanel(!showStatsPanel);
    } else if (input === 'h' || input === '?') {
      setViewState(prev => ({ ...prev, showHelp: true }));

    // Quit
    } else if (input === 'q' || key.escape) {
      onClose?.();
    }
  });

  if (viewState.showHelp) {
    return <HelpPanel />;
  }

  const visibleHeight = 20; // Approximate terminal height
  const startIndex = Math.max(0, viewState.selectedIndex - Math.floor(visibleHeight / 2));
  const endIndex = Math.min(filteredEntries.length, startIndex + visibleHeight);
  const visibleEntries = filteredEntries.slice(startIndex, endIndex);

  return (
    <Box flexDirection="row" height="100%">
      {/* Main log display */}
      <Box flexDirection="column" flexGrow={1} padding={1}>
        {/* Header */}
        <Box marginBottom={1} justifyContent="space-between">
          <Text bold color="blue">
            📋 Log Viewer ({filteredEntries.length}/{allEntries.length} entries)
          </Text>
          <Text color="gray">
            Updated: {lastUpdate.toLocaleTimeString()}
          </Text>
        </Box>

        {/* Log entries */}
        <Box flexDirection="column" flexGrow={1}>
          {visibleEntries.length > 0 ? (
            visibleEntries.map((entry, index) => (
              <LogEntryComponent
                key={`${entry.timestamp.getTime()}-${index}`}
                entry={entry}
                index={startIndex + index}
                isSelected={startIndex + index === viewState.selectedIndex}
                showDetails={viewState.showDetails}
              />
            ))
          ) : (
            <Text color="gray">No log entries match the current filter</Text>
          )}
        </Box>

        {/* Footer */}
        <Box marginTop={1}>
          <Text color="gray">
            Navigation: ↑↓/jk | Levels: 1-6,0 | Context: c | Details: d | Filters: f | Stats: g | Help: h | Quit: q
          </Text>
        </Box>
      </Box>

      {/* Side panels */}
      {showFilterPanel && (
        <Box width="30%" borderStyle="single" borderColor="gray">
          <FilterPanel
            filter={viewState.filter}
            onFilterChange={(filter) =>
              setViewState(prev => ({ ...prev, filter }))
            }
          />
        </Box>
      )}

      {showStatsPanel && (
        <Box width="25%" borderStyle="single" borderColor="gray">
          <StatsPanel entries={allEntries} filteredEntries={filteredEntries} />
        </Box>
      )}
    </Box>
  );
};

export default LogViewer;