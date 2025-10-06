/**
 * TUI App Framework for juno-task-ts
 *
 * Base TUI application wrapper providing theme context, error boundaries,
 * keyboard handling, and common app functionality.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import { isHeadlessEnvironment } from '../../utils/environment.js';
import type {
  TUIAppProps,
  TUIAppState,
  TUITheme,
  TUIContext,
  KeyBinding,
  LayoutDimensions
} from '../types.js';
import { DEFAULT_TUI_THEME, TUIError } from '../types.js';

/**
 * TUI Context for sharing app state and theme
 */
const TUIContextProvider = React.createContext<TUIContext | null>(null);

/**
 * Custom hook to access TUI context
 */
export const useTUIContext = (): TUIContext => {
  const context = React.useContext(TUIContextProvider);
  if (!context) {
    throw new TUIError('useTUIContext must be used within a TUIApp', 'TUI_CONTEXT_ERROR');
  }
  return context;
};

/**
 * Error boundary for TUI components
 */
class TUIErrorBoundary extends React.Component<
  { children: React.ReactNode; onError?: (error: Error) => void },
  { hasError: boolean; error?: Error }
> {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('TUI Error Boundary caught an error:', error, errorInfo);
    this.props.onError?.(error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <Box flexDirection="column" padding={1}>
          <Text color="red" bold>
            TUI Error: {this.state.error?.message || 'Unknown error'}
          </Text>
          <Text color="gray">
            The application encountered an error and cannot continue.
          </Text>
          <Text color="gray">
            Press ESC to exit or check the logs for more details.
          </Text>
        </Box>
      );
    }

    return this.props.children;
  }
}

/**
 * Main TUI Application wrapper component
 */
export const TUIApp: React.FC<TUIAppProps> = ({
  title,
  exitOnEscape = true,
  theme: customTheme = {},
  children,
  onExit,
  clearOnMount = false
}) => {
  const [appState, setAppState] = useState<TUIAppState>({
    isActive: true,
    isFullscreen: false
  });

  const [currentTheme, setCurrentTheme] = useState<TUITheme>({
    ...DEFAULT_TUI_THEME,
    ...customTheme
  });

  const [dimensions, setDimensions] = useState<LayoutDimensions>({
    width: process.stdout.columns || 80,
    height: process.stdout.rows || 24
  });

  const isHeadless = isHeadlessEnvironment();
  const mountedRef = useRef(false);

  // Handle terminal resize
  useEffect(() => {
    const handleResize = () => {
      setDimensions({
        width: process.stdout.columns || 80,
        height: process.stdout.rows || 24
      });
    };

    if (!isHeadless) {
      process.stdout.on('resize', handleResize);
      return () => {
        process.stdout.off('resize', handleResize);
      };
    }
  }, [isHeadless]);

  // Clear screen on mount if requested
  useEffect(() => {
    if (clearOnMount && !isHeadless && !mountedRef.current) {
      process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
      mountedRef.current = true;
    }
  }, [clearOnMount, isHeadless]);

  // Update theme
  const updateTheme = useCallback((newTheme: Partial<TUITheme>) => {
    setCurrentTheme(prev => ({ ...prev, ...newTheme }));
  }, []);

  // Exit application
  const exit = useCallback((code: number = 0) => {
    setAppState(prev => ({ ...prev, isActive: false }));
    onExit?.(code);
  }, [onExit]);

  // Handle global keyboard shortcuts
  useInput(
    (input, key) => {
      if (!appState.isActive) return;

      // ESC to exit (if enabled)
      if (key.escape && exitOnEscape) {
        exit(0);
        return;
      }

      // Ctrl+C to force exit
      if (key.ctrl && input === 'c') {
        exit(130); // Standard SIGINT exit code
        return;
      }

      // F11 for fullscreen toggle (if supported)
      if (key.f11) {
        setAppState(prev => ({
          ...prev,
          isFullscreen: !prev.isFullscreen
        }));
        return;
      }
    },
    { isActive: appState.isActive }
  );

  // Handle errors
  const handleError = useCallback((error: Error) => {
    setAppState(prev => ({ ...prev, error }));
    console.error('TUI Application Error:', error);
  }, []);

  // Create context value
  const contextValue: TUIContext = {
    theme: currentTheme,
    isHeadless,
    dimensions,
    appState,
    updateTheme,
    exit
  };

  // Headless mode fallback
  if (isHeadless) {
    return (
      <TUIContextProvider.Provider value={contextValue}>
        <Box flexDirection="column">
          {title && (
            <Text bold>{title}</Text>
          )}
          {children}
        </Box>
      </TUIContextProvider.Provider>
    );
  }

  // Full TUI mode
  return (
    <TUIContextProvider.Provider value={contextValue}>
      <TUIErrorBoundary onError={handleError}>
        <Box
          flexDirection="column"
          width={dimensions.width}
          height={appState.isFullscreen ? dimensions.height : undefined}
        >
          {/* Title bar */}
          {title && (
            <Box
              width="100%"
              borderStyle="round"
              borderColor={currentTheme.primary}
              paddingX={1}
              marginBottom={1}
            >
              <Text color={currentTheme.primary} bold>
                {title}
              </Text>
              <Box flexGrow={1} />
              <Text color={currentTheme.muted}>
                {exitOnEscape ? 'ESC to exit' : 'Ctrl+C to exit'}
              </Text>
            </Box>
          )}

          {/* Main content */}
          <Box flexDirection="column" flexGrow={1}>
            {children}
          </Box>

          {/* Error display */}
          {appState.error && (
            <Box
              marginTop={1}
              borderStyle="round"
              borderColor={currentTheme.error}
              paddingX={1}
            >
              <Text color={currentTheme.error}>
                Error: {appState.error.message}
              </Text>
            </Box>
          )}
        </Box>
      </TUIErrorBoundary>
    </TUIContextProvider.Provider>
  );
};

/**
 * TUI Screen component for managing different views
 */
export const TUIScreen: React.FC<{
  name: string;
  isActive: boolean;
  children: React.ReactNode;
  onActivate?: () => void;
  onDeactivate?: () => void;
}> = ({
  name,
  isActive,
  children,
  onActivate,
  onDeactivate
}) => {
  useEffect(() => {
    if (isActive) {
      onActivate?.();
    } else {
      onDeactivate?.();
    }
  }, [isActive, onActivate, onDeactivate]);

  if (!isActive) {
    return null;
  }

  return (
    <Box flexDirection="column" width="100%" height="100%">
      {children}
    </Box>
  );
};

/**
 * TUI Screen manager for handling multiple screens
 */
export const TUIScreenManager: React.FC<{
  screens: Array<{
    name: string;
    component: React.ReactElement;
    onActivate?: () => void;
    onDeactivate?: () => void;
  }>;
  activeScreen: string;
  onScreenChange?: (screenName: string) => void;
}> = ({
  screens,
  activeScreen,
  onScreenChange
}) => {
  const { theme } = useTUIContext();

  return (
    <Box flexDirection="column" width="100%" height="100%">
      {/* Screen tabs */}
      {screens.length > 1 && (
        <Box marginBottom={1}>
          {screens.map((screen, index) => (
            <Box key={screen.name} marginRight={1}>
              <Text
                color={screen.name === activeScreen ? theme.primary : theme.muted}
                bold={screen.name === activeScreen}
              >
                {index + 1}. {screen.name}
              </Text>
            </Box>
          ))}
        </Box>
      )}

      {/* Active screen content */}
      {screens.map(screen => (
        <TUIScreen
          key={screen.name}
          name={screen.name}
          isActive={screen.name === activeScreen}
          onActivate={screen.onActivate}
          onDeactivate={screen.onDeactivate}
        >
          {screen.component}
        </TUIScreen>
      ))}

      {/* Screen navigation help */}
      {screens.length > 1 && (
        <Box marginTop={1} justifyContent="center">
          <Text color={theme.muted}>
            Use Ctrl+1-{screens.length} to switch screens
          </Text>
        </Box>
      )}
    </Box>
  );
};

/**
 * TUI Layout components for common layouts
 */
export const TUILayout = {
  /**
   * Two-column layout
   */
  TwoColumn: ({ left, right, ratio = 0.5 }: {
    left: React.ReactNode;
    right: React.ReactNode;
    ratio?: number;
  }) => {
    const { dimensions } = useTUIContext();
    const leftWidth = Math.floor(dimensions.width * ratio);
    const rightWidth = dimensions.width - leftWidth;

    return (
      <Box width="100%">
        <Box width={leftWidth} flexDirection="column">
          {left}
        </Box>
        <Box width={rightWidth} flexDirection="column">
          {right}
        </Box>
      </Box>
    );
  },

  /**
   * Three-column layout
   */
  ThreeColumn: ({ left, center, right }: {
    left: React.ReactNode;
    center: React.ReactNode;
    right: React.ReactNode;
  }) => {
    const { dimensions } = useTUIContext();
    const columnWidth = Math.floor(dimensions.width / 3);

    return (
      <Box width="100%">
        <Box width={columnWidth} flexDirection="column">
          {left}
        </Box>
        <Box width={columnWidth} flexDirection="column">
          {center}
        </Box>
        <Box width={columnWidth} flexDirection="column">
          {right}
        </Box>
      </Box>
    );
  },

  /**
   * Header/Body/Footer layout
   */
  HeaderBodyFooter: ({ header, body, footer }: {
    header?: React.ReactNode;
    body: React.ReactNode;
    footer?: React.ReactNode;
  }) => (
    <Box flexDirection="column" width="100%" height="100%">
      {header && (
        <Box width="100%">
          {header}
        </Box>
      )}
      <Box flexGrow={1} width="100%">
        {body}
      </Box>
      {footer && (
        <Box width="100%">
          {footer}
        </Box>
      )}
    </Box>
  ),

  /**
   * Sidebar layout
   */
  Sidebar: ({ sidebar, main, sidebarWidth = 20 }: {
    sidebar: React.ReactNode;
    main: React.ReactNode;
    sidebarWidth?: number;
  }) => {
    const { dimensions } = useTUIContext();
    const mainWidth = dimensions.width - sidebarWidth;

    return (
      <Box width="100%">
        <Box width={sidebarWidth} flexDirection="column">
          {sidebar}
        </Box>
        <Box width={mainWidth} flexDirection="column">
          {main}
        </Box>
      </Box>
    );
  }
};

export default TUIApp;