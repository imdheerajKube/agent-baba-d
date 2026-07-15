import { createInterface } from 'node:readline';

import { Command } from 'commander';
import inquirer from 'inquirer';
import ora from 'ora';
import { BaseCommand } from './commands.js';
import { resolveProvider } from './router.js';
import { showModelPicker } from './model-picker.js';
import { ContextParser } from '../context/parser.js';
import { getCache } from '../context/cache.js';
import { logger } from '../utils/logger.js';
import { Orchestrator } from '../agents/orchestrator.js';
import { printOrchestrationResult } from './execute.js';

/**
 * Patterns that indicate a user wants to CREATE or MODIFY files on disk
 * (as opposed to just asking a conversational question).
 */
const CREATION_PATTERNS = [
  /\b(?:create|write|make|build|generate|implement|scaffold)\b.*\b(?:file|program|script|app|function|class|module|component|page|route|api|endpoint|service|cli|tool|package|library|project)\b/i,
  /\b(?:add|create|write|make)\b.*\b(?:new)\b.*\b(?:file|function|class|feature)\b/i,
  /\b(?:set\s*up|scaffold|bootstrap|init|start)\b.*\b(?:project|app|module|package)\b/i,
  /\b(?:create|write)\b.*\bpython|javascript|typescript|go|rust|java|ruby|bash|shell|node\b.*\b(?:program|script|file)\b/i,
  /^\s*(?:create|write|make|build|generate)\s+(?:a|an|the)\s+/i,
];

function hasCreationIntent(message: string): boolean {
  return CREATION_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Prompt the user whether they want to switch to developer mode.
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
 */
async function runDeveloperMode(
  goal: string,
  configManager: any,
  options?: { provider?: string; model?: string },
): Promise<void> {
  const spinner = ora({
    text: '📋 Planning...',
    spinner: 'dots',
  }).start();

  try {
    const orchestrator = new Orchestrator(configManager);
    const result = await orchestrator.execute(goal, {
      provider: options?.provider,
      model: options?.model,
      verbose: true,
      spinner: {
        stop: () => spinner.stop(),
        start: (text?: string) => spinner.start(text),
      },
    });

    spinner.stop();
    console.log('');
    printOrchestrationResult(result);
  } catch (err) {
    spinner.fail('Developer mode execution failed');
    logger.error(String(err));
  }
}



// ─── ChatCommand ────────────────────────────────────────────────────────────

export class ChatCommand extends BaseCommand {
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
      if (!picked) return;

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

    const cacheEnabled = options?.cache !== false;

    if (prompt) {
      if (options?.dev || hasCreationIntent(prompt)) {
        const proceed = options?.dev || await promptDeveloperMode(prompt);
        if (proceed) {
          await runDeveloperMode(prompt, this.configManager, { provider: type, model });
          return;
        }
      }

      const result = await this.generateWithContext(provider, prompt, type, { ...options, model }, cacheEnabled);
      console.log('\n' + result);
      return;
    }

    logger.highlight(`\n🧠 Buff Chat — ${provider.name}`);
    if (model) {
      logger.info(`Model: ${model}`);
    }
    logger.info(`Type your messages, or /help for commands, /exit to quit.`);
    logger.info(`💡 Tip: Ask me to "create" something and I'll offer to switch to developer mode!\n`);

    const history: Array<{ role: string; content: string }> = [];
    this.devModeAuto = false;

    while (true) {
      const message = await this.readMultiLineInput('You:');
      if (!message) continue;

      if (message.startsWith('/')) {
        if (this.handleCommand(message, provider, model)) break;
        continue;
      }

      if (hasCreationIntent(message) || this.devModeAuto) {
        const proceed = this.devModeAuto || await promptDeveloperMode(message);
        if (proceed) {
          await runDeveloperMode(message, this.configManager, { provider: type, model });
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
      }

      history.push({ role: 'user', content: message });

      const contextStr = history.map((h) => `${h.role}: ${h.content}`).join('\n');
      const cache = getCache();
      const effectiveModel = model || this.configManager.getProviderConfig(type).config.model || 'default';

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
   * Show a categorized model picker that groups models by capability.
   *
   * Example output:
   *
   *   🎯  Available Models
   *
   *   💬 Chat (General conversation)
   *    1. 🟢  llama-3.3-70b-versatile  ⭐ Best all-rounder — strong at...
   *    2. 🟢  gemma2-9b-it
   *
   *   💻 Code (Code generation, programming)
   *    3. 🔷  gemini-2.0-flash-exp  ⭐ Latest Gemini — fast, multimodal...
   *
   *   Enter a number (0-8):
   */
  private async showModelPicker(): Promise<{ provider: string; model: string } | null> {
    return showModelPicker(this.configManager);
  }

  /**
   * Read multi-line input from stdin using readline.
   *
   * - First line prompt: "You: "
   * - Continuation lines prompt: "  > "
   * - Pressing Enter with no text on the first line re-prompts
   * - An empty line after non-empty input submits the message
   * - This allows pasting multi-line text (each line collected), then Enter to submit
   */
  private readMultiLineInput(prompt: string): Promise<string> {
    return new Promise((resolve) => {
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: prompt + ' ',
      });

      const lines: string[] = [];
      let isFirstLine = true;

      rl.on('line', (line) => {
        if (isFirstLine) {
          isFirstLine = false;
          if (line === '') {
            // Just pressed Enter on first line with no text — re-prompt
            rl.prompt();
            isFirstLine = true;
            return;
          }
          lines.push(line);
          // Commands (starting with '/') should submit immediately — no continuation needed
          if (line.startsWith('/')) {
            rl.close();
            return;
          }
          rl.setPrompt('  > ');
          rl.prompt();
        } else {
          if (line === '') {
            // Empty line on continuation — submit the full message
            rl.close();
          } else {
            lines.push(line);
            rl.prompt();
          }
        }
      });

      rl.on('close', () => {
        resolve(lines.join('\n'));
      });

      rl.prompt();
    });
  }

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
