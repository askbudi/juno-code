/**
 * Simplified Init command implementation for juno-code CLI
 *
 * Minimal flow: Project Root → Main Task → Editor Selection → Git Setup → Save
 * Removes all complex features: token counting, cost calculation, character limits, etc.
 */

import * as path from 'node:path';
import fs from 'fs-extra';
import chalk from 'chalk';
import { Command } from 'commander';
import * as readline from 'node:readline';

import { loadConfig } from '../../core/config.js';
import type { InitCommandOptions } from '../types.js';
import { ValidationError } from '../types.js';
import type { TemplateVariables } from '../../templates/types.js';

interface InitializationContext {
  targetDirectory: string;
  task: string;
  subagent: string;
  gitUrl?: string;
  variables: TemplateVariables;
  force: boolean;
  interactive: boolean;
}

/**
 * Simplified Interactive TUI for project initialization
 * Minimal flow as requested by user:
 * Project Root → Main Task [Multi line] → select menu [Coding Editors] → Git Setup? yes | No → Save → Already exists? Override | Cancel → Done
 */
class SimpleInitTUI {
  private context: Partial<InitializationContext> = {};

  /**
   * Helper method to prompt for text input using readline
   */
  private async promptForInput(prompt: string, defaultValue: string = ''): Promise<string> {
    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });

      const question = `${prompt}${defaultValue ? ` (default: ${defaultValue})` : ''}: `;
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer.trim() || defaultValue);
      });
    });
  }

  /**
   * Simplified gather method implementing the minimal flow
   */
  async gather(): Promise<InitializationContext> {
    console.log(chalk.blue.bold('\n🚀 Juno Task Project Initialization\n'));

    // 1. Project Root
    console.log(chalk.yellow('📁 Step 1: Project Directory'));
    const targetDirectory = await this.promptForDirectory();

    // 2. Main Task (multi-line, NO character limits)
    console.log(chalk.yellow('\n📝 Step 2: Main Task'));
    const task = await this.promptForTask();

    // 3. Editor Selection (simplified menu)
    console.log(chalk.yellow('\n👨‍💻 Step 3: Select Coding Editor'));
    const editor = await this.promptForEditor();

    // 4. Git Setup (simple yes/no)
    console.log(chalk.yellow('\n🔗 Step 4: Git Setup'));
    const gitUrl = await this.promptForGitSetup();

    // 5. Save confirmation (handle existing files)
    console.log(chalk.yellow('\n💾 Step 5: Save Project'));
    await this.confirmSave(targetDirectory);

    // Create simple variables (no complex template system)
    const variables = this.createSimpleVariables(targetDirectory, task, editor, gitUrl);

    console.log(chalk.green('\n✅ Setup complete! Creating project...\n'));

    return {
      targetDirectory,
      task,
      subagent: 'claude', // Default subagent
      gitUrl,
      variables,
      force: false,
      interactive: true
    };
  }

  private async promptForDirectory(): Promise<string> {
    console.log(chalk.gray('   Enter the target directory for your project'));
    const answer = await this.promptForInput('Directory path', process.cwd());
    return path.resolve(answer || process.cwd());
  }

  private async promptForTask(): Promise<string> {
    console.log(chalk.gray('   Describe what you want to build'));
    console.log(chalk.gray('   You can write multiple lines. Press Ctrl+D when finished.\n'));

    return new Promise((resolve, reject) => {
      let input = '';

      process.stdin.setEncoding('utf8');
      process.stdin.resume();

      process.stdin.on('data', (chunk) => {
        input += chunk;
      });

      process.stdin.on('end', () => {
        const trimmed = input.trim();
        if (!trimmed || trimmed.length < 5) {
          reject(new ValidationError(
            'Task description must be at least 5 characters',
            ['Provide a basic description of what you want to build']
          ));
        } else {
          resolve(trimmed);
        }
      });

      process.stdin.on('error', (error) => {
        reject(new ValidationError(
          `Failed to read input: ${error}`,
          ['Try again with valid input']
        ));
      });
    });
  }

  private async promptForEditor(): Promise<string> {
    console.log(chalk.gray('   Select your preferred coding editor (enter number):'));
    console.log(chalk.gray('   1) VS Code'));
    console.log(chalk.gray('   2) Cursor'));
    console.log(chalk.gray('   3) Vim'));
    console.log(chalk.gray('   4) Emacs'));
    console.log(chalk.gray('   5) Other'));

    const answer = await this.promptForInput('Editor choice', '1');
    const choice = parseInt(answer) || 1;

    switch (choice) {
      case 1: return 'VS Code';
      case 2: return 'Cursor';
      case 3: return 'Vim';
      case 4: return 'Emacs';
      case 5: return 'Other';
      default: return 'VS Code';
    }
  }

  private async promptForGitSetup(): Promise<string | undefined> {
    console.log(chalk.gray('   Would you like to set up Git? (y/n):'));
    const answer = await this.promptForInput('Git setup', 'y').toLowerCase();

    if (answer === 'y' || answer === 'yes') {
      console.log(chalk.gray('   Enter Git repository URL (optional):'));
      const gitUrl = await this.promptForInput('Git URL', '');

      if (gitUrl && gitUrl.trim()) {
        return gitUrl.trim();
      }
    }

    return undefined;
  }

  private async confirmSave(targetDirectory: string): Promise<void> {
    // Check if .juno_task already exists
    const junoTaskPath = path.join(targetDirectory, '.juno_task');

    if (await fs.pathExists(junoTaskPath)) {
      console.log(chalk.yellow('   ⚠️  .juno_task directory already exists'));
      console.log(chalk.gray('   Would you like to:'));
      console.log(chalk.gray('   1) Override existing files'));
      console.log(chalk.gray('   2) Cancel'));

      const answer = await this.promptForInput('Choice', '2');
      const choice = parseInt(answer) || 2;

      if (choice !== 1) {
        console.log(chalk.blue('\n❌ Initialization cancelled'));
        process.exit(0);
      }
    }
  }

  /**
   * Simplified variable creation - no complex template system
   */
  private createSimpleVariables(
    targetDirectory: string,
    task: string,
    editor: string,
    gitUrl?: string
  ): TemplateVariables {
    const projectName = path.basename(targetDirectory);
    const currentDate = new Date().toISOString().split('T')[0];

    return {
      // Core variables only
      PROJECT_NAME: projectName,
      TASK: task,
      EDITOR: editor,
      CURRENT_DATE: currentDate,

      // Simple defaults
      VERSION: '1.0.0',
      AUTHOR: 'Development Team',
      DESCRIPTION: task.substring(0, 200) + (task.length > 200 ? '...' : ''),
      GIT_URL: gitUrl || ''
    };
  }
}

/**
 * Simplified Project Generator - basic file creation only
 */
class SimpleProjectGenerator {
  constructor(private context: InitializationContext) {}

  async generate(): Promise<void> {
    const { targetDirectory, variables } = this.context;

    console.log(chalk.blue('📁 Creating project directory...'));

    // Ensure target directory exists
    await fs.ensureDir(targetDirectory);

    // Create .juno_task directory
    const junoTaskDir = path.join(targetDirectory, '.juno_task');
    await fs.ensureDir(junoTaskDir);

    console.log(chalk.blue('📄 Creating basic project files...'));

    // Create simple prompt.md
    const promptContent = `# Main Task

${variables.TASK}

## Project Details

**Project Name**: ${variables.PROJECT_NAME}
**Preferred Editor**: ${variables.EDITOR}
**Created Date**: ${variables.CURRENT_DATE}
**Version**: ${variables.VERSION}

## Next Steps

1. Review the main task above
2. Run \`juno-code start\` to begin execution
3. Or run \`juno-code -s claude\` to use the main command

${variables.GIT_URL ? `\n## Git Repository\n${variables.GIT_URL}` : ''}
`;

    await fs.writeFile(path.join(junoTaskDir, 'prompt.md'), promptContent);

    // Create simple init.md
    const initContent = `# Main Task

${variables.TASK}

### Project Setup

- **Project Name**: ${variables.PROJECT_NAME}
- **Preferred Editor**: ${variables.EDITOR}
- **Created Date**: ${variables.CURRENT_DATE}

### Getting Started

1. Review the main task above
2. Use \`juno-code start\` to execute with this task
3. Use \`juno-code -s claude\` for quick execution
`;

    await fs.writeFile(path.join(junoTaskDir, 'init.md'), initContent);

    // Create basic README.md in root
    const readmeContent = `# ${variables.PROJECT_NAME}

${variables.DESCRIPTION}

## Getting Started

This project uses juno-code for AI-powered development.

### Prerequisites

- Node.js installed
- juno-code CLI installed

### Quick Start

\`\`\`bash
# Start task execution
juno-code start

# Or use main command
juno-code -s claude
\`\`\`

### Project Structure

\`\`\`
.
├── .juno_task/
│   ├── prompt.md     # Main task definition
│   └── init.md       # Initialization details
└── README.md         # This file
\`\`\`

## Configuration

The project uses \`${variables.EDITOR}\` as the preferred editor.

${variables.GIT_URL ? `\n## Repository\n${variables.GIT_URL}` : ''}

---

Created with juno-code on ${variables.CURRENT_DATE}
`;

    await fs.writeFile(path.join(targetDirectory, 'README.md'), readmeContent);

    console.log(chalk.green.bold('\n✅ Project initialization complete!'));
    this.printNextSteps(targetDirectory);
  }

  private printNextSteps(targetDirectory: string): void {
    console.log(chalk.blue('\n🎯 Next Steps:'));
    console.log(chalk.white(`   cd ${targetDirectory}`));
    console.log(chalk.white('   juno-code start           # Start task execution'));
    console.log(chalk.white('   juno-code -s claude       # Quick execution with Claude'));
    console.log(chalk.gray('\n💡 Tips:'));
    console.log(chalk.gray('   - Edit .juno_task/prompt.md to modify your main task'));
    console.log(chalk.gray('   - Use "juno-task --help" to see all available commands'));
  }
}

/**
 * Headless initialization for automation (simplified)
 */
class SimpleHeadlessInit {
  constructor(private options: InitCommandOptions) {}

  async initialize(): Promise<InitializationContext> {
    const targetDirectory = path.resolve(this.options.directory || process.cwd());
    const task = this.options.task || 'Define your main task objective here';
    const gitUrl = this.options.gitUrl;

    // Create simple variables
    const variables = this.createSimpleVariables(targetDirectory, task, gitUrl);

    return {
      targetDirectory,
      task,
      subagent: 'claude',
      gitUrl,
      variables,
      force: this.options.force || false,
      interactive: false
    };
  }

  private createSimpleVariables(
    targetDirectory: string,
    task: string,
    gitUrl?: string
  ): TemplateVariables {
    const projectName = path.basename(targetDirectory);
    const currentDate = new Date().toISOString().split('T')[0];

    return {
      PROJECT_NAME: projectName,
      TASK: task,
      EDITOR: 'VS Code',
      CURRENT_DATE: currentDate,
      VERSION: '1.0.0',
      AUTHOR: 'Development Team',
      DESCRIPTION: task.substring(0, 200) + (task.length > 200 ? '...' : ''),
      GIT_URL: gitUrl || ''
    };
  }
}

/**
 * Main simplified init command handler
 */
export async function simplifiedInitCommandHandler(
  args: any,
  options: InitCommandOptions,
  command: Command
): Promise<void> {
  try {
    console.log(chalk.blue.bold('🎯 Juno Task - Simplified Initialization'));

    let context: InitializationContext;

    // Default to interactive mode if no task is provided
    const shouldUseInteractive = options.interactive || (!options.task && !process.env.CI);

    if (shouldUseInteractive) {
      // Interactive mode with simplified TUI
      console.log(chalk.yellow('🚀 Starting simple interactive setup...'));
      const tui = new SimpleInitTUI();
      context = await tui.gather();
    } else {
      // Headless mode
      const headless = new SimpleHeadlessInit(options);
      context = await headless.initialize();
    }

    // Generate project
    const generator = new SimpleProjectGenerator(context);
    await generator.generate();

  } catch (error) {
    if (error instanceof ValidationError) {
      console.error(chalk.red.bold('\n❌ Initialization Failed'));
      console.error(chalk.red(`   ${error.message}`));

      if (error.suggestions?.length) {
        console.error(chalk.yellow('\n💡 Suggestions:'));
        error.suggestions.forEach(suggestion => {
          console.error(chalk.yellow(`   • ${suggestion}`));
        });
      }

      process.exit(1);
    }

    // Unexpected error
    console.error(chalk.red.bold('\n❌ Unexpected Error'));
    console.error(chalk.red(`   ${error}`));

    if (options.verbose) {
      console.error('\n📍 Stack Trace:');
      console.error(error);
    }

    process.exit(99);
  }
}