import { InferenceProvider, ModelDescriptor } from './interface.js';
import { InferenceOptions, ProviderConfig } from '../config/types.js';
import { logger } from '../utils/logger.js';
import { streamCompletion } from './sse.js';
import { getModelTags } from './model-catalog.js';

const DEFAULT_NIM_BASE_URL = 'https://integrate.api.nvidia.com/v1';

interface NIMResponse {
  choices: Array<{
    message: { content: string };
  }>;
}

/**
 * NVIDIA NIM Adapter
 * Connects to NVIDIA NIM OpenAI-compatible API
 */
export class NIMAdapter implements InferenceProvider {
  readonly name = 'NVIDIA NIM';
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  async generate(prompt: string, options?: InferenceOptions): Promise<string> {
    const apiKey = this.config.apiKey;
    if (!apiKey) {
      throw new Error('NVIDIA NIM API key is not configured. Set NVIDIA_NIM_API_KEY env var.');
    }

    const model = options?.model || this.config.model || 'meta/llama-3.1-8b-instruct';
    const temperature = options?.temperature ?? this.config.temperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? this.config.maxTokens ?? 4096;

    logger.debug(`NIM: Generating with model=${model}, temperature=${temperature}, maxTokens=${maxTokens}`);

    const baseUrl = this.config.baseUrl || DEFAULT_NIM_BASE_URL;
    const url = `${baseUrl}/chat/completions`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
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
      throw new Error(`NVIDIA NIM API error (${response.status}): ${errorBody}`);
    }

    const data = (await response.json()) as NIMResponse;
    return data.choices[0]?.message?.content || '';
  }

  async generateStream(
    prompt: string,
    options: InferenceOptions | undefined,
    onToken: (token: string) => void,
  ): Promise<string> {
    const apiKey = this.config.apiKey;
    if (!apiKey) {
      throw new Error('NVIDIA NIM API key is not configured. Set NVIDIA_NIM_API_KEY env var.');
    }

    const model = options?.model || this.config.model || 'meta/llama-3.1-8b-instruct';
    const temperature = options?.temperature ?? this.config.temperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? this.config.maxTokens ?? 4096;

    logger.debug(`NIM: Streaming with model=${model}, temperature=${temperature}, maxTokens=${maxTokens}`);

    const baseUrl = this.config.baseUrl || DEFAULT_NIM_BASE_URL;

    return streamCompletion(
      `${baseUrl}/chat/completions`,
      { 'Authorization': `Bearer ${apiKey}` },
      { model, messages: [{ role: 'user', content: prompt }], temperature, max_tokens: maxTokens },
      onToken,
    );
  }

  async isAvailable(): Promise<boolean> {
    return !!this.config.apiKey;
  }

  getInfo(): string {
    return `Provider: NVIDIA NIM\nModel: ${this.config.model || 'default'}\nStatus: ${this.config.apiKey ? '✅ Configured' : '❌ Missing API key'}`;
  }

  async listModels(): Promise<ModelDescriptor[]> {
    const apiKey = this.config.apiKey;
    if (!apiKey) return [];

    const baseUrl = this.config.baseUrl || DEFAULT_NIM_BASE_URL;
    try {
      const response = await fetch(`${baseUrl}/models`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });
      if (!response.ok) return [];
      const data = (await response.json()) as { data: Array<{ id: string; owned_by?: string }> };
      return (data.data || []).map((m: { id: string; owned_by?: string }) => ({
        id: m.id,
        name: m.id.split('/').pop() || m.id,
        provider: 'nim',
        owner: m.owned_by || 'nvidia',
        tags: getModelTags(m.id, m.owned_by),
      }));
    } catch {
      return [];
    }
  }
}
