import * as readline from 'node:readline';
import chalk from 'chalk';

export interface MultilineOptions {
  label: string;
  hint?: string;
  prompt?: string;
  minLength?: number; // minimum non-whitespace length for validation
}

/**
 * Collects multiline input using a single readline.Interface so that large
 * pastes are captured reliably. Terminates on double Enter (two consecutive
 * empty lines). Single blank lines are preserved in the content.
 */
export async function promptMultiline({
  label,
  hint = 'Finish with double Enter. Blank lines are kept.',
  prompt = '  ',
  minLength,
}: MultilineOptions): Promise<string> {
  // Print label and hint once (minimal style akin to Python CLI)
  if (label) console.log(chalk.gray(`   ${label}`));
  if (hint) console.log(chalk.gray(`   ${hint}`));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt(prompt);

  const lines: string[] = [];
  let consecutiveEmpty = 0;

  return new Promise<string>((resolve) => {
    rl.on('line', (line) => {
      // Detect double empty lines to finish
      if (line.trim() === '') {
        consecutiveEmpty += 1;
        if (consecutiveEmpty >= 2) {
          rl.close();
          return;
        }
        // Single empty line is part of content
        lines.push('');
        rl.prompt();
        return;
      }

      consecutiveEmpty = 0;
      lines.push(line);
      rl.prompt();
    });

    rl.on('close', () => {
      const content = lines.join('\n').trimEnd();
      if (minLength && content.replace(/\s+/g, '').length < minLength) {
        resolve('');
      } else {
        resolve(content);
      }
    });

    rl.prompt();
  });
}

export async function promptInputOnce(question: string, defaultValue = ''): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const q = `${question}${defaultValue ? ` (default: ${defaultValue})` : ''}: `;
    rl.question(q, (answer) => {
      rl.close();
      const v = answer.trim();
      resolve(v.length ? v : defaultValue);
    });
  });
}

