/**
 * CLI test runner for juno-task-ts
 *
 * Simple test utilities to verify CLI command structure and functionality
 * without requiring full test framework setup.
 */

import chalk from 'chalk';
import * as fs from 'fs-extra';
import * as path from 'path';

/**
 * Test result interface
 */
interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  duration: number;
}

/**
 * CLI structure tester
 */
export class CLITester {
  private results: TestResult[] = [];

  /**
   * Run all tests
   */
  async runTests(): Promise<void> {
    console.log(chalk.blue.bold('\n🧪 Testing CLI Implementation\n'));

    await this.testFileStructure();
    await this.testImportStructure();
    await this.testCommandExports();

    this.printResults();
  }

  /**
   * Test file structure
   */
  private async testFileStructure(): Promise<void> {
    const requiredFiles = [
      'src/bin/cli.ts',
      'src/cli/commands/init.ts',
      'src/cli/commands/start.ts',
      'src/cli/commands/feedback.ts',
      'src/cli/commands/session.ts',
      'src/cli/commands/setup-git.ts',
      'src/cli/commands/main.ts',
      'src/cli/types.ts',
      'src/cli/utils/completion.ts',
      'src/cli/utils/errors.ts',
      'src/cli/utils/progress.ts'
    ];

    for (const file of requiredFiles) {
      await this.runTest(`File exists: ${file}`, async () => {
        const fullPath = path.resolve(process.cwd(), file);
        const exists = await fs.pathExists(fullPath);
        if (!exists) {
          throw new Error(`File not found: ${fullPath}`);
        }
      });
    }
  }

  /**
   * Test import structure
   */
  private async testImportStructure(): Promise<void> {
    const commandFiles = [
      'src/cli/commands/init.ts',
      'src/cli/commands/start.ts',
      'src/cli/commands/feedback.ts',
      'src/cli/commands/session.ts',
      'src/cli/commands/setup-git.ts'
    ];

    for (const file of commandFiles) {
      await this.runTest(`Valid imports: ${file}`, async () => {
        const fullPath = path.resolve(process.cwd(), file);
        const content = await fs.readFile(fullPath, 'utf-8');

        // Check for required exports
        if (!content.includes('export async function') && !content.includes('export function configure')) {
          throw new Error('Missing required command handler or configure function');
        }

        // Check for proper imports
        if (!content.includes('import') || !content.includes('from')) {
          throw new Error('Missing import statements');
        }
      });
    }
  }

  /**
   * Test command exports
   */
  private async testCommandExports(): Promise<void> {
    const commandExports = [
      { file: 'src/cli/commands/init.ts', exports: ['configureInitCommand', 'initCommandHandler'] },
      { file: 'src/cli/commands/start.ts', exports: ['configureStartCommand', 'startCommandHandler'] },
      { file: 'src/cli/commands/feedback.ts', exports: ['configureFeedbackCommand', 'feedbackCommandHandler'] },
      { file: 'src/cli/commands/session.ts', exports: ['configureSessionCommand', 'sessionCommandHandler'] },
      { file: 'src/cli/commands/setup-git.ts', exports: ['configureSetupGitCommand', 'setupGitCommandHandler'] }
    ];

    for (const { file, exports } of commandExports) {
      await this.runTest(`Exports present: ${file}`, async () => {
        const fullPath = path.resolve(process.cwd(), file);
        const content = await fs.readFile(fullPath, 'utf-8');

        for (const exportName of exports) {
          if (!content.includes(exportName)) {
            throw new Error(`Missing export: ${exportName}`);
          }
        }
      });
    }
  }

  /**
   * Run individual test
   */
  private async runTest(name: string, testFn: () => Promise<void>): Promise<void> {
    const startTime = Date.now();

    try {
      await testFn();
      const duration = Date.now() - startTime;
      this.results.push({ name, passed: true, duration });
      console.log(chalk.green(`✓ ${name}`));
    } catch (error) {
      const duration = Date.now() - startTime;
      this.results.push({
        name,
        passed: false,
        error: error instanceof Error ? error.message : String(error),
        duration
      });
      console.log(chalk.red(`✗ ${name}`));
      if (error instanceof Error) {
        console.log(chalk.red(`  ${error.message}`));
      }
    }
  }

  /**
   * Print test results summary
   */
  private printResults(): void {
    const passed = this.results.filter(r => r.passed).length;
    const failed = this.results.filter(r => !r.passed).length;
    const total = this.results.length;

    console.log(chalk.blue.bold('\n📊 Test Results Summary:'));
    console.log(chalk.green(`   Passed: ${passed}`));
    console.log(chalk.red(`   Failed: ${failed}`));
    console.log(chalk.white(`   Total: ${total}`));

    if (failed > 0) {
      console.log(chalk.red.bold('\n❌ Some tests failed. Review the errors above.'));
    } else {
      console.log(chalk.green.bold('\n✅ All tests passed! CLI implementation is ready.'));
    }
  }
}

/**
 * Run CLI tests if executed directly
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  const tester = new CLITester();
  tester.runTests().catch(error => {
    console.error(chalk.red.bold('\n💥 Test runner failed:'));
    console.error(chalk.red(`   ${error}`));
    process.exit(1);
  });
}