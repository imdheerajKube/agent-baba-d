import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { ConfigManager } from '../config/manager.js';

/** Read version from package.json at build time */
const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf-8'));
import { ProviderFactory } from '../inference/factory.js';
import { InferenceProvider } from '../inference/interface.js';
import { ProviderType } from '../config/types.js';
import { ChatCommand } from './chat.js';
import { EditCommand } from './edit.js';
import { PlanCommand } from './plan.js';
import { ConfigCommand } from './config.js';
import { CacheCommand } from './cache.js';
import { ModelsCommand } from './models.js';
import { ExecuteCommand } from './execute.js';
import { RunCommand } from './run.js';
import { WorkflowCommand } from './workflow.js';
import { PluginsCommand } from './plugins.js';
import { LearnCommand } from './learn.js';
import { logger } from '../utils/logger.js';

/**
 * Create and configure the CLI program
 */
export function createCLI(): Command {
  const program = new Command();

  program
    .name('buff')
    .description('Flexible AI inference CLI tool — local models & cloud APIs')
    .version(pkg.version);

  // Global options
  program
    .option('-d, --debug', 'Enable debug logging');

  // Register commands
  const chatCmd = new ChatCommand();
  const editCmd = new EditCommand();
  const planCmd = new PlanCommand();
  const configCmd = new ConfigCommand();
  const cacheCmd = new CacheCommand();
  const modelsCmd = new ModelsCommand();
  const executeCmd = new ExecuteCommand();

  program.addCommand(chatCmd.create());
  program.addCommand(editCmd.create());
  program.addCommand(planCmd.create());
  program.addCommand(configCmd.create());
  program.addCommand(cacheCmd.create());
  program.addCommand(modelsCmd.create());
  program.addCommand(executeCmd.create());

  const runCmd = new RunCommand();
  program.addCommand(runCmd.create());

  const workflowCmd = new WorkflowCommand();
  program.addCommand(workflowCmd.create());

  const pluginsCmd = new PluginsCommand();
  program.addCommand(pluginsCmd.create());

  const learnCmd = new LearnCommand();
  program.addCommand(learnCmd.create());

  // Default action: show help
  program.action(() => {
    program.help();
  });

  return program;
}

/**
 * Resolve the inference provider from CLI options
 */
export function resolveProvider(
  configManager: ConfigManager,
  providerOption?: string,
): { type: ProviderType; provider: InferenceProvider } {
  const rawType = providerOption || configManager.getAll().defaultProvider;

  // Validate that the provider type is a known built-in type
  const validTypes: ProviderType[] = ['local', 'nim', 'gemini', 'openrouter', 'groq'];

  if (!validTypes.includes(rawType as ProviderType)) {
    logger.warn(`Unknown provider '${rawType}'. Falling back to '${configManager.getAll().defaultProvider}'`);
  }

  const providerType = validTypes.includes(rawType as ProviderType)
    ? (rawType as ProviderType)
    : configManager.getAll().defaultProvider;

  const { config } = configManager.getProviderConfig(providerType);
  const provider = ProviderFactory.createProvider(providerType, config);

  logger.debug(`Resolved provider: ${providerType} (${provider.name})`);

  return { type: providerType, provider };
}
