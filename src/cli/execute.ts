/**
 * Execute command — Run a multi-agent pipeline to accomplish a goal.
 *
 * Usage:
 *   agent-baba-d execute "add JWT authentication to the Express app"
 *   agent-baba-d execute "create a CLI tool" --provider gemini --dry-run
 *   agent-baba-d execute "add tests" --verbose --memory
 *   agent-baba-d execute "fix bug" --memory --memory-stats
 */

import { Command } from 'commander';
import ora from 'ora';

import { BaseCommand } from './commands.js';
import { Orchestrator } from '../agents/orchestrator.js';
import { logger } from '../utils/logger.js';

/**
 * Execute command — orchestrates multiple agents to accomplish a goal.
 */
export class ExecuteCommand extends BaseCommand {
  create(): Command {
    const command = new Command('execute')
      .description('Run a multi-agent pipeline to accomplish a goal')
      .argument('<goal>', 'The goal to accomplish (e.g., "add JWT auth to Express app")')
      .option('-p, --provider <provider>', 'Inference provider for all agents')
      .option('-m, --model <model>', 'Model override for all agents')
      .option('--planner-model <model>', 'Model for the Planner agent')
      .option('--gatherer-model <model>', 'Model for the Context Gatherer agent')
      .option('--writer-model <model>', 'Model for the Writer agent')
      .option('--reviewer-model <model>', 'Model for the Reviewer agent')
      .option('--dry-run', 'Preview changes without writing to disk', false)
      .option('-v, --verbose', 'Show detailed agent output', false)
      .option('--memory', 'Enable persistent memory (learn from past sessions)', false)
      .option('--memory-stats', 'Show memory statistics and exit', false)
      .option('--memory-clear', 'Clear all stored memory trajectories', false)
      .action(async (goal: string, options?: {
        provider?: string;
        model?: string;
        plannerModel?: string;
        gathererModel?: string;
        writerModel?: string;
        reviewerModel?: string;
        dryRun?: boolean;
        verbose?: boolean;
        memory?: boolean;
        memoryStats?: boolean;
        memoryClear?: boolean;
      }) => {
        await this.execute(goal, options || {});
      });

    return command;
  }

  private async execute(
    goal: string,
    options: {
      provider?: string;
      model?: string;
      plannerModel?: string;
      gathererModel?: string;
      writerModel?: string;
      reviewerModel?: string;
      dryRun?: boolean;
      verbose?: boolean;
      memory?: boolean;
      memoryStats?: boolean;
      memoryClear?: boolean;
    },
  ): Promise<void> {
    // ── Handle memory management commands ─────────────────────────────────
    if (options.memoryStats) {
      await this.showMemoryStats();
      return;
    }

    if (options.memoryClear) {
      await this.clearMemory();
      return;
    }

    // ── Setup ──────────────────────────────────────────────────────────────
    if (options.verbose || options.dryRun) {
      logger.info(`Goal: ${goal}`);
      if (options.dryRun) logger.info('Mode: Dry run (files will not be modified)');
      if (options.provider) logger.info(`Provider: ${options.provider}`);
      if (options.model) logger.info(`Model: ${options.model}`);
      if (options.memory) logger.info('Memory: Enabled');
      console.log('');
    }

    // ── Agent model overrides ──────────────────────────────────────────────
    const agentModels: Record<string, string> = {};
    if (options.plannerModel) agentModels['planner'] = options.plannerModel;
    if (options.gathererModel) agentModels['context-gatherer'] = options.gathererModel;
    if (options.writerModel) agentModels['writer'] = options.writerModel;
    if (options.reviewerModel) agentModels['reviewer'] = options.reviewerModel;

    // ── Execute ────────────────────────────────────────────────────────────
    const spinner = ora({
      text: 'Planning...',
      spinner: 'dots',
    }).start();

    try {
      const orchestrator = new Orchestrator(this.configManager);
      const result = await orchestrator.execute(goal, {
        provider: options.provider,
        model: options.model,
        agentModels: Object.keys(agentModels).length > 0 ? agentModels : undefined,
        dryRun: options.dryRun,
        verbose: options.verbose,
        useMemory: options.memory,
      });

      spinner.stop();

      // ── Display Results ──────────────────────────────────────────────────
      console.log('');
      printOrchestrationResult(result);

    } catch (err) {
      spinner.fail('Execution failed');
      logger.error(String(err));
    }
  }

  private async showMemoryStats(): Promise<void> {
    try {
      const { getMemoryStats } = await import('../memory/memory-integration.js');
      const stats = await getMemoryStats();

      logger.highlight(`${'═'.repeat(60)}`);
      logger.highlight(`  🧠  Memory Statistics`);
      logger.highlight(`${'═'.repeat(60)}`);

      console.log(`\n  Total trajectories: ${stats.total}`);
      console.log(`  Average quality score: ${stats.avgScore}`);

      if (Object.keys(stats.byProjectFingerprint).length > 0) {
        console.log(`\n  By project type:`);
        for (const [fp, count] of Object.entries(stats.byProjectFingerprint)) {
          console.log(`    ${fp}: ${count}`);
        }
      }

      console.log('');
      logger.highlight(`${'═'.repeat(60)}`);
      console.log('');
    } catch (err) {
      logger.error(`Failed to read memory stats: ${err}`);
    }
  }

  private async clearMemory(): Promise<void> {
    try {
      const { clearMemory } = await import('../memory/memory-integration.js');
      await clearMemory();
      logger.success('Memory cleared successfully');
    } catch (err) {
      logger.error(`Failed to clear memory: ${err}`);
    }
  }
}

/**
 * Pretty-print the orchestration result to the console.
 */
export function printOrchestrationResult(result: import('../agents/orchestrator.js').OrchestrationResult): void {
  // Header
  const statusIcon = result.success ? '✅' : '❌';
  logger.highlight(`${'═'.repeat(60)}`);
  logger.highlight(`  ${statusIcon}  Execution Result`);
  logger.highlight(`${'═'.repeat(60)}`);

  // Goal
  console.log(`\n  Goal: ${result.goal}`);

  // Summary
  console.log(`\n  ${result.summary}`);
  console.log(`  Tasks: ${result.tasksCompleted}/${result.tasksTotal} completed`);

  // Trajectory ID
  if (result.trajectoryId) {
    console.log(`  Memory: Stored as ${result.trajectoryId}`);
  }

  // Agent results
  if (result.agentResults.length > 0) {
    console.log(`\n  Agents:`);
    for (const ar of result.agentResults) {
      const icon = ar.success ? '✅' : '❌';
      const truncatedSummary = ar.summary.length > 120
        ? ar.summary.slice(0, 120) + '...'
        : ar.summary;
      console.log(`    ${icon} ${ar.agent}: ${truncatedSummary}`);
    }
  }

  // File changes
  if (result.fileChanges && result.fileChanges !== 'No files changed.') {
    console.log(`\n  File Changes:`);
    for (const line of result.fileChanges.split('\n')) {
      console.log(`    ${line}`);
    }
  }

  // Runner output
  if (result.runOutput) {
    console.log(`\n  Command Output:`);
    for (const line of result.runOutput.split('\n')) {
      console.log(`    ${line}`);
    }
  }

  // Error
  if (result.error) {
    console.log(`\n  Error: ${result.error}`);
  }

  console.log('');
  logger.highlight(`${'═'.repeat(60)}`);
  console.log('');
}
