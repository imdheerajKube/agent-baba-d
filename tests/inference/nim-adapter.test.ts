import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NIMAdapter } from '../../src/inference/nim-adapter.js';

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('NIMAdapter', () => {
  const baseConfig = {
    apiKey: 'test-nim-key',
    model: 'meta/llama-3.1-70b-instruct',
    temperature: 0.5,
    maxTokens: 2048,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor and name', () => {
    it('should have the correct name', () => {
      const adapter = new NIMAdapter(baseConfig);
      expect(adapter.name).toBe('NVIDIA NIM');
    });
  });

  describe('generate', () => {
    it('should successfully generate a response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'This is a test response.' } }],
        }),
      });

      const adapter = new NIMAdapter(baseConfig);
      const result = await adapter.generate('Test prompt');

      expect(result).toBe('This is a test response.');
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Verify the request URL and headers
      const callUrl = mockFetch.mock.calls[0][0];
      expect(callUrl).toContain('integrate.api.nvidia.com/v1/chat/completions');

      const callOptions = mockFetch.mock.calls[0][1];
      expect(callOptions.headers['Authorization']).toBe('Bearer test-nim-key');
      expect(callOptions.headers['Content-Type']).toBe('application/json');

      // Verify request body
      const body = JSON.parse(callOptions.body);
      expect(body.model).toBe('meta/llama-3.1-70b-instruct');
      expect(body.messages[0].content).toBe('Test prompt');
      expect(body.temperature).toBe(0.5);
      expect(body.max_tokens).toBe(2048);
    });

    it('should throw when API key is missing', async () => {
      const adapter = new NIMAdapter({});
      await expect(adapter.generate('test')).rejects.toThrow(
        'NVIDIA NIM API key is not configured'
      );
    });

    it('should throw on API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });

      const adapter = new NIMAdapter(baseConfig);
      await expect(adapter.generate('test')).rejects.toThrow('NVIDIA NIM API error (401): Unauthorized');
    });

    it('should use custom baseUrl when provided', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
      });

      const adapter = new NIMAdapter({ ...baseConfig, baseUrl: 'http://localhost:8000/v1' });
      await adapter.generate('test');

      const callUrl = mockFetch.mock.calls[0][0];
      expect(callUrl).toBe('http://localhost:8000/v1/chat/completions');
    });

    it('should use options over config when provided', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
      });

      const adapter = new NIMAdapter(baseConfig);
      await adapter.generate('test', { model: 'custom-model', temperature: 0.1, maxTokens: 512 });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.model).toBe('custom-model');
      expect(body.temperature).toBe(0.1);
      expect(body.max_tokens).toBe(512);
    });

    it('should handle empty response choices', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [] }),
      });

      const adapter = new NIMAdapter(baseConfig);
      const result = await adapter.generate('test');
      expect(result).toBe('');
    });
  });

  describe('isAvailable', () => {
    it('should return true when API key is set', async () => {
      const adapter = new NIMAdapter(baseConfig);
      expect(await adapter.isAvailable()).toBe(true);
    });

    it('should return false when API key is missing', async () => {
      const adapter = new NIMAdapter({});
      expect(await adapter.isAvailable()).toBe(false);
    });
  });

  describe('listModels', () => {
    it('should return models from the API', async () => {
      const sampleModels = {
        data: [
          { id: 'meta/llama-3.1-8b-instruct', owned_by: 'meta' },
          { id: 'google/gemma-2-2b-it', owned_by: 'google' },
          { id: 'mistralai/mistral-nemo', owned_by: 'mistral' },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => sampleModels,
      });

      const adapter = new NIMAdapter({ apiKey: 'test-key', baseUrl: 'https://example.com/v1' });
      const models = await adapter.listModels();

      expect(models).toHaveLength(3);
      expect(models[0]).toEqual({ id: 'meta/llama-3.1-8b-instruct', name: 'llama-3.1-8b-instruct', provider: 'nim', owner: 'meta', tags: expect.arrayContaining([expect.any(String)]) });
      expect(models[1]).toEqual({ id: 'google/gemma-2-2b-it', name: 'gemma-2-2b-it', provider: 'nim', owner: 'google', tags: expect.arrayContaining([expect.any(String)]) });
      expect(models[2]).toEqual({ id: 'mistralai/mistral-nemo', name: 'mistral-nemo', provider: 'nim', owner: 'mistral', tags: expect.arrayContaining([expect.any(String)]) });

      expect(mockFetch).toHaveBeenCalledWith('https://example.com/v1/models', {
        headers: { 'Authorization': 'Bearer test-key' },
      });
    });

    it('should return empty array when API key is missing', async () => {
      const adapter = new NIMAdapter({});
      const models = await adapter.listModels();
      expect(models).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should return empty array on API error', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      const adapter = new NIMAdapter({ apiKey: 'test-key' });
      const models = await adapter.listModels();
      expect(models).toEqual([]);
    });

    it('should return empty array on network failure', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const adapter = new NIMAdapter({ apiKey: 'test-key' });
      const models = await adapter.listModels();
      expect(models).toEqual([]);
    });

    it('should handle empty data response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [] }),
      });

      const adapter = new NIMAdapter({ apiKey: 'test-key' });
      const models = await adapter.listModels();
      expect(models).toEqual([]);
    });

    it('should handle missing data field', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      const adapter = new NIMAdapter({ apiKey: 'test-key' });
      const models = await adapter.listModels();
      expect(models).toEqual([]);
    });
  });

  describe('getInfo', () => {
    it('should show configured status when key is present', () => {
      const adapter = new NIMAdapter(baseConfig);
      const info = adapter.getInfo();
      expect(info).toContain('NVIDIA NIM');
      expect(info).toContain('meta/llama-3.1-70b-instruct');
      expect(info).toContain('✅ Configured');
    });

    it('should show missing key status when key is absent', () => {
      const adapter = new NIMAdapter({ model: 'test-model' });
      const info = adapter.getInfo();
      expect(info).toContain('❌ Missing API key');
    });
  });
});
