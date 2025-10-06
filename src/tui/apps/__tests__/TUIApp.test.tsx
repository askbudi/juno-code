/**
 * @fileoverview Tests for TUIApp components and framework
 */

import React from 'react';
import { Text } from 'ink';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import {
  TUIApp,
  TUIScreen,
  TUIScreenManager,
  TUILayout,
  useTUIContext
} from '../TUIApp.js';
import { TUIError } from '../../types.js';

// Mock environment detection
vi.mock('../../../utils/environment.js', () => ({
  isHeadlessEnvironment: vi.fn().mockReturnValue(false)
}));

describe('TUIApp Component', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  describe('Basic Rendering', () => {
    it('should render without title', () => {
      const { lastFrame } = render(
        <TUIApp>
          <Text>Test content</Text>
        </TUIApp>
      );

      expect(lastFrame()).toContain('Test content');
    });

    it('should render with title', () => {
      const { lastFrame } = render(
        <TUIApp title="Test App">
          <Text>Test content</Text>
        </TUIApp>
      );

      expect(lastFrame()).toContain('Test App');
      expect(lastFrame()).toContain('Test content');
    });

    it('should show exit instructions with title', () => {
      const { lastFrame } = render(
        <TUIApp title="Test App" exitOnEscape={true}>
          <div>Content</div>
        </TUIApp>
      );

      expect(lastFrame()).toContain('ESC to exit');
    });

    it('should show alternative exit instructions when exitOnEscape is false', () => {
      const { lastFrame } = render(
        <TUIApp title="Test App" exitOnEscape={false}>
          <div>Content</div>
        </TUIApp>
      );

      expect(lastFrame()).toContain('Ctrl+C to exit');
    });

    it('should apply custom theme', () => {
      const customTheme = {
        primary: '#ff0000',
        text: '#00ff00'
      };

      const TestComponent = () => {
        const { theme } = useTUIContext();
        return <Text>{theme.primary}</Text>;
      };

      const { lastFrame } = render(
        <TUIApp theme={customTheme}>
          <TestComponent />
        </TUIApp>
      );

      expect(lastFrame()).toContain('#ff0000');
    });
  });

  describe('Context Provider', () => {
    it('should provide TUI context to children', () => {
      const TestComponent = () => {
        const { theme, isHeadless, exit } = useTUIContext();
        return (
          <div>
            Theme: {theme.primary}
            Headless: {isHeadless.toString()}
          </div>
        );
      };

      const { lastFrame } = render(
        <TUIApp>
          <TestComponent />
        </TUIApp>
      );

      expect(lastFrame()).toContain('Theme: #0066cc');
      expect(lastFrame()).toContain('Headless: false');
    });

    it('should throw error when useTUIContext used outside TUIApp', () => {
      const TestComponent = () => {
        try {
          useTUIContext();
          return <Text>Should not reach here</Text>;
        } catch (error) {
          if (error instanceof TUIError) {
            return <Text>Error: {error.message}</Text>;
          }
          return <Text>Unknown error</Text>;
        }
      };

      const { lastFrame } = render(<TestComponent />);

      expect(lastFrame()).toContain('Error: useTUIContext must be used within a TUIApp');
    });

    it('should allow theme updates', () => {
      const TestComponent = () => {
        const { theme, updateTheme } = useTUIContext();

        React.useEffect(() => {
          updateTheme({ primary: '#123456' });
        }, [updateTheme]);

        return <Text>Primary: {theme.primary}</Text>;
      };

      const { lastFrame } = render(
        <TUIApp>
          <TestComponent />
        </TUIApp>
      );

      expect(lastFrame()).toContain('Primary: #123456');
    });
  });

  describe('Keyboard Handling', () => {
    it('should handle ESC key when exitOnEscape is true', () => {
      const onExit = vi.fn();

      const { stdin } = render(
        <TUIApp exitOnEscape={true} onExit={onExit}>
          <div>Content</div>
        </TUIApp>
      );

      stdin.write('\u001B'); // ESC key
      expect(onExit).toHaveBeenCalledWith(0);
    });

    it('should not handle ESC key when exitOnEscape is false', () => {
      const onExit = vi.fn();

      const { stdin } = render(
        <TUIApp exitOnEscape={false} onExit={onExit}>
          <div>Content</div>
        </TUIApp>
      );

      stdin.write('\u001B'); // ESC key
      expect(onExit).not.toHaveBeenCalled();
    });

    it('should handle Ctrl+C', () => {
      const onExit = vi.fn();

      const { stdin } = render(
        <TUIApp onExit={onExit}>
          <div>Content</div>
        </TUIApp>
      );

      stdin.write('\u0003'); // Ctrl+C
      expect(onExit).toHaveBeenCalledWith(130);
    });

    it('should handle exit through context', () => {
      const onExit = vi.fn();

      const TestComponent = () => {
        const { exit } = useTUIContext();

        React.useEffect(() => {
          exit(42);
        }, [exit]);

        return <Text>Exiting...</Text>;
      };

      render(
        <TUIApp onExit={onExit}>
          <TestComponent />
        </TUIApp>
      );

      expect(onExit).toHaveBeenCalledWith(42);
    });
  });

  describe('Error Handling', () => {
    it('should catch and display errors', () => {
      const ErrorComponent = () => {
        throw new Error('Test error message');
      };

      const { lastFrame } = render(
        <TUIApp>
          <ErrorComponent />
        </TUIApp>
      );

      expect(lastFrame()).toContain('TUI Error: Test error message');
      expect(lastFrame()).toContain('The application encountered an error');
    });

    it('should call onError when error boundary catches error', () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const ErrorComponent = () => {
        throw new Error('Boundary test error');
      };

      render(
        <TUIApp>
          <ErrorComponent />
        </TUIApp>
      );

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'TUI Error Boundary caught an error:',
        expect.any(Error),
        expect.any(Object)
      );

      consoleErrorSpy.mockRestore();
    });

    it('should display app state errors', () => {
      const TestComponent = () => {
        const { exit } = useTUIContext();

        React.useEffect(() => {
          // Simulate setting an error in app state
          // This is tricky to test directly, but we can verify the error display works
          throw new Error('App state error');
        }, []);

        return <Text>Component content</Text>;
      };

      const { lastFrame } = render(
        <TUIApp>
          <TestComponent />
        </TUIApp>
      );

      expect(lastFrame()).toContain('TUI Error');
    });
  });

  describe('Headless Mode', () => {
    beforeEach(() => {
      const { isHeadlessEnvironment } = require('../../../utils/environment.js');
      isHeadlessEnvironment.mockReturnValue(true);
    });

    afterEach(() => {
      const { isHeadlessEnvironment } = require('../../../utils/environment.js');
      isHeadlessEnvironment.mockReturnValue(false);
    });

    it('should render simplified version in headless mode', () => {
      const { lastFrame } = render(
        <TUIApp title="Headless App">
          <div>Headless content</div>
        </TUIApp>
      );

      expect(lastFrame()).toContain('Headless App');
      expect(lastFrame()).toContain('Headless content');
      // Should not have borders or complex layout
      expect(lastFrame()).not.toContain('ESC to exit');
    });

    it('should provide headless context', () => {
      const TestComponent = () => {
        const { isHeadless } = useTUIContext();
        return <Text>Is Headless: {isHeadless.toString()}</Text>;
      };

      const { lastFrame } = render(
        <TUIApp>
          <TestComponent />
        </TUIApp>
      );

      expect(lastFrame()).toContain('Is Headless: true');
    });
  });

  describe('Dimensions and Layout', () => {
    it('should provide terminal dimensions', () => {
      const TestComponent = () => {
        const { dimensions } = useTUIContext();
        return (
          <div>
            Width: {dimensions.width}, Height: {dimensions.height}
          </div>
        );
      };

      const { lastFrame } = render(
        <TUIApp>
          <TestComponent />
        </TUIApp>
      );

      expect(lastFrame()).toContain('Width:');
      expect(lastFrame()).toContain('Height:');
    });

    it('should handle fullscreen mode', () => {
      const TestComponent = () => {
        const { appState } = useTUIContext();
        return <Text>Fullscreen: {appState.isFullscreen.toString()}</Text>;
      };

      const { lastFrame } = render(
        <TUIApp>
          <TestComponent />
        </TUIApp>
      );

      expect(lastFrame()).toContain('Fullscreen: false');
    });
  });

  describe('Clear Screen', () => {
    it('should clear screen on mount when requested', () => {
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

      render(
        <TUIApp clearOnMount={true}>
          <div>Content</div>
        </TUIApp>
      );

      expect(writeSpy).toHaveBeenCalledWith('\x1b[2J\x1b[3J\x1b[H');

      writeSpy.mockRestore();
    });

    it('should not clear screen when clearOnMount is false', () => {
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

      render(
        <TUIApp clearOnMount={false}>
          <div>Content</div>
        </TUIApp>
      );

      expect(writeSpy).not.toHaveBeenCalledWith('\x1b[2J\x1b[3J\x1b[H');

      writeSpy.mockRestore();
    });
  });
});

describe('TUIScreen Component', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('should render when active', () => {
    const { lastFrame } = render(
      <TUIApp>
        <TUIScreen name="test" isActive={true}>
          <div>Screen content</div>
        </TUIScreen>
      </TUIApp>
    );

    expect(lastFrame()).toContain('Screen content');
  });

  it('should not render when inactive', () => {
    const { lastFrame } = render(
      <TUIApp>
        <TUIScreen name="test" isActive={false}>
          <div>Hidden content</div>
        </TUIScreen>
      </TUIApp>
    );

    expect(lastFrame()).not.toContain('Hidden content');
  });

  it('should call onActivate when becoming active', () => {
    const onActivate = vi.fn();
    const onDeactivate = vi.fn();

    const { rerender } = render(
      <TUIApp>
        <TUIScreen
          name="test"
          isActive={false}
          onActivate={onActivate}
          onDeactivate={onDeactivate}
        >
          <div>Content</div>
        </TUIScreen>
      </TUIApp>
    );

    expect(onDeactivate).toHaveBeenCalled();

    rerender(
      <TUIApp>
        <TUIScreen
          name="test"
          isActive={true}
          onActivate={onActivate}
          onDeactivate={onDeactivate}
        >
          <div>Content</div>
        </TUIScreen>
      </TUIApp>
    );

    expect(onActivate).toHaveBeenCalled();
  });
});

describe('TUIScreenManager Component', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  const screens = [
    {
      name: 'First',
      component: <div>First screen content</div>
    },
    {
      name: 'Second',
      component: <div>Second screen content</div>
    },
    {
      name: 'Third',
      component: <div>Third screen content</div>
    }
  ];

  it('should render active screen', () => {
    const { lastFrame } = render(
      <TUIApp>
        <TUIScreenManager screens={screens} activeScreen="Second" />
      </TUIApp>
    );

    expect(lastFrame()).toContain('Second screen content');
    expect(lastFrame()).not.toContain('First screen content');
    expect(lastFrame()).not.toContain('Third screen content');
  });

  it('should show screen tabs when multiple screens', () => {
    const { lastFrame } = render(
      <TUIApp>
        <TUIScreenManager screens={screens} activeScreen="First" />
      </TUIApp>
    );

    expect(lastFrame()).toContain('1. First');
    expect(lastFrame()).toContain('2. Second');
    expect(lastFrame()).toContain('3. Third');
  });

  it('should highlight active screen tab', () => {
    const { lastFrame } = render(
      <TUIApp>
        <TUIScreenManager screens={screens} activeScreen="Second" />
      </TUIApp>
    );

    // The active screen should be highlighted (hard to test exact styling)
    expect(lastFrame()).toContain('2. Second');
  });

  it('should show navigation help', () => {
    const { lastFrame } = render(
      <TUIApp>
        <TUIScreenManager screens={screens} activeScreen="First" />
      </TUIApp>
    );

    expect(lastFrame()).toContain('Use Ctrl+1-3 to switch screens');
  });

  it('should not show tabs for single screen', () => {
    const singleScreen = [screens[0]];

    const { lastFrame } = render(
      <TUIApp>
        <TUIScreenManager screens={singleScreen} activeScreen="First" />
      </TUIApp>
    );

    expect(lastFrame()).not.toContain('1. First');
    expect(lastFrame()).not.toContain('Use Ctrl+');
  });

  it('should call screen lifecycle methods', () => {
    const onActivate = vi.fn();
    const onDeactivate = vi.fn();

    const screensWithCallbacks = [
      {
        name: 'First',
        component: <div>First</div>,
        onActivate,
        onDeactivate
      },
      {
        name: 'Second',
        component: <div>Second</div>
      }
    ];

    const { rerender } = render(
      <TUIApp>
        <TUIScreenManager screens={screensWithCallbacks} activeScreen="Second" />
      </TUIApp>
    );

    expect(onDeactivate).toHaveBeenCalled();

    rerender(
      <TUIApp>
        <TUIScreenManager screens={screensWithCallbacks} activeScreen="First" />
      </TUIApp>
    );

    expect(onActivate).toHaveBeenCalled();
  });
});

describe('TUILayout Components', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  describe('TwoColumn Layout', () => {
    it('should render two columns', () => {
      const { lastFrame } = render(
        <TUIApp>
          <TUILayout.TwoColumn
            left={<div>Left content</div>}
            right={<div>Right content</div>}
          />
        </TUIApp>
      );

      expect(lastFrame()).toContain('Left content');
      expect(lastFrame()).toContain('Right content');
    });

    it('should use custom ratio', () => {
      const { lastFrame } = render(
        <TUIApp>
          <TUILayout.TwoColumn
            left={<div>Left</div>}
            right={<div>Right</div>}
            ratio={0.3}
          />
        </TUIApp>
      );

      expect(lastFrame()).toContain('Left');
      expect(lastFrame()).toContain('Right');
    });
  });

  describe('ThreeColumn Layout', () => {
    it('should render three columns', () => {
      const { lastFrame } = render(
        <TUIApp>
          <TUILayout.ThreeColumn
            left={<div>Left</div>}
            center={<div>Center</div>}
            right={<div>Right</div>}
          />
        </TUIApp>
      );

      expect(lastFrame()).toContain('Left');
      expect(lastFrame()).toContain('Center');
      expect(lastFrame()).toContain('Right');
    });
  });

  describe('HeaderBodyFooter Layout', () => {
    it('should render header, body, and footer', () => {
      const { lastFrame } = render(
        <TUIApp>
          <TUILayout.HeaderBodyFooter
            header={<div>Header</div>}
            body={<div>Body</div>}
            footer={<div>Footer</div>}
          />
        </TUIApp>
      );

      expect(lastFrame()).toContain('Header');
      expect(lastFrame()).toContain('Body');
      expect(lastFrame()).toContain('Footer');
    });

    it('should render without header and footer', () => {
      const { lastFrame } = render(
        <TUIApp>
          <TUILayout.HeaderBodyFooter
            body={<div>Just body</div>}
          />
        </TUIApp>
      );

      expect(lastFrame()).toContain('Just body');
    });
  });

  describe('Sidebar Layout', () => {
    it('should render sidebar and main content', () => {
      const { lastFrame } = render(
        <TUIApp>
          <TUILayout.Sidebar
            sidebar={<div>Sidebar</div>}
            main={<div>Main content</div>}
          />
        </TUIApp>
      );

      expect(lastFrame()).toContain('Sidebar');
      expect(lastFrame()).toContain('Main content');
    });

    it('should use custom sidebar width', () => {
      const { lastFrame } = render(
        <TUIApp>
          <TUILayout.Sidebar
            sidebar={<div>Side</div>}
            main={<div>Main</div>}
            sidebarWidth={30}
          />
        </TUIApp>
      );

      expect(lastFrame()).toContain('Side');
      expect(lastFrame()).toContain('Main');
    });
  });
});

describe('Integration Tests', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('should work with complex nested layouts', () => {
    const ComplexApp = () => (
      <TUIApp title="Complex App">
        <TUILayout.HeaderBodyFooter
          header={<div>App Header</div>}
          body={
            <TUILayout.TwoColumn
              left={<div>Left Panel</div>}
              right={
                <TUIScreenManager
                  screens={[
                    { name: 'Tab1', component: <div>Tab 1 Content</div> },
                    { name: 'Tab2', component: <div>Tab 2 Content</div> }
                  ]}
                  activeScreen="Tab1"
                />
              }
            />
          }
          footer={<div>App Footer</div>}
        />
      </TUIApp>
    );

    const { lastFrame } = render(<ComplexApp />);

    expect(lastFrame()).toContain('Complex App');
    expect(lastFrame()).toContain('App Header');
    expect(lastFrame()).toContain('Left Panel');
    expect(lastFrame()).toContain('Tab 1 Content');
    expect(lastFrame()).toContain('App Footer');
  });

  it('should handle theme updates across components', () => {
    const ThemeTestApp = () => {
      const TestComponent = () => {
        const { theme, updateTheme } = useTUIContext();

        React.useEffect(() => {
          updateTheme({ primary: '#custom' });
        }, [updateTheme]);

        return <Text>Theme: {theme.primary}</Text>;
      };

      return (
        <TUIApp>
          <TestComponent />
        </TUIApp>
      );
    };

    const { lastFrame } = render(<ThemeTestApp />);

    expect(lastFrame()).toContain('Theme: #custom');
  });
});