/**
 * LearnCommand — CLI interface for the self-improvement system.
 *
 * Subcommands:
 *   buff learn stats        — Show agent performance stats
 *   buff learn patterns     — Show/extract coding patterns
 *   buff learn optimize     — Generate optimized model routing
 *   buff learn status       — Show overall self-improvement status
 *   buff learn clear        — Reset learning data
 */

import { Command } from 'commander';
import { getAgentStats } from '../learning/agent-stats.js';
import { getSelfImprover } from '../learning/self-improver.js';
import { getPatternStore } from '../learning/pattern-extractor.js';
import { ConfigManager } from '../config/manager.js';
import { ProviderFactory } from '../inference/factory.js';
import type { ProviderType } from '../config/types.js';
import { logger } from '../utils/logger.js';

export class LearnCommand {
  private configManager: ConfigManager;

  constructor(configManager?: ConfigManager) {
    this.configManager = configManager ?? new ConfigManager();
  }

  create(): Command {
    const cmd = new Command('learn')
      .description('Self-improvement system — agent stats, patterns, and optimization');

    cmd
      .command('stats')
      .description('Show per-agent performance statistics')
      .action(() => this.showStats());

    cmd
      .command('patterns')
      .description('Show extracted coding patterns')
      .option('--extract', 'Force pattern extraction from stored trajectories')
      .option('--provider <provider>', 'Provider to use for LLM calls during extraction')
      .option('--model <model>', 'Model to use for extraction')
      .action((opts) => this.showPatterns(opts));

    cmd
      .command('optimize')
      .description('Generate optimized model-to-agent routing recommendations')
      .action(() => this.showOptimizations());

    cmd
      .command('status')
      .description('Show overall self-improvement status')
      .action(() => this.showStatus());

    cmd
      .command('clear')
      .description('Reset all learning data (stats, patterns, memory)')
      .option('-f, --force', 'Skip confirmation prompt')
      .action((opts) => this.clearData(opts));

    return cmd;
  }

  // ── Action handlers ───────────────────────────────────────────────────

  private showStats(): void {
    const stats = getAgentStats();
    console.log(stats.formatStats());

    const recommendations = stats.formatModelRecommendations();
    if (recommendations.includes('→')) {
      console.log('');
      console.log(recommendations);
    }
  }

  private async showPatterns(opts: { extract?: boolean; provider?: string; model?: string }): Promise<void> {
    const patternStore = getPatternStore();
    const patterns = patternStore.getAll();

    if (opts.extract) {
      console.log('🔄 Extracting patterns from stored trajectories...\n');

      const providerType = (opts.provider || this.configManager.getAll().defaultProvider) as ProviderType;
      const { config } = this.configManager.getProviderConfig(providerType);
      const provider = ProviderFactory.createProvider(providerType, config);

      const callLLM = async (prompt: string) => {
        const result = await provider.generate(prompt, {
          model: opts.model || config.model,
          temperature: 0.3,
          maxTokens: 4096,
        });
        return result;
      };

      const improver = getSelfImprover();
      const count = await improver.extractPatterns(callLLM, true);
      improver.resetExtractionCounter();

      if (count === 0) {
        console.log('   No new patterns extracted. Check that trajectories exist and have scores above 0.7.');
      }
      return;
    }

    if (patterns.length === 0) {
      console.log('📝 No patterns found. Run with `--extract` to generate patterns from stored trajectories.');
      return;
    }

    console.log(`📝 ${patterns.length} Coding Pattern(s)\n`);

    for (let i = 0; i < patterns.length; i++) {
      const p = patterns[i];
      console.log(`${'─'.repeat(50)}`);
      console.log(`Pattern ${i + 1}: ${p.title}`);
      console.log(`   Domains: ${p.applicableDomains.join(', ')}`);
      console.log(`   Source trajectories: ${p.sourceCount}`);
      console.log(`   Avg source score: ${(p.avgSourceScore * 100).toFixed(0)}%`);
      console.log('');
      console.log(`   ${p.description}`);
      console.log('');
      console.log(`   Common files: ${p.commonFiles.join(', ')}`);
      console.log(`   Agent sequence: ${p.commonAgentSequence.join(' → ')}`);
    }

    console.log(`${'─'.repeat(50)}`);
  }

  private showOptimizations(): void {
    const improver = getSelfImprover();
    const modelMap = improver.getOptimizedModelMap();

    if (Object.keys(modelMap).length === 0) {
      console.log('🤖 No optimization data yet. Run some agent tasks first to collect performance stats.');
      return;
    }

    console.log('🤖 Optimized Model Recommendations\n');

    for (const [agentType, model] of Object.entries(modelMap)) {
      console.log(`   ${agentType.padEnd(20)} → ${model}`);
    }

    console.log('\nTo use these recommendations, pass:');
    console.log('   `--auto-route` to the execute command, or');
    console.log('   Configure them in your workflow template\'s recommendedModels.');
  }

  private showStatus(): void {
    const improver = getSelfImprover();
    console.log(improver.getStatus());
  }

  private clearData(opts: { force?: boolean }): void {
    if (!opts.force) {
      logger.warn('Use `--force` to confirm clearing all learning data.');
      logger.warn('This will reset agent stats, patterns, and trajectory memory.');
      return;
    }

    getAgentStats().clear();
    getPatternStore().clear();
    getSelfImprover().resetExtractionCounter();

    logger.success('All learning data cleared.');
  }
}
