import { Command } from 'commander';
import inquirer from 'inquirer';
import ora from 'ora';
import { BaseCommand } from './commands.js';
import { resolveProvider } from './router.js';
import { ContextParser } from '../context/parser.js';
import { getCache } from '../context/cache.js';
import { logger } from '../utils/logger.js';
import { ProviderType } from '../config/types.js';
import { InferenceProvider } from '../inference/interface.js';

/**
 * Chat command — interactive conversation with AI
 * buff chat [--provider local] [--model llama2]
 */
export class ChatCommand extends BaseCommand {
  create(): Command {
    const command = new Command('chat')
      .description('Start an interactive chat session with AI')
      .argument('[prompt]', 'Optional initial prompt')
      .option('-f, --file <path>', 'Include file content as context')
      .option('-p, --provider <provider>', 'Inference provider')
      .option('-m, --model <model>', 'Model to use (if omitted, an interactive picker will appear)')
      .option('--no-cache', 'Disable response caching')
      .action(async (prompt?: string, options?: { file?: string; provider?: string; model?: string; cache?: boolean }) => {
        await this.execute(prompt, options || {});
      });

    return command;
  }

  private async execute(prompt?: string, options?: { file?: string; provider?: string; model?: string; cache?: boolean }): Promise<void> {
    let { type, provider } = this.getProvider(options || {});
    let model = options?.model;

    // In interactive mode (no prompt), show the model picker if no --model was specified
    if (!model && !prompt) {
      const picked = await this.showModelPicker();
      if (!picked) return; // User cancelled

      // If user picked a different provider, re-resolve
      if (picked.provider !== type) {
        const resolved = resolveProvider(this.configManager, picked.provider);
        type = resolved.type;
        provider = resolved.provider;
      }
      model = picked.model;
    }

    const available = await provider.isAvailable();
    if (!available) {
      logger.error(`${provider.name} is not available. Check your configuration.`);
      logger.info(`Run: agent-baba-d config --help`);
      return;
    }

    // Determine if caching is enabled (default: enabled, disabled with --no-cache)
    const cacheEnabled = options?.cache !== false;

    // If prompt is provided directly, run one-shot
    if (prompt) {
      const result = await this.generateWithContext(provider, prompt, type, { ...options, model }, cacheEnabled);
      console.log('\n' + result);
      return;
    }

    // Interactive mode
    logger.highlight(`\n🧠 Buff Chat — ${provider.name}`);
    if (model) {
      logger.info(`Model: ${model}`);
    }
    logger.info(`Type your messages, or /help for commands, /exit to quit.\n`);

    const history: Array<{ role: string; content: string }> = [];

    while (true) {
      const answers = await inquirer.prompt<{ message: string }>([
        {
          type: 'input',
          name: 'message',
          message: 'You:',
          prefix: '',
        },
      ]);

      const message = answers.message.trim();

      if (!message) continue;

      if (message.startsWith('/')) {
        if (this.handleCommand(message, provider, model)) break;
        continue;
      }

      history.push({ role: 'user', content: message });

      // Build context from history
      const contextStr = history.map((h) => `${h.role}: ${h.content}`).join('\n');

      const spinner = ora('Thinking...').start();

      try {
        const cache = getCache();
        const effectiveModel = model || this.configManager.getProviderConfig(type).config.model || 'default';
        let result: string | null = null;

        // Check cache if enabled
        if (cacheEnabled) {
          result = await cache.get(message, effectiveModel, type);
        }

        if (!result) {
          const context = new ContextParser().parseFromString(contextStr, 'chat');
          const fullPrompt = ContextParser.formatContext(context);

          result = await provider.generate(fullPrompt, { ...options, model: effectiveModel });

          // Cache the result if caching is enabled
          if (cacheEnabled) {
            await cache.set(message, result, effectiveModel, type);
          }
        }

        spinner.stop();
        console.log(`\n${result}\n`);
        history.push({ role: 'assistant', content: result });
      } catch (err) {
        spinner.fail('Failed to generate response');
        logger.error(String(err));
      }
    }
  }

  /**
   * Show an interactive model picker that discovers available providers
   * and lets the user choose a model before starting the chat.
   */
  private async showModelPicker(): Promise<{ provider: string; model: string } | null> {
    const availableProviders: Array<{ type: ProviderType; provider: InferenceProvider; name: string }> = [];

    // Step 1: Check which providers are available
    logger.highlight('\n🔍 Checking available providers...\n');

    const providerIcons: Record<string, string> = {
      local: '💻',
      nim: '🔶',
      gemini: '🔷',
      openrouter: '🟣',
    };

    const providerEligibility: Record<string, string> = {
      local: 'Works offline — no API key needed',
      nim: 'NVIDIA NIM API cloud service',
      gemini: 'Google Gemini API cloud service',
      openrouter: 'OpenRouter unified API service',
    };

    for (const pt of ['local', 'nim', 'gemini', 'openrouter'] as ProviderType[]) {
      const resolved = resolveProvider(this.configManager, pt);
      const available = await resolved.provider.isAvailable();
      const icon = providerIcons[pt] || '🔹';
      const eligibility = providerEligibility[pt] || '';

      if (available) {
        availableProviders.push({ type: pt, provider: resolved.provider, name: resolved.provider.name });
        logger.success(`  ${icon} ${resolved.provider.name} — ${pt === 'local' ? '✅ Running' : '✅ API key configured'}`);
      } else {
        logger.info(`  ${icon} ${resolved.provider.name} — ⛔ Not available (${eligibility})`);
      }
    }

    if (availableProviders.length === 0) {
      logger.error('\n⚠️  No providers available.');
      logger.info('\nOptions to get started:');
      logger.info('  1. Install Ollama:  brew install ollama && ollama pull deepseek-coder');
      logger.info('  2. Set NIM key:     export NVIDIA_NIM_API_KEY="your-key"');
      logger.info('  3. Set Gemini key:  export GEMINI_API_KEY="your-key"');
      return null;
    }

    // Step 2: Fetch models from available providers
    logger.highlight('\n📡 Fetching available models...\n');

    const choices: Array<{
      name: string;
      value: { provider: string; model: string };
      short?: string;
    }> = [];

    for (const { type, provider: prov, name } of availableProviders) {
      const spinner = ora(`  Loading ${name} models...`).start();

      try {
        const models = await prov.listModels();
        spinner.stop();

        if (models.length === 0) {
          logger.warn(`    ⚠️  No models found for ${name}`);
          continue;
        }

        logger.success(`  ✅ ${name}: ${models.length} model${models.length !== 1 ? 's' : ''} available`);

        // Show up to 10 models per provider to keep the picker manageable
        const MAX_MODELS_PER_PROVIDER = 10;
        const modelsToShow = models.slice(0, MAX_MODELS_PER_PROVIDER);

        for (const model of modelsToShow) {
          const icon = providerIcons[type] || '🔹';
          const owner = model.owner ? ` [${model.owner}]` : '';
          const displayName = `${icon}  ${model.name}${owner}`;
          choices.push({
            name: displayName,
            value: { provider: type, model: model.id },
            short: `${model.id} (${name})`,
          });
        }

        if (models.length > MAX_MODELS_PER_PROVIDER) {
          choices.push({
            name: `     📋 ... and ${models.length - MAX_MODELS_PER_PROVIDER} more (use: agent-baba-d models --provider ${type})`,
            value: { provider: '', model: '' },
          });
        }
      } catch (err) {
        spinner.stop();
        logger.warn(`    ⚠️  Failed to load models from ${name}`);
      }
    }

    if (choices.length === 0) {
      logger.error('\n⚠️  No models found from any available provider.');
      return null;
    }

    // Add cancel option with a sentinel value
    const CANCEL = { provider: '__cancel__', model: '' };
    choices.push({
      name: '  ❌  Cancel',
      value: CANCEL,
    });

    console.log(); // spacing

    // Filter out non-selectable info-only entries (those with empty provider)
    const selectableChoices = choices.filter(c => c.value.provider !== '');

    const answer = await inquirer.prompt<{ selected: { provider: string; model: string } }>([
      {
        type: 'list',
        name: 'selected',
        message: '🎯  Select a model to chat with:',
        choices: selectableChoices.map(c => ({
          name: c.name,
          value: c.value,
          short: c.short,
        })),
        pageSize: Math.min(selectableChoices.length + 2, 20),
        loop: false,
      },
    ]);

    const selected = answer.selected;

    // Handle cancel
    if (selected.provider === '__cancel__') {
      logger.info('\nModel selection cancelled.');
      return null;
    }

    // Separate picker output from chat for a clean start
    console.log('\n'.repeat(2));

    logger.success(`🎯  Selected: ${selected.model}`);
    logger.info(`   Provider: ${availableProviders.find(p => p.type === selected.provider)?.name || selected.provider}\n`);

    return selected;
  }

  /**
   * Handle interactive commands
   */
  private handleCommand(cmd: string, provider: any, model?: string): boolean {
    switch (cmd.toLowerCase()) {
      case '/exit':
      case '/quit':
        console.log('Goodbye!');
        return true;
      case '/help':
        console.log(`
Commands:
  /exit, /quit  Exit the chat
  /clear        Clear conversation history
  /info         Show provider & model info
  /help         Show this help
        `.trim());
        break;
      case '/clear':
        console.log('Conversation history cleared.');
        break;
      case '/info':
        console.log(`\n${provider.getInfo()}${model ? `\n  Model: ${model}` : ''}\n`);
        break;
      default:
        console.log(`Unknown command: ${cmd}. Type /help`);
    }
    return false;
  }

  /**
   * Generate response with file context if needed
   */
  private async generateWithContext(
    provider: any,
    prompt: string,
    providerType: string,
    options?: { file?: string; model?: string },
    cacheEnabled: boolean = true,
  ): Promise<string> {
    let fullPrompt = prompt;

    if (options?.file) {
      const parser = new ContextParser();
      const context = parser.parseFromFiles([options.file]);
      const contextStr = ContextParser.formatContext(context);
      fullPrompt = `${contextStr}\n\n## User Query\n${prompt}`;
    }

    const spinner = ora(`Generating with ${provider.name}...`).start();

    try {
      const result = await provider.generate(fullPrompt, options);
      spinner.stop();
      return result;
    } catch (err) {
      spinner.fail('Generation failed');
      throw err;
    }
  }
}
