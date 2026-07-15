/**
 * Run command — Execute a shell command directly using the RunnerAgent.
 *
 * This is a lightweight shortcut that bypasses the multi-agent pipeline
 * and runs a command immediately, showing stdout/stderr output.
 *
 * Usage:
 *   buff run "echo hello world"
 *   buff run "npm test" --verbose
 *   buff run "python hello.py" --timeout 30000
 *   buff run "node index.js" --provider groq --model "llama-3.1-8b-instant"
 */

import { Command } from 'commander';

import { BaseCommand } from './commands.js';
import { RunnerAgent } from '../agents/agents/runner.js';
import type { AgentContext } from '../agents/agent.js';
import { logger } from '../utils/logger.js';

/**
 * Run command — lightweight shell command execution via RunnerAgent.
 */
export class RunCommand extends BaseCommand {
  create(): Command {
    const command = new Command('run')
      .description('Execute a shell command and show output (lightweight alternative to the full pipeline)')
      .argument('<command>', 'The shell command to execute (wrap in quotes if it contains spaces)')
      .option('-t, --timeout <ms>', 'Command timeout in milliseconds', parseInt, 120_000)
      .option('-v, --verbose', 'Show detailed execution info', false)
      .action(async (command: string, options?: {
        timeout?: number;
        verbose?: boolean;
        provider?: string;
        model?: string;
      }) => {
        await this.execute(command, options || {});
      });

    return command;
  }

  private async execute(
    command: string,
    options: {
      timeout?: number;
      verbose?: boolean;
      provider?: string;
      model?: string;
    },
  ): Promise<void> {
    // ── Setup ──────────────────────────────────────────────────────────────
    if (options.verbose) {
      logger.info(`Command: ${command}`);
      console.log('');
    }

    // ── Build minimal agent context ────────────────────────────────────────
    // The RunnerAgent expects a taskPlan with a 'runner' step so it can
    // extract the command from the task description using its determineCommand logic.
    // We pass the command as the description with "Run:" prefix for direct execution.
    const context: AgentContext = {
      goal: command,
      workingDirectory: process.cwd(),
      taskPlan: [
        {
          id: 'step-1',
          description: `Run: ${command}`,
          agentType: 'runner',
          dependsOn: [],
          status: 'running',
        },
      ],
      artifacts: [],
      conversations: [],
      fileChanges: [],
      metadata: {
        runnerTimeout: options.timeout,
      },
    };

    // ── Execute via RunnerAgent ────────────────────────────────────────────
    const runner = new RunnerAgent();

    try {
      const startTime = Date.now();
      const result = await runner.execute(context, async () => {
        // No LLM fallback needed — the "Run:" prefix in the task description
        // is used directly by determineCommand. This mock is never called.
        throw new Error('Unexpected LLM call in run command');
      });
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      // ── Display Results ──────────────────────────────────────────────────
      const runResult = context.metadata['runResult'] as {
        success: boolean;
        command: string;
        exitCode: number;
        stdout: string;
        stderr: string;
        duration: number;
        error?: string;
      } | undefined;

      // Header
      const statusIcon = result.success ? '✅' : '❌';
      logger.highlight(`${'═'.repeat(60)}`);
      logger.highlight(`  ${statusIcon}  Run Result — ${elapsed}s`);
      logger.highlight(`${'═'.repeat(60)}`);

      console.log(`\n  $ ${command}`);
      console.log(`  Exit code: ${runResult?.exitCode ?? '?'}  |  Duration: ${elapsed}s`);

      // Show stdout (always)
      if (runResult?.stdout) {
        console.log('');
        // Print stdout directly (not indented) for cleaner display
        process.stdout.write(runResult.stdout);
        if (!runResult.stdout.endsWith('\n')) console.log('');
      }

      // Show stderr if there was an error
      if (runResult?.stderr && runResult.exitCode !== 0) {
        console.log('');
        logger.error('stderr:');
        process.stderr.write(runResult.stderr);
        if (!runResult.stderr.endsWith('\n')) console.log('');
      }

      // Error message
      if (result.error) {
        console.log('');
        logger.error(`Error: ${result.error}`);
      }

      console.log('');
      logger.highlight(`${'═'.repeat(60)}`);
      console.log('');

    } catch (err) {
      logger.error(`Run failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
