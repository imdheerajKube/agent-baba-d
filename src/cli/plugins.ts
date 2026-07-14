/**
 * Plugins command — Lists and manages agent plugins and workflow templates.
 *
 * Usage:
 *   buff plugins list          — Show discovered plugins and workflow templates
 *   buff plugins scan          — Force re-scan of ~/.buff/agents/ and ~/.buff/workflows/
 */

import { Command } from 'commander';

import { BaseCommand } from './commands.js';
import { getPluginStats, discoverAgentPlugins, discoverWorkflowPlugins } from '../plugins/agent-plugin.js';
import { logger } from '../utils/logger.js';
import { getWorkflowTemplates } from '../workflow/templates.js';

export class PluginsCommand extends BaseCommand {
  create(): Command {
    const command = new Command('plugins')
      .description('Manage agent plugins and workflow templates');

    // ── list ──────────────────────────────────────────────────────────────
    command
      .command('list')
      .description('List all discovered plugins and workflows')
      .action(() => this.listPlugins());

    // ── scan ──────────────────────────────────────────────────────────────
    command
      .command('scan')
      .description('Force re-scan plugin directories')
      .action(() => this.scanPlugins());

    return command;
  }

  private async listPlugins(): Promise<void> {
    const stats = getPluginStats();

    logger.highlight(`${'═'.repeat(60)}`);
    logger.highlight('  🔌  Plugin System');
    logger.highlight(`${'═'.repeat(60)}`);

    // ── Built-in workflow templates ──────────────────────────────────────
    const builtinWorkflows = getWorkflowTemplates();
    console.log(`\n  📋 Built-in Workflow Templates: ${builtinWorkflows.length}`);
    for (const w of builtinWorkflows) {
      console.log(`    ${w.id}: ${w.name} (${w.steps.length} steps)`);
    }

    // ── Discovered agent plugins ──────────────────────────────────────────
    console.log(`\n  🤖 Agent Plugins: ${stats.agentPlugins} discovered`);
    if (stats.agentPlugins > 0) {
      try {
        const plugins = await discoverAgentPlugins();
        for (const [type, plugin] of plugins) {
          console.log(`    📦 ${type}: ${plugin.metadata.name} v${plugin.metadata.version}`);
        }
      } catch {
        console.log('    (run `buff plugins scan` to reload)');
      }
    } else {
      console.log('    (no agent plugins found in ~/.buff/agents/)');
    }

    // ── Discovered workflow plugins ──────────────────────────────────────
    console.log(`\n  📄 Workflow Plugins: ${stats.workflowPlugins} discovered`);
    if (stats.workflowPlugins > 0) {
      try {
        const workflows = discoverWorkflowPlugins();
        for (const w of workflows) {
          console.log(`    📄 ${w.id}: ${w.name} (${w.steps.length} steps)`);
        }
      } catch {
        console.log('    (run `buff plugins scan` to reload)');
      }
    } else {
      console.log('    (no workflow plugins found in ~/.buff/workflows/)');
    }

    // ── Plugin directories ──────────────────────────────────────────────
    console.log(`\n  📁 Plugin Directories:`);
    console.log(`    Agent plugins: ~/.buff/agents/`);
    console.log(`    Workflow templates: ~/.buff/workflows/`);
    console.log('');
  }

  private async scanPlugins(): Promise<void> {
    logger.info('Scanning for plugins...');

    const agentPlugins = await discoverAgentPlugins();
    const workflowPlugins = discoverWorkflowPlugins();

    console.log(`\n  ✅ Scan complete`);
    console.log(`  Agent plugins: ${agentPlugins.size} found`);
    console.log(`  Workflow plugins: ${workflowPlugins.length} found`);
    console.log('');

    // Show what was discovered
    for (const [type, plugin] of agentPlugins) {
      logger.success(`  Agent: ${type} ← ${plugin.metadata.name} v${plugin.metadata.version}`);
    }
    for (const w of workflowPlugins) {
      logger.success(`  Workflow: ${w.id} ← ${w.name}`);
    }

    if (agentPlugins.size === 0 && workflowPlugins.length === 0) {
      console.log('  Tip: Place .js agent files in ~/.buff/agents/ or .json workflow files in ~/.buff/workflows/');
    }
  }
}
