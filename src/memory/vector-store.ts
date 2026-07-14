/**
 * VectorStore — A lightweight, JSON-based vector index with cosine similarity search.
 *
 * Stores embeddings as `{ id, vector, metadata }` entries in a single JSON file.
 * No external dependencies — uses only Node.js built-in fs and crypto.
 *
 * File location: ~/.buff/memory/vectors.json
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ─── Types ──────────────────────────────────────────────────────────────────

/** A single entry in the vector index */
export interface VectorEntry {
  /** Unique identifier for this entry */
  id: string;
  /** The embedding vector (array of numbers) */
  vector: number[];
  /** Arbitrary metadata for filtering/display */
  metadata: Record<string, unknown>;
  /** Timestamp when this entry was created */
  createdAt: number;
}

/** The on-disk format of the vector index */
interface VectorIndexData {
  entries: Record<string, VectorEntry>;
  version: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const MEMORY_DIR = join(homedir(), '.buff', 'memory');
const INDEX_PATH = join(MEMORY_DIR, 'vectors.json');
const CURRENT_VERSION = 1;

// ─── Helpers ────────────────────────────────────────────────────────────────

function ensureDir(): void {
  if (!existsSync(MEMORY_DIR)) {
    mkdirSync(MEMORY_DIR, { recursive: true });
  }
}

function readIndex(): VectorIndexData {
  try {
    ensureDir();
    if (!existsSync(INDEX_PATH)) {
      return { entries: {}, version: CURRENT_VERSION };
    }
    const raw = readFileSync(INDEX_PATH, 'utf-8');
    return JSON.parse(raw) as VectorIndexData;
  } catch {
    return { entries: {}, version: CURRENT_VERSION };
  }
}

function writeIndex(data: VectorIndexData): void {
  ensureDir();
  writeFileSync(INDEX_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

// ─── Vector Math ────────────────────────────────────────────────────────────

/** Compute the dot product of two vectors */
function dotProduct(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

/** Compute the L2 norm (magnitude) of a vector */
function magnitude(v: number[]): number {
  let sum = 0;
  for (const val of v) {
    sum += val * val;
  }
  return Math.sqrt(sum);
}

/**
 * Compute cosine similarity between two vectors.
 * Returns a value between -1 and 1 (higher = more similar).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  const dot = dotProduct(a, b);
  const magA = magnitude(a);
  const magB = magnitude(b);
  if (magA === 0 || magB === 0) return 0;
  return dot / (magA * magB);
}

// ─── VectorStore ────────────────────────────────────────────────────────────

/**
 * Lightweight vector store for semantic search.
 *
 * Usage:
 * ```ts
 * const store = new VectorStore();
 * await store.insert("traj-001", [0.1, 0.2, ...], { goal: "add auth" });
 * const results = await store.search([0.15, 0.25, ...], 3);
 * ```
 */
export class VectorStore {
  /**
   * Insert a vector entry into the index.
   * If an entry with the same `id` already exists, it is overwritten.
   */
  async insert(id: string, vector: number[], metadata: Record<string, unknown> = {}): Promise<void> {
    const data = readIndex();
    data.entries[id] = {
      id,
      vector,
      metadata,
      createdAt: Date.now(),
    };
    writeIndex(data);
  }

  /**
   * Retrieve a single entry by ID.
   */
  async get(id: string): Promise<VectorEntry | null> {
    const data = readIndex();
    return data.entries[id] || null;
  }

  /**
   * Remove an entry from the index.
   */
  async delete(id: string): Promise<boolean> {
    const data = readIndex();
    if (!data.entries[id]) return false;
    delete data.entries[id];
    writeIndex(data);
    return true;
  }

  /**
   * Search for the top-k most similar entries to the query vector.
   * Returns results sorted by similarity (highest first).
   */
  async search(
    queryVector: number[],
    k: number = 5,
    filterFn?: (entry: VectorEntry) => boolean,
  ): Promise<Array<{ entry: VectorEntry; similarity: number }>> {
    const data = readIndex();
    const entries = Object.values(data.entries);

    // Compute similarities
    const scored: Array<{ entry: VectorEntry; similarity: number }> = [];
    for (const entry of entries) {
      if (filterFn && !filterFn(entry)) continue;
      const sim = cosineSimilarity(queryVector, entry.vector);
      scored.push({ entry, similarity: sim });
    }

    // Sort by similarity descending, take top-k
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, k);
  }

  /**
   * Get the total number of stored entries.
   */
  async count(): Promise<number> {
    const data = readIndex();
    return Object.keys(data.entries).length;
  }

  /**
   * Clear all entries from the index.
   */
  async clear(): Promise<void> {
    writeIndex({ entries: {}, version: CURRENT_VERSION });
  }

  /**
   * Get all entries (for iteration/export).
   */
  async getAll(): Promise<VectorEntry[]> {
    const data = readIndex();
    return Object.values(data.entries);
  }
}

// Singleton instance
let storeInstance: VectorStore | null = null;

export function getVectorStore(): VectorStore {
  if (!storeInstance) {
    storeInstance = new VectorStore();
  }
  return storeInstance;
}
