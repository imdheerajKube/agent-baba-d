import { InferenceProvider, ModelDescriptor } from './interface.js';
import { InferenceOptions, ProviderConfig } from '../config/types.js';
import { logger } from '../utils/logger.js';
import { streamCompletion } from './sse.js';

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

interface GroqResponse {
  choices: Array<{
    message: { content: string };
  }>;
}

/**
 * Groq Adapter
 * Connects to Groq's OpenAI-compatible API for fast inference
 */
export class GroqAdapter implements InferenceProvider {
  readonly name = 'Groq';
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  async generate(prompt: string, options?: InferenceOptions): Promise<string> {
    const apiKey = this.config.apiKey;
    if (!apiKey) {
      throw new Error('Groq API key is not configured. Set GROQ_API_KEY env var.');
    }

    const model = options?.model || this.config.model || 'llama-3.3-70b-versatile';
    const temperature = options?.temperature ?? this.config.temperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? this.config.maxTokens ?? 4096;

    logger.debug(`Groq: Generating with model=${model}, temperature=${temperature}, maxTokens=${maxTokens}`);

    const response = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature,
        max_tokens: maxTokens,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Groq API error (${response.status}): ${errorBody}`);
    }

    const data = (await response.json()) as GroqResponse;
    return data.choices[0]?.message?.content || '';
  }

  async generateStream(
    prompt: string,
    options: InferenceOptions | undefined,
    onToken: (token: string) => void,
  ): Promise<string> {
    const apiKey = this.config.apiKey;
    if (!apiKey) {
      throw new Error('Groq API key is not configured. Set GROQ_API_KEY env var.');
    }

    const model = options?.model || this.config.model || 'llama-3.3-70b-versatile';
    const temperature = options?.temperature ?? this.config.temperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? this.config.maxTokens ?? 4096;

    logger.debug(`Groq: Streaming with model=${model}, temperature=${temperature}, maxTokens=${maxTokens}`);

    return streamCompletion(
      `${GROQ_BASE_URL}/chat/completions`,
      { 'Authorization': `Bearer ${apiKey}` },
      { model, messages: [{ role: 'user', content: prompt }], temperature, max_tokens: maxTokens },
      onToken,
    );
  }

  async isAvailable(): Promise<boolean> {
    return !!this.config.apiKey;
  }

  getInfo(): string {
    return `Provider: Groq\nModel: ${this.config.model || 'default'}\nStatus: ${this.config.apiKey ? '✅ Configured' : '❌ Missing API key'}`;
  }

  async listModels(): Promise<ModelDescriptor[]> {
    const apiKey = this.config.apiKey;
    if (!apiKey) return [];

    try {
      const response = await fetch(`${GROQ_BASE_URL}/models`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });
      if (!response.ok) return [];
      const data = (await response.json()) as { data: Array<{ id: string; owned_by?: string }> };
      return (data.data || []).map((m: { id: string; owned_by?: string }) => ({
        id: m.id,
        name: m.id,
        provider: 'groq',
        owner: m.owned_by || 'groq',
      }));
    } catch {
      return [];
    }
  }
}
