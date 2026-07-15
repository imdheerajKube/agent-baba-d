import { InferenceProvider, ModelDescriptor } from './interface.js';
import { InferenceOptions, ProviderConfig } from '../config/types.js';
import { logger } from '../utils/logger.js';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { getModelTags } from './model-catalog.js';

const OLLAMA_API_BASE = 'http://localhost:11434';

interface OllamaGenerateResponse {
  response: string;
  done: boolean;
}

/**
 * Local Model Adapter
 * Supports Ollama, Hugging Face Transformers, and GGML models
 */
export class LocalAdapter implements InferenceProvider {
  readonly name = 'Local';
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  async generate(prompt: string, options?: InferenceOptions): Promise<string> {
    const runner = this.config.runner || 'ollama';

    switch (runner) {
      case 'ollama':
        return this.generateOllama(prompt, options);
      case 'huggingface':
        return this.generateHuggingFace(prompt, options);
      case 'ggml':
        return this.generateGGML(prompt, options);
      default:
        throw new Error(`Unknown local runner: ${runner}. Supported: ollama, huggingface, ggml`);
    }
  }

  /**
   * Generate using Ollama HTTP API
   */
  private async generateOllama(prompt: string, options?: InferenceOptions): Promise<string> {
    const model = options?.model || this.config.model || 'llama2';
    const temperature = options?.temperature ?? this.config.temperature ?? 0.7;

    logger.debug(`Ollama: Generating with model=${model}, temperature=${temperature}`);

    const response = await fetch(`${OLLAMA_API_BASE}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: {
          temperature,
        },
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Ollama API error (${response.status}): ${errorBody}\n` +
        `Ensure Ollama is running: ollama serve`
      );
    }

    const data = (await response.json()) as OllamaGenerateResponse;
    return data.response || '';
  }

  /**
   * Generate using Hugging Face Transformers (via Python)
   * Requires transformers Python package to be installed
   */
  private async generateHuggingFace(prompt: string, options?: InferenceOptions): Promise<string> {
    const model = options?.model || this.config.model || 'microsoft/phi-2';
    const maxTokens = options?.maxTokens ?? this.config.maxTokens ?? 512;

    logger.debug(`HuggingFace: Generating with model=${model}, maxTokens=${maxTokens}`);

    // Use a Python script for reliability
    const pythonScript = `
import sys, json
try:
    from transformers import AutoModelForCausalLM, AutoTokenizer
    import torch

    model_name = ${JSON.stringify(model)}
    prompt = ${JSON.stringify(prompt)}

    tokenizer = AutoTokenizer.from_pretrained(model_name)
    model = AutoModelForCausalLM.from_pretrained(model_name)

    inputs = tokenizer(prompt, return_tensors="pt")
    with torch.no_grad():
        outputs = model.generate(**inputs, max_new_tokens=${maxTokens})
    result = tokenizer.decode(outputs[0], skip_special_tokens=True)
    # Strip the input prompt from the output
    if result.startswith(prompt):
        result = result[len(prompt):].strip()
    print(json.dumps({"response": result}))
except ImportError:
    print(json.dumps({"error": "transformers package not installed. Run: pip install transformers torch"}))
    sys.exit(1)
except Exception as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(1)
`;

    return new Promise<string>((resolve, reject) => {
      const python = spawn('python3', ['-c', pythonScript], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let output = '';
      let errorOutput = '';

      python.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });

      python.stderr?.on('data', (chunk: Buffer) => {
        errorOutput += chunk.toString();
      });

      python.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new Error('Python 3 is not installed. Install it from https://python.org'));
        } else {
          reject(new Error(`Failed to run Python: ${err.message}`));
        }
      });

      python.on('close', (exitCode) => {
        if (exitCode === 0) {
          try {
            const parsed = JSON.parse(output);
            if (parsed.error) {
              reject(new Error(parsed.error));
            } else {
              resolve(parsed.response || '');
            }
          } catch (parseErr) {
            reject(new Error(`Failed to parse HuggingFace output: ${output}`));
          }
        } else {
          reject(new Error(`Hugging Face inference failed: ${errorOutput || output}`));
        }
      });
    });
  }

  /**
   * Generate using a GGML model binary
   * Expects a path to a GGML-compatible model file or the llama.cpp binary
   */
  private async generateGGML(prompt: string, options?: InferenceOptions): Promise<string> {
    const model = options?.model || this.config.model || './models/llama-2-7b.gguf';
    const maxTokens = options?.maxTokens ?? this.config.maxTokens ?? 512;

    logger.debug(`GGML: Generating with model=${model}, maxTokens=${maxTokens}`);

    // Check if the model file exists
    if (!existsSync(model)) {
      throw new Error(
        `GGML model not found at: ${model}\n` +
        `Download a model or update the path in your config.\n` +
        `You can download models from: https://huggingface.co/TheBloke`
      );
    }

    return new Promise((resolve, reject) => {
      const llamaCpp = spawn('llama-cli', [
        '-m', model,
        '-p', prompt,
        '-n', String(maxTokens),
        '--no-display-prompt',
      ], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let output = '';
      let errorOutput = '';

      llamaCpp.stdout?.on('data', (data: Buffer) => {
        output += data.toString();
      });

      llamaCpp.stderr?.on('data', (data: Buffer) => {
        errorOutput += data.toString();
      });

      llamaCpp.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new Error(
            'llama-cli not found. Install llama.cpp:\n' +
            '  brew install llama.cpp\n' +
            '  # or build from: https://github.com/ggerganov/llama.cpp'
          ));
        } else {
          reject(new Error(`Failed to run GGML model: ${err.message}`));
        }
      });

      llamaCpp.on('close', (code) => {
        if (code === 0) {
          resolve(output.trim().replace(prompt, '').trim());
        } else {
          reject(new Error(`GGML inference exited with code ${code}: ${errorOutput}`));
        }
      });
    });
  }

  async isAvailable(): Promise<boolean> {
    const runner = this.config.runner || 'ollama';

    if (runner === 'ollama') {
      try {
        const response = await fetch(`${OLLAMA_API_BASE}/api/tags`);
        return response.ok;
      } catch {
        return false;
      }
    }

    // For huggingface/ggml, check at generation time
    return true;
  }

  getInfo(): string {
    const runner = this.config.runner || 'ollama';
    return `Provider: Local (${runner})\nModel: ${this.config.model || 'default'}\nStatus: ✅ Always available`;
  }

  async listModels(): Promise<ModelDescriptor[]> {
    const runner = this.config.runner || 'ollama';

    if (runner === 'ollama') {
      try {
        const response = await fetch(`${OLLAMA_API_BASE}/api/tags`);
        if (!response.ok) return [];
        const data = (await response.json()) as { models?: Array<{ name: string }> };
        return (data.models || []).map((m: { name: string }) => ({
          id: m.name,
          name: m.name,
          provider: 'local',
          tags: getModelTags(m.name),
        }));
      } catch {
        return [];
      }
    }

    return [];
  }
}
