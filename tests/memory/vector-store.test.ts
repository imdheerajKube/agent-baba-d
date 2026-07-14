import { describe, it, expect, beforeEach } from 'vitest';
import { VectorStore, cosineSimilarity } from '../../src/memory/vector-store.js';
import type { VectorEntry } from '../../src/memory/vector-store.js';

describe('cosineSimilarity', () => {
  it('should return 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 5);
    expect(cosineSimilarity([0.5, 0.5], [0.5, 0.5])).toBeCloseTo(1, 5);
  });

  it('should return 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 5);
  });

  it('should return -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 5);
  });

  it('should return a value between 0 and 1 for similar vectors', () => {
    const sim = cosineSimilarity([1, 0, 0], [0.9, 0.1, 0]);
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
  });

  it('should return 0 for different-length vectors', () => {
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
  });

  it('should return 0 when a vector has zero magnitude', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 0, 0])).toBe(0);
    expect(cosineSimilarity([1, 0, 0], [0, 0, 0])).toBe(0);
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });

  it('should return higher similarity for more similar vectors', () => {
    const sim1 = cosineSimilarity([1, 0, 0], [0.9, 0.1, 0]);
    const sim2 = cosineSimilarity([1, 0, 0], [0.1, 0.9, 0]);
    expect(sim1).toBeGreaterThan(sim2);
  });
});

describe('VectorStore', () => {
  let store: VectorStore;

  beforeEach(async () => {
    store = new VectorStore();
    await store.clear(); // Start fresh
  });

  describe('insert and get', () => {
    it('should insert and retrieve a vector entry', async () => {
      await store.insert('test-1', [1, 0, 0], { label: 'auth goal' });

      const entry = await store.get('test-1');
      expect(entry).not.toBeNull();
      expect(entry!.id).toBe('test-1');
      expect(entry!.vector).toEqual([1, 0, 0]);
      expect(entry!.metadata).toEqual({ label: 'auth goal' });
      expect(entry!.createdAt).toBeGreaterThan(0);
    });

    it('should overwrite an existing entry with the same ID', async () => {
      await store.insert('dup', [1, 0, 0], { version: 1 });
      await store.insert('dup', [0, 1, 0], { version: 2 });

      const entry = await store.get('dup');
      expect(entry!.vector).toEqual([0, 1, 0]);
      expect(entry!.metadata).toEqual({ version: 2 });
    });

    it('should insert without metadata', async () => {
      await store.insert('no-meta', [1, 0, 0]);
      const entry = await store.get('no-meta');
      expect(entry).not.toBeNull();
      expect(entry!.metadata).toEqual({});
    });

    it('should return null for non-existent entry', async () => {
      const entry = await store.get('nonexistent');
      expect(entry).toBeNull();
    });
  });

  describe('delete', () => {
    it('should delete an existing entry', async () => {
      await store.insert('delete-me', [1, 0, 0]);
      const deleted = await store.delete('delete-me');
      expect(deleted).toBe(true);
      expect(await store.get('delete-me')).toBeNull();
    });

    it('should return false when deleting non-existent entry', async () => {
      const deleted = await store.delete('no-exist');
      expect(deleted).toBe(false);
    });
  });

  describe('count', () => {
    it('should return 0 for empty store', async () => {
      expect(await store.count()).toBe(0);
    });

    it('should return the number of entries', async () => {
      await store.insert('a', [1, 0, 0]);
      await store.insert('b', [0, 1, 0]);
      await store.insert('c', [0, 0, 1]);
      expect(await store.count()).toBe(3);
    });
  });

  describe('search', () => {
    beforeEach(async () => {
      // Insert several vectors with known orientations
      await store.insert('along-x', [1, 0, 0], { label: 'x-axis' });
      await store.insert('along-y', [0, 1, 0], { label: 'y-axis' });
      await store.insert('along-z', [0, 0, 1], { label: 'z-axis' });
      await store.insert('near-x', [0.9, 0.1, 0], { label: 'near-x' });
    });

    it('should return top-k most similar entries', async () => {
      const results = await store.search([1, 0, 0], 2);
      expect(results).toHaveLength(2);
      // Most similar to [1,0,0] should be along-x and near-x
      expect(results[0].entry.id).toBe('along-x');
      expect(results[1].entry.id).toBe('near-x');
    });

    it('should return results sorted by similarity descending', async () => {
      const results = await store.search([1, 0, 0], 4);
      expect(results[0].similarity).toBeGreaterThanOrEqual(results[1].similarity);
      expect(results[1].similarity).toBeGreaterThanOrEqual(results[2].similarity);
      expect(results[2].similarity).toBeGreaterThanOrEqual(results[3].similarity);
    });

    it('should default to top 5 results', async () => {
      const results = await store.search([1, 0, 0]);
      expect(results.length).toBeLessThanOrEqual(5);
    });

    it('should apply filter function when provided', async () => {
      // Filter to only include entries with label containing 'y'
      const results = await store.search([1, 0, 0], 5, (entry) => {
        return (entry.metadata.label as string || '').includes('y');
      });
      expect(results).toHaveLength(1);
      expect(results[0].entry.id).toBe('along-y');
    });

    it('should return empty array for empty store', async () => {
      await store.clear();
      const results = await store.search([1, 0, 0]);
      expect(results).toEqual([]);
    });

    it('should return zero-similarity for zero query vector', async () => {
      const results = await store.search([0, 0, 0], 4);
      // cosineSimilarity returns 0 when either vector has zero magnitude
      expect(results.every((r) => r.similarity === 0)).toBe(true);
    });
  });

  describe('getAll', () => {
    it('should return empty array for empty store', async () => {
      expect(await store.getAll()).toEqual([]);
    });

    it('should return all entries', async () => {
      await store.insert('a', [1, 0, 0], { n: 1 });
      await store.insert('b', [0, 1, 0], { n: 2 });
      const all = await store.getAll();
      expect(all).toHaveLength(2);
      expect(all.map((e) => e.id)).toEqual(['a', 'b']);
    });
  });

  describe('clear', () => {
    it('should remove all entries', async () => {
      await store.insert('a', [1, 0, 0]);
      await store.insert('b', [0, 1, 0]);
      await store.clear();
      expect(await store.count()).toBe(0);
      expect(await store.get('a')).toBeNull();
    });
  });
});
