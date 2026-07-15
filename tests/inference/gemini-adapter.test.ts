import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GeminiAdapter } from '../../src/inference/gemini-adapter.js';

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('GeminiAdapter', () => {
  const baseConfig = {
    apiKey: 'test-gemini-key',
    model: 'gemini-2.0-flash-exp',
    temperature: 0.3,
    maxTokens: 4096,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor and name', () => {
    it('should have the correct name', () => {
      const adapter = new GeminiAdapter(baseConfig);
      expect(adapter.name).toBe('Google Gemini');
    });
  });

  describe('generate', () => {
    it('should successfully generate a response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [{
            content: { parts: [{ text: 'Hello! How can I help you?' }] },
          }],
        }),
      });

      const adapter = new GeminiAdapter(baseConfig);
      const result = await adapter.generate('Hi there');

      expect(result).toBe('Hello! How can I help you?');
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Verify the request URL includes the API key
      const callUrl = mockFetch.mock.calls[0][0];
      expect(callUrl).toContain('generativelanguage.googleapis.com/v1beta/models');
      expect(callUrl).toContain('gemini-2.0-flash-exp:generateContent');
      expect(callUrl).toContain('key=test-gemini-key');

      // Verify request body
      const callOptions = mockFetch.mock.calls[0][1];
      const body = JSON.parse(callOptions.body);
      expect(body.contents[0].parts[0].text).toBe('Hi there');
      expect(body.generationConfig.temperature).toBe(0.3);
      expect(body.generationConfig.maxOutputTokens).toBe(4096);
    });

    it('should throw when API key is missing', async () => {
      const adapter = new GeminiAdapter({});
      await expect(adapter.generate('test')).rejects.toThrow(
        'Google Gemini API key is not configured'
      );
    });

    it('should throw on API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => 'API key expired',
      });

      const adapter = new GeminiAdapter(baseConfig);
      await expect(adapter.generate('test')).rejects.toThrow('Gemini API error (403): API key expired');
    });

    it('should use options over config when provided', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: 'ok' }] } }],
        }),
      });

      const adapter = new GeminiAdapter(baseConfig);
      await adapter.generate('test', { model: 'gemini-pro', temperature: 1.0, maxTokens: 8192 });

      const callUrl = mockFetch.mock.calls[0][0];
      expect(callUrl).toContain('gemini-pro:generateContent');

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.generationConfig.temperature).toBe(1.0);
      expect(body.generationConfig.maxOutputTokens).toBe(8192);
    });

    it('should handle empty response candidates', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ candidates: [] }),
      });

      const adapter = new GeminiAdapter(baseConfig);
      const result = await adapter.generate('test');
      expect(result).toBe('');
    });

    it('should handle missing parts in response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [] } }],
        }),
      });

      const adapter = new GeminiAdapter(baseConfig);
      const result = await adapter.generate('test');
      expect(result).toBe('');
    });
  });

  describe('isAvailable', () => {
    it('should return true when API key is set', async () => {
      const adapter = new GeminiAdapter(baseConfig);
      expect(await adapter.isAvailable()).toBe(true);
    });

    it('should return false when API key is missing', async () => {
      const adapter = new GeminiAdapter({});
      expect(await adapter.isAvailable()).toBe(false);
    });
  });

  describe('listModels', () => {
    it('should return models from the API', async () => {
      const sampleModels = {
        models: [
          { name: 'models/gemini-2.0-flash-exp', displayName: 'Gemini 2.0 Flash', description: 'Fast multimodal' },
          { name: 'models/gemini-pro', displayName: 'Gemini Pro', description: 'General purpose' },
          { name: 'models/gemma-2-2b-it', displayName: 'Gemma 2', description: 'Lightweight' },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => sampleModels,
      });

      const adapter = new GeminiAdapter({ apiKey: 'test-key' });
      const models = await adapter.listModels();

      expect(models).toHaveLength(3);
      expect(models[0]).toEqual({
        id: 'gemini-2.0-flash-exp',
        name: 'Gemini 2.0 Flash',
        provider: 'gemini',
        description: 'Fast multimodal',
        tags: expect.arrayContaining([expect.any(String)]),
      });
      expect(models[1]).toEqual({
        id: 'gemini-pro',
        name: 'Gemini Pro',
        provider: 'gemini',
        description: 'General purpose',
        tags: expect.arrayContaining([expect.any(String)]),
      });
      expect(models[2]).toEqual({
        id: 'gemma-2-2b-it',
        name: 'Gemma 2',
        provider: 'gemini',
        description: 'Lightweight',
        tags: expect.arrayContaining([expect.any(String)]),
      });

      // Verify the URL includes the API key
      const callUrl = mockFetch.mock.calls[0][0];
      expect(callUrl).toContain('generativelanguage.googleapis.com/v1beta/models');
      expect(callUrl).toContain('key=test-key');
    });

    it('should use displayName when available, fall back to cleaned name', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [
            { name: 'models/no-display', description: '' },
          ],
        }),
      });

      const adapter = new GeminiAdapter({ apiKey: 'test-key' });
      const models = await adapter.listModels();

      expect(models[0].id).toBe('no-display');
      expect(models[0].name).toBe('no-display');
    });

    it('should return empty array when API key is missing', async () => {
      const adapter = new GeminiAdapter({});
      const models = await adapter.listModels();
      expect(models).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should return empty array on API error', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });

      const adapter = new GeminiAdapter({ apiKey: 'test-key' });
      const models = await adapter.listModels();
      expect(models).toEqual([]);
    });

    it('should return empty array on network failure', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const adapter = new GeminiAdapter({ apiKey: 'test-key' });
      const models = await adapter.listModels();
      expect(models).toEqual([]);
    });

    it('should handle missing models field', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      const adapter = new GeminiAdapter({ apiKey: 'test-key' });
      const models = await adapter.listModels();
      expect(models).toEqual([]);
    });
  });

  describe('getInfo', () => {
    it('should show configured status', () => {
      const adapter = new GeminiAdapter(baseConfig);
      const info = adapter.getInfo();
      expect(info).toContain('Google Gemini');
      expect(info).toContain('✅ Configured');
    });

    it('should show missing key status', () => {
      const adapter = new GeminiAdapter({});
      const info = adapter.getInfo();
      expect(info).toContain('❌ Missing API key');
    });
  });
});
