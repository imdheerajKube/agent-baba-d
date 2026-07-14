import { Command } from 'commander';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import ora from 'ora';
import { BaseCommand } from './commands.js';
import { ContextParser } from '../context/parser.js';
import { logger } from '../utils/logger.js';

/**
 * Edit command — edit files using AI assistance
 * buff edit <file> [--provider nim] [--instruction "add error handling"]
 */
export class EditCommand extends BaseCommand {
  create(): Command {
    const command = new Command('edit')
      .description('Edit a file using AI assistance')
      .argument('<file>', 'File to edit')
      .option('-i, --instruction <text>', 'Edit instruction')
      .option('-p, --provider <provider>', 'Inference provider')
      .option('-m, --model <model>', 'Model to use')
      .option('--dry-run', 'Show proposed changes without modifying the file')
      .action(async (file: string, options?: { instruction?: string; provider?: string; model?: string; dryRun?: boolean }) => {
        await this.execute(file, options || {});
      });

    return command;
  }

  private async execute(file: string, options?: { instruction?: string; provider?: string; model?: string; dryRun?: boolean }): Promise<void> {
    if (!existsSync(file)) {
      logger.error(`File not found: ${file}`);
      return;
    }

    const { type, provider } = await this.getProvider(options || {});

    const available = await provider.isAvailable();
    if (!available) {
      logger.error(`${provider.name} is not available. Check your configuration.`);
      return;
    }

    const content = readFileSync(file, 'utf-8');
    const instruction = options?.instruction || 'Review and improve this code. Fix bugs, improve readability, and add error handling where appropriate.';

    const parser = new ContextParser({ maxTokens: 2048 });
    const context = parser.parseFromString(content, file);
    const contextStr = ContextParser.formatContext(context);

    const prompt = `I have the following code in ${file}:\n\n${contextStr}\n\nInstruction: ${instruction}\n\nPlease provide the complete updated file content. Return ONLY the code, no explanations.`;

    const spinner = ora(`Editing ${file} with ${provider.name}...`).start();

    try {
      const result = await provider.generate(prompt, options);

      if (options?.dryRun) {
        spinner.stop();
        logger.highlight('\n--- Proposed Changes ---\n');
        console.log(result);
        logger.highlight('\n--- End ---\n');
        return;
      }

      // Extract code block if present
      let codeResult = result;
      const codeBlockMatch = result.match(/```[\w]*\n([\s\S]*?)```/);
      if (codeBlockMatch) {
        codeResult = codeBlockMatch[1];
      }

      writeFileSync(file, codeResult, 'utf-8');
      spinner.succeed(`Updated ${file}`);
    } catch (err) {
      spinner.fail('Edit failed');
      logger.error(String(err));
    }
  }
}
