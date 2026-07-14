/**
 * Workflow command — Lists and runs pre-built pipeline templates.
 *
 * Usage:
 *   buff workflow list                    — Show available workflow templates
 *   buff workflow run quick-fix "goal"    — Run the quick-fix workflow
 *   buff workflow run feature-implement "add auth" --dry-run
 */

import { Command } from 'commander';
import ora from 'ora';

import { BaseCommand } from './commands.js';
import { Orchestrator } from '../agents/orchestrator.js';
import { getWorkflowTemplates, getWorkflowTemplate, buildTaskPlanFromTemplate, buildWorkflowOptions } from '../workflow/templates.js';
import { logger } from '../utils/logger.js';
import { printOrchestrationResult } from './execute.js';

/**
 * Workflow command for listing and running pre-built pipeline templates.
 */
export class WorkflowCommand extends BaseCommand {
  create(): Command {
    const command = new Command('workflow')
      .description('Run pre-built workflow templates (quick-fix, feature-implement, publish-release)');

    // ── list ──────────────────────────────────────────────────────────────
    command
      .command('list')
      .description('Show available workflow templates')
      .action(() => {
        this.listWorkflows();
      });

    // ── run ───────────────────────────────────────────────────────────────
    command
      .command('run')
      .description('Run a workflow template')
      .argument('<template>', 'Template name (quick-fix, feature-implement, publish-release)')
      .argument('<goal>', 'The goal to accomplish')
      .option('-p, --provider <provider>', 'Inference provider override')
      .option('-m, --model <model>', 'Model override')
      .option('--dry-run', 'Preview changes without writing to disk', false)
      .option('-v, --verbose', 'Show detailed agent output', false)
      .action(async (template: string, goal: string, options: {
        provider?: string;
        model?: string;
        dryRun?: boolean;
        verbose?: boolean;
      }) => {
        await this.runWorkflow(template, goal, options);
      });

    return command;
  }

  private listWorkflows(): void {
    const templates = getWorkflowTemplates();

    logger.highlight(`${'═'.repeat(60)}`);
    logger.highlight('  📋  Available Workflow Templates');
    logger.highlight(`${'═'.repeat(60)}`);

    for (const t of templates) {
      console.log(`\n  ${t.id}`);
      console.log(`  ${'─'.repeat(t.id.length)}`);
      console.log(`  ${t.description}`);
      console.log(`  Steps:`);
      for (const step of t.steps) {
        console.log(`    ▶ [${step.agentType}] ${step.description.split(' for:')[0]}`);
      }
    }

    console.log('\n  Usage:');
    console.log('    buff workflow run <template> "<goal>"');
    console.log('    buff workflow run quick-fix "fix the login bug"\n');
  }

  private async runWorkflow(
    templateId: string,
    goal: string,
    options: {
      provider?: string;
      model?: string;
      dryRun?: boolean;
      verbose?: boolean;
    },
  ): Promise<void> {
    const template = getWorkflowTemplate(templateId);
    if (!template) {
      logger.error(`Unknown workflow template: '${templateId}'`);
      console.log(`\nAvailable templates: ${getWorkflowTemplates().map((t) => t.id).join(', ')}`);
      return;
    }

    // Build the task plan from the template
    const taskPlan = buildTaskPlanFromTemplate(template, goal);
    const workflowOptions = buildWorkflowOptions(template, options);

    if (options.verbose) {
      logger.info(`Workflow: ${template.name}`);
      logger.info(`Template: ${template.id}`);
      logger.info(`Steps: ${taskPlan.length}`);
      if (template.recommendedModels) {
        logger.info('Recommended models:');
        for (const [agent, model] of Object.entries(template.recommendedModels)) {
          logger.info(`  ${agent}: ${model}`);
        }
      }
      console.log('');
    }

    // Execute via orchestrator with the pre-built plan
    const spinner = ora({
      text: `Running workflow '${template.id}'...`,
      spinner: 'dots',
    }).start();

    try {
      const orchestrator = new Orchestrator(this.configManager);
      const result = await orchestrator.execute(goal, {
        ...workflowOptions,
        provider: options.provider,
        model: options.model,
        dryRun: options.dryRun,
        verbose: options.verbose,
        prefillPlan: taskPlan, // Skip the planner, use the pre-built plan
      });

      spinner.stop();
      console.log('');
      printOrchestrationResult(result);

    } catch (err) {
      spinner.fail(`Workflow '${template.id}' failed`);
      logger.error(String(err));
    }
  }
}
