/**
 * Embedder — Generates vector embeddings from text using an LLM.
 *
 * Since we don't have a dedicated embedding model, we use the existing
 * InferenceProvider to ask the LLM to produce a "semantic fingerprint"
 * as a JSON array of numbers. This serves as a lightweight embedding
 * for similarity search in the VectorStore.
 *
 * The embedder caches results to avoid regenerating embeddings for
 * identical inputs, and to reduce API costs.
 */

import { createHash } from 'node:crypto';

import type { LLMCallFn } from '../agents/agent.js';
import { logger } from '../utils/logger.js';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Dimensionality of the generated embeddings */
export const EMBEDDING_DIM = 64;

/** System prompt for the embedding model */
const EMBEDDING_PROMPT = `You are a semantic embedding generator. Given a piece of text, generate a dense vector representation that captures its semantic meaning.

Return ONLY a valid JSON array of ${EMBEDDING_DIM} floating-point numbers between -1 and 1.
No markdown, no explanations, no code blocks — just the raw JSON array.

The vector should encode:
- The main topic and domain (e.g., "authentication", "database", "CLI tool")
- The action being requested (e.g., "add", "fix", "refactor", "create")
- The technology stack or language if mentioned
- Key entities and concepts

Example output: [0.12, -0.45, 0.78, 0.03, -0.22, ...]`;

// ─── In-Memory Cache ────────────────────────────────────────────────────────

/** Simple LRU cache for embeddings to avoid redundant LLM calls */
class EmbeddingCache {
  private cache = new Map<string, number[]>();
  private maxSize: number;

  constructor(maxSize = 100) {
    this.maxSize = maxSize;
  }

  get(key: string): number[] | undefined {
    // LRU: move to end on access
    const value = this.cache.get(key);
    if (value !== undefined) {
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: string, value: number[]): void {
    if (this.cache.size >= this.maxSize) {
      // Delete the least recently used (first) entry
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, value);
  }

  get size(): number {
    return this.cache.size;
  }

  clear(): void {
    this.cache.clear();
  }
}

const cache = new EmbeddingCache();

// ─── Embedder ───────────────────────────────────────────────────────────────

/**
 * Generate a cache key for a piece of text.
 */
function cacheKey(text: string): string {
  return createHash('md5').update(text.toLowerCase().trim()).digest('hex');
}

/**
 * Generate a vector embedding for the given text using an LLM.
 *
 * @param text     The text to embed (e.g., a user goal or task description)
 * @param callLLM  The LLM call function (from Orchestrator)
 * @returns        A promise that resolves to a number[] embedding vector
 */
export async function embed(
  text: string,
  callLLM: LLMCallFn,
): Promise<number[]> {
  const key = cacheKey(text);

  // Check cache first
  const cached = cache.get(key);
  if (cached) return cached;

  // Generate embedding via LLM
  const prompt = `${EMBEDDING_PROMPT}\n\nText to embed:\n${text.slice(0, 500)}`;

  let response: string;
  try {
    response = await callLLM(prompt, {
      temperature: 0.1, // Low temperature for deterministic output
      maxTokens: 1024,
    });
  } catch (err) {
    logger.debug(`Embedding generation failed: ${err}`);
    // Fallback: return a zero vector (will result in no meaningful matches)
    return new Array(EMBEDDING_DIM).fill(0);
  }

  const vector = parseEmbedding(response);

  // Cache the result
  cache.set(key, vector);

  return vector;
}

/**
 * Parse an embedding vector from the LLM's text response.
 * Tries multiple strategies to extract a valid array of numbers.
 */
function parseEmbedding(response: string): number[] {
  const trimmed = response.trim();

  // Strategy 1: Direct JSON parse
  try {
    const parsed = JSON.parse(trimmed);
    if (isValidEmbedding(parsed)) return parsed;
  } catch {
    // Fall through
  }

  // Strategy 2: Extract from ```json code block
  const jsonMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1].trim());
      if (isValidEmbedding(parsed)) return parsed;
    } catch {
      // Fall through
    }
  }

  // Strategy 3: Find array pattern in text
  const arrayMatch = trimmed.match(/\[[\s\S]*?\]/);
  if (arrayMatch) {
    try {
      const parsed = JSON.parse(arrayMatch[0]);
      if (isValidEmbedding(parsed)) return parsed;
    } catch {
      // Fall through
    }
  }

  // Fallback: return zero vector (no meaningful match)
  logger.debug('Could not parse embedding from LLM response, using zero vector');
  return new Array(EMBEDDING_DIM).fill(0);
}

/**
 * Validate that a parsed value is a valid embedding vector.
 */
function isValidEmbedding(value: unknown): value is number[] {
  if (!Array.isArray(value)) return false;
  if (value.length !== EMBEDDING_DIM) return false;
  return value.every((v) => typeof v === 'number' && isFinite(v));
}

/**
 * Clear the in-memory embedding cache.
 */
export function clearEmbeddingCache(): void {
  cache.clear();
}

/**
 * Get the current size of the embedding cache.
 */
export function embeddingCacheSize(): number {
  return cache.size;
}
