import { InferenceProvider, ModelDescriptor } from './interface.js';
import { InferenceOptions, ProviderConfig } from '../config/types.js';
import { logger } from '../utils/logger.js';
import { getModelTags } from './model-catalog.js';

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

interface GeminiResponse {
  candidates: Array<{
    content: {
      parts: Array<{ text: string }>;
    };
  }>;
}

/**
 * Google Gemini Adapter (free tier)
 * Connects to Google Gemini API
 */
export class GeminiAdapter implements InferenceProvider {
  readonly name = 'Google Gemini';
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  async generate(prompt: string, options?: InferenceOptions): Promise<string> {
    const apiKey = this.config.apiKey;
    if (!apiKey) {
      throw new Error('Google Gemini API key is not configured. Set GEMINI_API_KEY env var.');
    }

    const model = options?.model || this.config.model || 'gemini-2.0-flash-exp';
    const temperature = options?.temperature ?? this.config.temperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? this.config.maxTokens ?? 8192;

    logger.debug(`Gemini: Generating with model=${model}, temperature=${temperature}, maxTokens=${maxTokens}`);

    const url = `${GEMINI_BASE_URL}/${model}:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature,
          maxOutputTokens: maxTokens,
        },
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Gemini API error (${response.status}): ${errorBody}`);
    }

    const data = (await response.json()) as GeminiResponse;
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  async isAvailable(): Promise<boolean> {
    return !!this.config.apiKey;
  }

  getInfo(): string {
    return `Provider: Google Gemini\nModel: ${this.config.model || 'default'}\nStatus: ${this.config.apiKey ? '✅ Configured' : '❌ Missing API key'}`;
  }

  async listModels(): Promise<ModelDescriptor[]> {
    const apiKey = this.config.apiKey;
    if (!apiKey) return [];

    try {
      const response = await fetch(`${GEMINI_BASE_URL}?key=${apiKey}`);
      if (!response.ok) return [];
      const data = (await response.json()) as { models?: Array<{ name: string; displayName?: string; description?: string }> };
      return (data.models || []).map((m: { name: string; displayName?: string; description?: string }) => {
        const id = m.name.replace('models/', '');
        return {
          id,
          name: m.displayName || id,
          provider: 'gemini',
          description: m.description,
          tags: getModelTags(id),
        };
      });
    } catch {
      return [];
    }
  }
}
