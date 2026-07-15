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
import { Orchestrator } from '../agents/orchestrator.js';
import { printOrchestrationResult } from './execute.js';

/**
 * Patterns that indicate a user wants to CREATE or MODIFY files on disk
 * (as opposed to just asking a conversational question).
 *
 * When the user's message matches these patterns, the chat will offer to
 * switch to "developer mode" — which runs the full multi-agent pipeline
 * to actually create the files in the project directory.
 */
const CREATION_PATTERNS = [
  /\b(?:create|write|make|build|generate|implement|scaffold)\b.*\b(?:file|program|script|app|function|class|module|component|page|route|api|endpoint|service|cli|tool|package|library|project)\b/i,
  /\b(?:add|create|write|make)\b.*\b(?:new)\b.*\b(?:file|function|class|feature)\b/i,
  /\b(?:set\s*up|scaffold|bootstrap|init|start)\b.*\b(?:project|app|module|package)\b/i,
  /\b(?:create|write)\b.*\bpython|javascript|typescript|go|rust|java|ruby|bash|shell|node\b.*\b(?:program|script|file)\b/i,
  /^\s*(?:create|write|make|build|generate)\s+(?:a|an|the)\s+/i,
];

/**
 * Check if a user message looks like a file-creation request.
 */
function hasCreationIntent(message: string): boolean {
  return CREATION_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Prompt the user whether they want to switch to developer mode.
 * Returns true if they want to proceed with file creation.
 */
async function promptDeveloperMode(message: string): Promise<boolean> {
  console.log('');
  logger.info('💡 I noticed you\'re asking me to create something!');
  logger.info('   I can either:');
  logger.info('     1. 💬  Just show you the code as text (chat mode)');
  logger.info('     2. 🏗️  Actually create the files in your project (developer mode)');
  console.log('');

  const answer = await inquirer.prompt<{ choice: string }>([
    {
      type: 'list',
      name: 'choice',
      message: 'How would you like me to handle this?',
      prefix: '🔧',
      choices: [
        { name: '🏗️  Developer mode — Create the files in my project directory', value: 'dev' },
        { name: '💬  Chat mode — Just show me the code as text', value: 'chat' },
      ],
    },
  ]);

  console.log('');
  return answer.choice === 'dev';
}

/**
 * Execute the multi-agent pipeline for a user's goal.
 * Returns true if the execution completed (for flow control).
 */
async function runDeveloperMode(
  goal: string,
  configManager: any,
  options?: { provider?: string; model?: string },
): Promise<void> {
  const spinner = ora({
    text: 'Planning...',
    spinner: 'dots',
  }).start();

  try {
    const orchestrator = new Orchestrator(configManager);
    const result = await orchestrator.execute(goal, {
      provider: options?.provider,
      model: options?.model,
      verbose: true,
    });

    spinner.stop();
    console.log('');
    printOrchestrationResult(result);
  } catch (err) {
    spinner.fail('Developer mode execution failed');
    logger.error(String(err));
  }
}

/**
 * Chat command — interactive conversation with AI
 * buff chat [--provider local] [--model llama2]
 *
 * When the user asks to create files, the chat automatically offers to
 * switch to developer mode (execute pipeline) for direct file creation.
 */
export class ChatCommand extends BaseCommand {
  /** Tracks whether /dev mode is active (auto-runs orchestrator for all messages) */
  private devModeAuto = false;

  create(): Command {
    const command = new Command('chat')
      .description('Start an interactive chat session with AI')
      .argument('[prompt]', 'Optional initial prompt')
      .option('-f, --file <path>', 'Include file content as context')
      .option('-p, --provider <provider>', 'Inference provider')
      .option('-m, --model <model>', 'Model to use (if omitted, an interactive picker will appear)')
      .option('--no-cache', 'Disable response caching')
      .option('-d, --dev', 'Skip the prompt and always use developer mode for creation requests', false)
      .action(async (prompt?: string, options?: { file?: string; provider?: string; model?: string; cache?: boolean; dev?: boolean }) => {
        await this.execute(prompt, options || {});
      });

    return command;
  }

  private async execute(prompt?: string, options?: { file?: string; provider?: string; model?: string; cache?: boolean; dev?: boolean }): Promise<void> {
    let { type, provider } = await this.getProvider(options || {});
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

    // ── One-shot mode ───────────────────────────────────────────────────
    if (prompt) {
      // Check for creation intent
      if (options?.dev || hasCreationIntent(prompt)) {
        const proceed = options?.dev || await promptDeveloperMode(prompt);
        if (proceed) {
          await runDeveloperMode(prompt, this.configManager, { provider: type, model });
          return;
        }
      }

      // Normal chat response
      const result = await this.generateWithContext(provider, prompt, type, { ...options, model }, cacheEnabled);
      console.log('\n' + result);
      return;
    }

    // ── Interactive mode ─────────────────────────────────────────────────
    logger.highlight(`\n🧠 Buff Chat — ${provider.name}`);
    if (model) {
      logger.info(`Model: ${model}`);
    }
    logger.info(`Type your messages, or /help for commands, /exit to quit.`);
    logger.info(`💡 Tip: Ask me to "create" something and I'll offer to switch to developer mode!\n`);

    const history: Array<{ role: string; content: string }> = [];
    this.devModeAuto = false; // Reset /dev toggle on each chat session

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

      // ── Check for creation intent ─────────────────────────────────────
      if (hasCreationIntent(message) || this.devModeAuto) {
        const proceed = this.devModeAuto || await promptDeveloperMode(message);
        if (proceed) {
          await runDeveloperMode(message, this.configManager, { provider: type, model });
          // After developer mode completes, ask if they want to continue chatting
          const continueAnswer = await inquirer.prompt<{ cont: string }>([
            {
              type: 'input',
              name: 'cont',
              message: 'Press Enter to continue chatting, or type /exit to quit:',
              prefix: '',
            },
          ]);
          if (continueAnswer.cont.trim().toLowerCase() === '/exit' || continueAnswer.cont.trim().toLowerCase() === '/quit') {
            console.log('Goodbye!');
            break;
          }
          continue;
        }
        // User chose chat mode — fall through to normal LLM response
      }

      history.push({ role: 'user', content: message });

      // Build context from history
      const contextStr = history.map((h) => `${h.role}: ${h.content}`).join('\n');

      const cache = getCache();
      const effectiveModel = model || this.configManager.getProviderConfig(type).config.model || 'default';

      // Check cache first
      if (cacheEnabled) {
        const cachedResult = await cache.get(message, effectiveModel, type);
        if (cachedResult) {
          console.log(`\n${cachedResult}\n`);
          history.push({ role: 'assistant', content: cachedResult });
          continue;
        }
      }

      const context = new ContextParser().parseFromString(contextStr, 'chat');
      const fullPrompt = ContextParser.formatContext(context);

      // Use streaming when available
      if (typeof provider.generateStream === 'function') {
        console.log();
        try {
          const result = await provider.generateStream(
            fullPrompt,
            { ...options, model: effectiveModel },
            (token: string) => {
              process.stdout.write(token);
            },
          );
          console.log('\n');

          if (cacheEnabled) {
            await cache.set(message, result, effectiveModel, type);
          }

          history.push({ role: 'assistant', content: result });
        } catch (err) {
          console.log();
          logger.error(String(err));
        }
      } else {
        const spinner = ora('Thinking...').start();
        try {
          const result = await provider.generate(fullPrompt, { ...options, model: effectiveModel });
          spinner.stop();
          console.log(`\n${result}\n`);

          if (cacheEnabled) {
            await cache.set(message, result, effectiveModel, type);
          }

          history.push({ role: 'assistant', content: result });
        } catch (err) {
          spinner.fail('Failed to generate response');
          logger.error(String(err));
        }
      }
    }
  }

  /**
   * Show a cross-platform numbered menu that discovers available providers
   * and lets the user choose a model before starting the chat.
   */
  private async showModelPicker(): Promise<{ provider: string; model: string } | null> {
    logger.highlight('\n🔍 Checking available providers...\n');

    const providerIcons: Record<string, string> = {
      local: '💻',
      nim: '🔶',
      gemini: '🔷',
      openrouter: '🟣',
      groq: '🟢',
    };

    const providerEligibility: Record<string, string> = {
      local: 'Works offline — no API key needed',
      nim: 'NVIDIA NIM API cloud service',
      gemini: 'Google Gemini API cloud service',
      openrouter: 'OpenRouter unified API service',
      groq: 'Groq LPU cloud inference service',
    };

    const providerTypes: ProviderType[] = ['local', 'nim', 'gemini', 'openrouter', 'groq'];

    const checkResults = await Promise.all(
      providerTypes.map(async (pt) => {
        const resolved = resolveProvider(this.configManager, pt);
        const available = await resolved.provider.isAvailable();
        return { pt, resolved, available };
      })
    );

    const availableProviders: Array<{ type: ProviderType; provider: InferenceProvider; name: string }> = [];

    for (const { pt, resolved, available } of checkResults) {
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

    logger.highlight('\n📡 Fetching available models...\n');

    const loadingSpinner = ora('  Loading models...').start();

    interface ModelChoice {
      label: string;
      provider: string;
      model: string;
    }

    const modelChoices: ModelChoice[] = [];

    const modelResults = await Promise.all(
      availableProviders.map(async ({ type, provider: prov, name }) => {
        try {
          const models = await prov.listModels();
          return { type, name, models, error: null as Error | null };
        } catch (err) {
          return { type, name, models: null as null, error: err as Error };
        }
      })
    );

    loadingSpinner.stop();

    for (const { type, name, models, error } of modelResults) {
      if (error) {
        logger.warn(`    ⚠️  Failed to load models from ${name}`);
        continue;
      }

      if (!models || models.length === 0) {
        logger.warn(`    ⚠️  No models found for ${name}`);
        continue;
      }

      logger.success(`  ✅ ${name}: ${models.length} model${models.length !== 1 ? 's' : ''} available`);

      const MAX_MODELS_PER_PROVIDER = 15;
      const modelsToShow = models.slice(0, MAX_MODELS_PER_PROVIDER);

      for (const model of modelsToShow) {
        const icon = providerIcons[type] || '🔹';
        const owner = model.owner ? ` [${model.owner}]` : '';
        const label = `${icon}  ${model.name}${owner}`;
        modelChoices.push({ label, provider: type, model: model.id });
      }

      if (models.length > MAX_MODELS_PER_PROVIDER) {
        logger.info(`    📋 ... and ${models.length - MAX_MODELS_PER_PROVIDER} more (use: agent-baba-d models --provider ${type})`);
      }
    }

    if (modelChoices.length === 0) {
      logger.error('\n⚠️  No models found from any available provider.');
      return null;
    }

    console.log();
    logger.highlight('🎯  Available Models\n');

    for (let i = 0; i < modelChoices.length; i++) {
      const num = (i + 1).toString().padStart(2, ' ');
      console.log(`  ${num}. ${modelChoices[i].label}`);
    }
    console.log(`   0. ❌  Cancel`);
    console.log();

    const selectableTotal = modelChoices.length;

    const answer = await inquirer.prompt<{ selected: string }>([
      {
        type: 'input',
        name: 'selected',
        message: `Enter a number (0-${selectableTotal}):`,
        prefix: '🔢',
        validate: (input: string) => {
          const trimmed = input.trim();
          if (trimmed === '') return 'Please enter a number';
          const num = Number(trimmed);
          if (isNaN(num) || !Number.isInteger(num)) return 'Please enter a valid whole number';
          if (num < 0 || num > selectableTotal) return `Please enter a number between 0 and ${selectableTotal}`;
          return true;
        },
      },
    ]);

    const selectedIndex = parseInt(answer.selected.trim(), 10);

    if (selectedIndex === 0) {
      logger.info('\nModel selection cancelled.');
      return null;
    }

    const selected = modelChoices[selectedIndex - 1];

    console.log('\n'.repeat(2));

    const providerName = availableProviders.find(p => p.type === selected.provider)?.name || selected.provider;
    logger.success(`🎯  Selected: ${selected.model}`);
    logger.info(`   Provider: ${providerName}\n`);

    return { provider: selected.provider, model: selected.model };
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
  /dev          Switch to developer mode for your next prompt
        `.trim());
        break;
      case '/clear':
        console.log('Conversation history cleared.');
        break;
      case '/info':
        console.log(`\n${provider.getInfo()}${model ? `\n  Model: ${model}` : ''}\n`);
        break;
      case '/dev':
        this.devModeAuto = !this.devModeAuto;
        if (this.devModeAuto) {
          logger.success('✅ Developer mode ACTIVATED — all messages will auto-create files.');
        } else {
          logger.info('ℹ️  Developer mode DEACTIVATED — creation requests will ask for confirmation.');
        }
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

    if (typeof provider.generateStream === 'function') {
      const chunks: string[] = [];
      await provider.generateStream(
        fullPrompt,
        options,
        (token: string) => {
          chunks.push(token);
        },
      );
      return chunks.join('');
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
