import { Command } from 'commander';
import { ConfigManager } from '../config/manager.js';

/**
 * Base class for all CLI commands
 */
export abstract class BaseCommand {
  protected configManager: ConfigManager;

  constructor() {
    this.configManager = new ConfigManager();
  }

  /**
   * Create the Commander command
   */
  abstract create(): Command;

  /**
   * Get the provider from CLI options
   */
  protected async getProvider(options: { provider?: string; model?: string }) {
    const { resolveProvider } = await import('./router.js');
    return resolveProvider(this.configManager, options.provider);
  }
}
