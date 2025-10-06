/**
 * Headless Mode Utilities for juno-task-ts TUI
 *
 * Utilities for handling headless environments and providing fallback
 * functionality when TUI is not available.
 */

import { isHeadlessEnvironment } from '../../utils/environment.js';

/**
 * Headless fallback for TUI prompt editor
 */
export async function headlessPromptEditor(options: {
  initialValue?: string;
  title?: string;
  maxLength?: number;
}): Promise<string | null> {
  const { initialValue = '', title = 'Enter Prompt', maxLength = 10000 } = options;

  console.log(`\n${title}:`);
  if (initialValue) {
    console.log(`Initial value: ${initialValue}`);
  }
  console.log(`Maximum length: ${maxLength} characters`);
  console.log('Enter your prompt (press Ctrl+D when finished):\n');

  return new Promise((resolve, reject) => {
    let input = initialValue;

    process.stdin.setEncoding('utf8');
    process.stdin.resume();

    process.stdin.on('data', (chunk) => {
      input += chunk;
    });

    process.stdin.on('end', () => {
      const trimmed = input.trim();
      if (!trimmed) {
        resolve(null);
      } else if (trimmed.length > maxLength) {
        console.error(`\nError: Prompt too long (${trimmed.length}/${maxLength} characters)`);
        resolve(null);
      } else {
        resolve(trimmed);
      }
    });

    process.stdin.on('error', (error) => {
      console.error('\nError reading input:', error);
      resolve(null);
    });
  });
}

/**
 * Headless fallback for confirmation dialogs
 */
export async function headlessConfirmation(options: {
  message: string;
  defaultValue?: boolean;
}): Promise<boolean> {
  const { message, defaultValue = false } = options;

  console.log(`\n${message}`);
  console.log(`Enter 'y' for yes, 'n' for no (default: ${defaultValue ? 'y' : 'n'}):`);

  return new Promise((resolve) => {
    const readline = require('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question('> ', (answer: string) => {
      rl.close();

      const trimmed = answer.trim().toLowerCase();
      if (trimmed === 'y' || trimmed === 'yes') {
        resolve(true);
      } else if (trimmed === 'n' || trimmed === 'no') {
        resolve(false);
      } else {
        resolve(defaultValue);
      }
    });
  });
}

/**
 * Headless fallback for selection dialogs
 */
export async function headlessSelection<T>(options: {
  message: string;
  choices: Array<{ label: string; value: T; description?: string }>;
  multiple?: boolean;
}): Promise<T | T[] | null> {
  const { message, choices, multiple = false } = options;

  console.log(`\n${message}`);
  console.log('Available options:');

  choices.forEach((choice, index) => {
    const description = choice.description ? ` - ${choice.description}` : '';
    console.log(`  ${index + 1}. ${choice.label}${description}`);
  });

  if (multiple) {
    console.log('\nEnter numbers separated by commas (e.g., 1,3,5):');
  } else {
    console.log('\nEnter the number of your choice:');
  }

  return new Promise((resolve) => {
    const readline = require('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    rl.question('> ', (answer: string) => {
      rl.close();

      try {
        if (multiple) {
          const indexes = answer
            .split(',')
            .map(s => parseInt(s.trim()) - 1)
            .filter(i => i >= 0 && i < choices.length);

          if (indexes.length === 0) {
            resolve(null);
          } else {
            const selectedValues = indexes.map(i => choices[i].value);
            resolve(selectedValues);
          }
        } else {
          const index = parseInt(answer.trim()) - 1;
          if (index >= 0 && index < choices.length) {
            resolve(choices[index].value);
          } else {
            resolve(null);
          }
        }
      } catch {
        resolve(null);
      }
    });
  });
}

/**
 * Headless fallback for alert dialogs
 */
export function headlessAlert(options: {
  title?: string;
  message: string;
  type?: 'info' | 'success' | 'warning' | 'error';
}): void {
  const { title, message, type = 'info' } = options;

  const typeIcons = {
    info: 'ℹ',
    success: '✓',
    warning: '⚠',
    error: '✗'
  };

  const icon = typeIcons[type];
  const fullMessage = title ? `${title}: ${message}` : message;

  console.log(`\n${icon} ${fullMessage}\n`);
}

/**
 * Detect TUI capability and provide appropriate interface
 */
export function getTUICapabilities(): {
  hasColors: boolean;
  hasUnicode: boolean;
  terminalWidth: number;
  terminalHeight: number;
  isInteractive: boolean;
  supportsRichText: boolean;
} {
  const isInteractive = !isHeadlessEnvironment() && process.stdout.isTTY;

  return {
    hasColors: isInteractive && process.env.TERM !== 'dumb',
    hasUnicode: isInteractive && !process.env.ASCII_ONLY,
    terminalWidth: process.stdout.columns || 80,
    terminalHeight: process.stdout.rows || 24,
    isInteractive,
    supportsRichText: isInteractive && !process.env.NO_RICH_TEXT
  };
}

/**
 * Progressive enhancement based on terminal capabilities
 */
export function enhanceForTerminal(content: {
  plain: string;
  colored?: string;
  unicode?: string;
  rich?: string;
}): string {
  const capabilities = getTUICapabilities();

  if (capabilities.supportsRichText && content.rich) {
    return content.rich;
  }

  if (capabilities.hasUnicode && content.unicode) {
    return content.unicode;
  }

  if (capabilities.hasColors && content.colored) {
    return content.colored;
  }

  return content.plain;
}

/**
 * Safe console output with fallback handling
 */
export function safeConsoleOutput(
  message: string,
  options: {
    type?: 'log' | 'info' | 'warn' | 'error';
    color?: string;
    bold?: boolean;
  } = {}
): void {
  const { type = 'log', color, bold } = options;
  const capabilities = getTUICapabilities();

  let output = message;

  // Apply styling if supported
  if (capabilities.hasColors && (color || bold)) {
    const chalk = require('chalk');

    if (color && chalk[color]) {
      output = chalk[color](output);
    }

    if (bold) {
      output = chalk.bold(output);
    }
  }

  // Output using appropriate method
  console[type](output);
}

/**
 * Create a progress indicator for headless environments
 */
export function createHeadlessProgress(options: {
  total?: number;
  label?: string;
  showPercentage?: boolean;
}): {
  update: (current: number, message?: string) => void;
  complete: (message?: string) => void;
  fail: (message?: string) => void;
} {
  const { total, label = 'Progress', showPercentage = true } = options;
  let lastUpdate = 0;

  return {
    update: (current: number, message?: string) => {
      // Throttle updates to avoid spam
      const now = Date.now();
      if (now - lastUpdate < 100) return;
      lastUpdate = now;

      let output = `${label}: `;

      if (total && showPercentage) {
        const percentage = Math.round((current / total) * 100);
        output += `${percentage}% `;
      }

      if (message) {
        output += message;
      } else if (total) {
        output += `${current}/${total}`;
      } else {
        output += current.toString();
      }

      // Clear line and write progress
      process.stdout.write(`\r${output.padEnd(80)}`);
    },

    complete: (message?: string) => {
      const output = message || `${label}: Complete`;
      console.log(`\r${output.padEnd(80)}`);
    },

    fail: (message?: string) => {
      const output = message || `${label}: Failed`;
      console.error(`\r${output.padEnd(80)}`);
    }
  };
}

/**
 * Environment detection for appropriate fallbacks
 */
export function getEnvironmentType(): 'tui' | 'cli' | 'headless' | 'ci' {
  if (process.env.CI || process.env.CONTINUOUS_INTEGRATION) {
    return 'ci';
  }

  if (isHeadlessEnvironment()) {
    return 'headless';
  }

  if (process.stdout.isTTY && process.env.TERM !== 'dumb') {
    return 'tui';
  }

  return 'cli';
}

export default {
  headlessPromptEditor,
  headlessConfirmation,
  headlessSelection,
  headlessAlert,
  getTUICapabilities,
  enhanceForTerminal,
  safeConsoleOutput,
  createHeadlessProgress,
  getEnvironmentType
};