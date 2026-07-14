import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { embed, clearEmbeddingCache, embeddingCacheSize, EMBEDDING_DIM } from '../../src/memory/embedder.js';

describe('EMBEDDING_DIM', () => {
  it('should be 64 dimensions', () => {
    expect(EMBEDDING_DIM).toBe(64);
  });
});

describe('embed', () => {
  beforeEach(() => {
    clearEmbeddingCache();
  });

  afterEach(() => {
    clearEmbeddingCache();
  });

  // ─── Direct JSON Array ────────────────────────────────────────────────

  it('should parse direct JSON array response from LLM', async () => {
    const mockLLM = async () => {
      const vec = Array.from({ length: EMBEDDING_DIM }, (_, i) => Math.sin(i) / 2);
      return JSON.stringify(vec);
    };

    const result = await embed('test text', mockLLM as any);
    expect(result).toHaveLength(EMBEDDING_DIM);
    expect(result.every((v) => typeof v === 'number')).toBe(true);
  });

  // ─── Code Block JSON ──────────────────────────────────────────────────

  it('should parse embedding from ```json code block', async () => {
    const mockLLM = async () => {
      const vec = Array.from({ length: EMBEDDING_DIM }, () => 0.5);
      return `Here is the embedding:\n\`\`\`json\n${JSON.stringify(vec)}\n\`\`\`\n`;
    };

    const result = await embed('test', mockLLM as any);
    expect(result).toHaveLength(EMBEDDING_DIM);
    expect(result.every((v) => v === 0.5)).toBe(true);
  });

  it('should parse from ``` code block without language tag', async () => {
    const mockLLM = async () => {
      const vec = Array.from({ length: EMBEDDING_DIM }, () => 0.25);
      return `\`\`\`\n${JSON.stringify(vec)}\n\`\`\``;
    };

    const result = await embed('test', mockLLM as any);
    expect(result).toHaveLength(EMBEDDING_DIM);
    expect(result.every((v) => v === 0.25)).toBe(true);
  });

  // ─── Array Pattern Fallback ───────────────────────────────────────────

  it('should find JSON array embedded in text', async () => {
    const mockLLM = async () => {
      const vec = Array.from({ length: EMBEDDING_DIM }, () => 0.75);
      return `The embedding vector is ${JSON.stringify(vec)} which represents the semantic meaning.`;
    };

    const result = await embed('test', mockLLM as any);
    expect(result).toHaveLength(EMBEDDING_DIM);
    expect(result.every((v) => v === 0.75)).toBe(true);
  });

  // ─── Validation ───────────────────────────────────────────────────────

  it('should reject array with wrong dimension and fall back', async () => {
    const mockLLM = async () => JSON.stringify([0.1, 0.2, 0.3]); // Only 3 dimensions

    const result = await embed('test', mockLLM as any);
    // Should fall back to zero vector since 3 != 64
    expect(result).toHaveLength(EMBEDDING_DIM);
    expect(result.every((v) => v === 0)).toBe(true);
  });

  it('should reject non-array response and fall back to zero vector', async () => {
    const mockLLM = async () => 'This is not JSON at all.';

    const result = await embed('test', mockLLM as any);
    expect(result).toHaveLength(EMBEDDING_DIM);
    expect(result.every((v) => v === 0)).toBe(true);
  });

  it('should reject NaN or Infinity values', async () => {
    const mockLLM = async () => {
      const vec = Array.from({ length: EMBEDDING_DIM }, () => NaN);
      return JSON.stringify(vec);
    };

    const result = await embed('test', mockLLM as any);
    expect(result).toHaveLength(EMBEDDING_DIM);
    expect(result.every((v) => v === 0)).toBe(true);
  });

  // ─── LLM Errors ──────────────────────────────────────────────────────

  it('should return zero vector when LLM throws', async () => {
    const mockLLM = async () => { throw new Error('API error'); };

    const result = await embed('test text', mockLLM as any);
    expect(result).toHaveLength(EMBEDDING_DIM);
    expect(result.every((v) => v === 0)).toBe(true);
  });

  // ─── Caching ──────────────────────────────────────────────────────────

  it('should cache results keyed by lowercase text', async () => {
    let callCount = 0;
    const mockLLM = async (prompt: string) => {
      callCount++;
      const vec = Array.from({ length: EMBEDDING_DIM }, () => 0.42);
      return JSON.stringify(vec);
    };

    const result1 = await embed('Hello World', mockLLM as any);
    const result2 = await embed('hello world', mockLLM as any); // Same text, different case

    expect(result1).toEqual(result2);
    expect(callCount).toBe(1); // Should only call LLM once
  });

  it('should call LLM for different inputs', async () => {
    let callCount = 0;
    const mockLLM = async (prompt: string) => {
      callCount++;
      return JSON.stringify(Array.from({ length: EMBEDDING_DIM }, () => 0.5));
    };

    await embed('first text', mockLLM as any);
    await embed('second text', mockLLM as any);

    expect(callCount).toBe(2);
  });

  it('should return cached result from cache', async () => {
    let callCount = 0;
    const mockLLM = async () => {
      callCount++;
      return JSON.stringify(Array.from({ length: EMBEDDING_DIM }, () => 0.5));
    };

    await embed('cache me', mockLLM as any);
    await embed('cache me', mockLLM as any); // Should hit cache
    await embed('cache me', mockLLM as any); // Should hit cache

    expect(callCount).toBe(1);
  });

  // ─── Cache Clearing ──────────────────────────────────────────────────

  it('should clear the cache when clearEmbeddingCache is called', async () => {
    let callCount = 0;
    const mockLLM = async () => {
      callCount++;
      return JSON.stringify(Array.from({ length: EMBEDDING_DIM }, () => 0.5));
    };

    await embed('clearable', mockLLM as any);
    clearEmbeddingCache();
    await embed('clearable', mockLLM as any);

    expect(callCount).toBe(2);
  });

  it('should return 0 for embeddingCacheSize after clearing', () => {
    clearEmbeddingCache();
    expect(embeddingCacheSize()).toBe(0);
  });

  it('should track cache size correctly', async () => {
    clearEmbeddingCache();
    expect(embeddingCacheSize()).toBe(0);

    const mockLLM = async () =>
      JSON.stringify(Array.from({ length: EMBEDDING_DIM }, () => 0.5));

    await embed('text-a', mockLLM as any);
    expect(embeddingCacheSize()).toBe(1);

    await embed('text-b', mockLLM as any);
    expect(embeddingCacheSize()).toBe(2);

    clearEmbeddingCache();
    expect(embeddingCacheSize()).toBe(0);
  });

  // ─── Consecutive Parse Formats ────────────────────────────────────────

  it('should try strategies in order: direct, code block, array', async () => {
    // A response that fails direct JSON parsing but works as a code block
    const mockLLM = async () => {
      const vec = Array.from({ length: EMBEDDING_DIM }, () => 0.33);
      return `\`\`\`json\n${JSON.stringify(vec)}\n\`\`\``;
    };

    const result = await embed('test', mockLLM as any);
    expect(result).toHaveLength(EMBEDDING_DIM);
    expect(result[0]).toBeCloseTo(0.33, 2);
  });
});
