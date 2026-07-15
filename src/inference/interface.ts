/**
 * A model descriptor returned by listModels()
 */
export interface ModelDescriptor {
  id: string;
  name: string;
  provider: string;
  owner?: string;
  description?: string;
  /**
   * Category tags indicating what this model is good for.
   * Examples: 'chat', 'code', 'fast', 'reasoning', 'vision'
   * Populated by the model-catalog utility when listing models.
   */
  tags?: string[];
}

import { InferenceOptions } from '../config/types.js';

/**
 * Unified inference provider interface.
 * All adapters (local, nim, gemini, openrouter) implement this.
 */
export interface InferenceProvider {
  /** Display name for the provider */
  readonly name: string;

  /**
   * Generate a completion for the given prompt.
   * Returns the generated text content.
   */
  generate(prompt: string, options?: InferenceOptions): Promise<string>;

  /**
   * Generate a streaming completion for the given prompt.
   * Tokens are delivered to onToken as they arrive.
   * Returns the full generated text content.
   */
  generateStream?(
    prompt: string,
    options: InferenceOptions | undefined,
    onToken: (token: string) => void
  ): Promise<string>;

  /**
   * Check if the provider is properly configured and available
   */
  isAvailable(): Promise<boolean>;

  /**
   * Get a description of the current provider configuration
   */
  getInfo(): string;

  /**
   * List available models from this provider
   */
  listModels(): Promise<ModelDescriptor[]>;
}
