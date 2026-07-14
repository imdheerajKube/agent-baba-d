/**
 * Memory Integration Tests — Tests the full memory cycle end-to-end:
 *
 *   storeExecutionTrajectory → embed → VectorStore.insert → searchByGoal → embed → VectorStore.search → formatAsFewShot
 *
 * Uses a deterministic mock LLM so that:
 * 1. Stored trajectories always get the SAME embedding vector
 * 2. Search queries produce the SAME embedding vector
 * 3. Cosine similarity = 1.0 → semantic search actually returns results (unlike existing unit tests
 *    that only check Array.isArray on potentially empty results)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getVectorStore, cosineSimilarity } from '../../src/memory/vector-store.js';
import { getTrajectoryStore } from '../../src/memory/trajectory-store.js';
import { embed, clearEmbeddingCache, EMBEDDING_DIM } from '../../src/memory/embedder.js';
import { storeExecutionTrajectory, retrieveMemoryContext, clearMemory, getMemoryStats } from '../../src/memory/memory-integration.js';
import type { OrchestrationResult } from '../../src/agents/orchestrator.js';
import type { TaskStep } from '../../src/agents/agent.js';

// ─── Deterministic Mock LLM ──────────────────────────────────────────────
//
// This mock returns a FIXED embedding vector regardless of the prompt.
// This is critical: it ensures that both `storeExecutionTrajectory` (which
// calls embed("Goal: ...\nProject: ...")) and `retrieveMemoryContext` (which
// calls embed("Search query for past agent trajectories: ...")) produce the
// SAME vector. This allows `searchByGoal` to find actual results (cosine
// similarity = 1.0 between stored and queried vectors).

const FIXED_EMBEDDING = Array.from({ length: EMBEDDING_DIM }, (_, i) =>
  i === 0 ? 0.85 : Math.sin(i * 0.5) * 0.3,
);

const mockLLM = async (_prompt: string): Promise<string> => {
  return JSON.stringify(FIXED_EMBEDDING);
};

// ─── Helpers ───────────────────────────────────────────────────────────────

function makeResult(overrides: Partial<OrchestrationResult> = {}): OrchestrationResult {
  return {
    success: true,
    goal: 'add JWT authentication to the API',
    summary: 'Completed 2 tasks successfully',
    tasksCompleted: 2,
    tasksTotal: 2,
    agentResults: [
      { agent: 'Planner', success: true, summary: 'Created 2 steps' },
      { agent: 'Writer', success: true, summary: 'Modified 1 file' },
    ],
    fileChanges: '  📄 src/routes/auth.ts (created)\n  ✏️ src/middleware/jwt.ts (modified)',
    ...overrides,
  };
}

function makeTaskPlan(): TaskStep[] {
  return [
    { id: 'step-1', description: 'Gather context about auth', agentType: 'context-gatherer', dependsOn: [], status: 'completed' },
    { id: 'step-2', description: 'Write JWT middleware', agentType: 'writer', dependsOn: ['step-1'], status: 'completed' },
  ];
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Memory Integration — Full Cycle', () => {
  beforeEach(async () => {
    await clearMemory();
    clearEmbeddingCache();
  });

  afterEach(async () => {
    await clearMemory();
    clearEmbeddingCache();
  });

  // ── Full Cycle: store → search → retrieve → format ────────────────────

  it('should store a trajectory and retrieve it via semantic search', async () => {
    // Step 1: Store
    const id = await storeExecutionTrajectory(
      makeResult(),
      mockLLM,
      makeTaskPlan(),
      ['src/routes/auth.ts', 'src/middleware/jwt.ts'],
      false,
    );
    expect(id).toBeTruthy();
    expect(id.startsWith('traj-')).toBe(true);

    // Step 2: Search for a similar goal
    // The mock LLM returns the SAME fixed vector every time, so similarity = 1.0
    const memoryContext = await retrieveMemoryContext(
      'implement authentication with JWT tokens',
      mockLLM,
      3,
    );

    // Step 3: Verify the trajectory was found
    expect(memoryContext.trajectories).toHaveLength(1);
    expect(memoryContext.trajectories[0].id).toBe(id);

    // Step 4: Verify few-shot formatting
    expect(memoryContext.fewShotContext).toContain('Similar Past Task 1');
    expect(memoryContext.fewShotContext).toContain('add JWT authentication to the API');
    expect(memoryContext.fewShotContext).toContain('src/routes/auth.ts');
    expect(memoryContext.fewShotContext).toContain('Gather context about auth');
  });

  // ── Multiple trajectories, k limit ────────────────────────────────────

  it('should respect the k limit when searching', async () => {
    // Store 3 trajectories with different goals
    const goals = [
      'add JWT authentication to the API',
      'refactor database queries for PostgreSQL',
      'create a new CLI command for user management',
    ];

    for (const goal of goals) {
      await storeExecutionTrajectory(
        makeResult({ goal }),
        mockLLM,
        makeTaskPlan(),
        [],
        false,
      );
    }

    // Search with k=2 → only 2 results (all have same similarity with fixed vector)
    const memoryContext = await retrieveMemoryContext('some goal', mockLLM, 2);
    expect(memoryContext.trajectories).toHaveLength(2);
  });

  it('should return at most k results even with many stored trajectories', async () => {
    // Store 10 trajectories
    for (let i = 0; i < 10; i++) {
      await storeExecutionTrajectory(
        makeResult({ goal: `goal number ${i}` }),
        mockLLM,
        makeTaskPlan(),
        [],
        false,
      );
    }

    const memoryContext = await retrieveMemoryContext('find something', mockLLM, 3);
    expect(memoryContext.trajectories.length).toBeLessThanOrEqual(3);
  });

  // ── Empty store ───────────────────────────────────────────────────────

  it('should return empty results when no trajectories exist', async () => {
    const memoryContext = await retrieveMemoryContext('anything', mockLLM, 3);
    expect(memoryContext.trajectories).toEqual([]);
    expect(memoryContext.fewShotContext).toBe('');
  });

  // ── Failed trajectories not stored ───────────────────────────────────

  it('should NOT store unsuccessful trajectories', async () => {
    const failedResult = makeResult({ success: false });
    const id = await storeExecutionTrajectory(failedResult, mockLLM, makeTaskPlan(), [], false);
    expect(id).toBe('');

    // Search should find nothing
    const memoryContext = await retrieveMemoryContext('anything', mockLLM, 3);
    expect(memoryContext.trajectories).toEqual([]);
  });

  // ── Partial success (some tasks failed) ──────────────────────────────

  it('should store partial-success trajectories (success=false, tasks completed>0)', async () => {
    const partialResult = makeResult({
      success: false,
      tasksCompleted: 1,
      tasksTotal: 2,
    });
    const id = await storeExecutionTrajectory(partialResult, mockLLM, makeTaskPlan(), [], false);
    expect(id).toBe(''); // Not stored because success=false

    // Even though tasks were partially completed, the overall result was failure
    expect(await (await getMemoryStats()).total).toBe(0);
  });

  // ── Memory stats after storing ──────────────────────────────────────

  it('should report accurate stats after storing trajectories', async () => {
    expect((await getMemoryStats()).total).toBe(0);

    await storeExecutionTrajectory(makeResult({ goal: 'g1' }), mockLLM, makeTaskPlan(), [], false);
    let stats = await getMemoryStats();
    expect(stats.total).toBe(1);
    expect(stats.avgScore).toBeGreaterThan(0);

    await storeExecutionTrajectory(makeResult({ goal: 'g2' }), mockLLM, makeTaskPlan(), [], false);
    stats = await getMemoryStats();
    expect(stats.total).toBe(2);
  });

  // ── Vector store consistency ─────────────────────────────────────────

  it('should keep vector store in sync with trajectory store', async () => {
    await storeExecutionTrajectory(makeResult(), mockLLM, makeTaskPlan(), [], false);
    expect(await getVectorStore().count()).toBe(1);

    await storeExecutionTrajectory(makeResult({ goal: 'another' }), mockLLM, makeTaskPlan(), [], false);
    expect(await getVectorStore().count()).toBe(2);

    // Clearing memory clears both stores
    await clearMemory();
    expect(await getVectorStore().count()).toBe(0);
    expect((await getMemoryStats()).total).toBe(0);
  });

  // ── Embedder: parseEmbedding fallback at integration level ───────────

  it('should fall back to zero vector when LLM returns non-JSON', async () => {
    const badLLM = async () => 'This is not a valid JSON embedding response at all';
    const result = await embed('some text', badLLM as any);
    expect(result).toHaveLength(EMBEDDING_DIM);
    expect(result.every((v) => v === 0)).toBe(true);
  });

  it('should fall back to zero vector when LLM returns wrong dimension', async () => {
    const badDimLLM = async () => JSON.stringify([0.1, 0.2, 0.3]); // Only 3 dims
    const result = await embed('some text', badDimLLM as any);
    expect(result).toHaveLength(EMBEDDING_DIM);
    expect(result.every((v) => v === 0)).toBe(true);
  });

  it('should fall back to zero vector when LLM throws', async () => {
    const throwingLLM = async () => { throw new Error('API error'); };
    const result = await embed('some text', throwingLLM as any);
    expect(result).toHaveLength(EMBEDDING_DIM);
    expect(result.every((v) => v === 0)).toBe(true);
  });

  it('should fall back to zero vector when LLM returns NaN values', async () => {
    const nanLLM = async () => JSON.stringify(Array.from({ length: EMBEDDING_DIM }, () => NaN));
    const result = await embed('some text', nanLLM as any);
    expect(result).toHaveLength(EMBEDDING_DIM);
    expect(result.every((v) => v === 0)).toBe(true);
  });

  // ── Embedder: parse strategies at integration level ──────────────────

  it('should parse direct JSON array from LLM response', async () => {
    const vec = Array.from({ length: EMBEDDING_DIM }, (_, i) => Math.sin(i) / 2);
    const directJSON = async () => JSON.stringify(vec);
    const result = await embed('direct json test', directJSON as any);
    expect(result).toHaveLength(EMBEDDING_DIM);
    expect(result[0]).toBeCloseTo(vec[0], 5);
  });

  it('should parse embedding from ```json code block', async () => {
    const vec = Array.from({ length: EMBEDDING_DIM }, () => 0.42);
    const codeBlock = async () => `Here is the vector:\n\`\`\`json\n${JSON.stringify(vec)}\n\`\`\``;
    const result = await embed('code block test', codeBlock as any);
    expect(result).toHaveLength(EMBEDDING_DIM);
    expect(result.every((v) => v === 0.42)).toBe(true);
  });

  it('should parse embedding from bare ``` code block', async () => {
    const vec = Array.from({ length: EMBEDDING_DIM }, () => 0.33);
    const bareBlock = async () => `\`\`\`\n${JSON.stringify(vec)}\n\`\`\``;
    const result = await embed('bare block test', bareBlock as any);
    expect(result).toHaveLength(EMBEDDING_DIM);
    expect(result[0]).toBeCloseTo(0.33, 2);
  });

  it('should find JSON array embedded in natural language text', async () => {
    const vec = Array.from({ length: EMBEDDING_DIM }, () => 0.77);
    const naturalText = async () => `The embedding vector is ${JSON.stringify(vec)} which represents the meaning.`;
    const result = await embed('array in text test', naturalText as any);
    expect(result).toHaveLength(EMBEDDING_DIM);
    expect(result[0]).toBeCloseTo(0.77, 2);
  });

  it('should try strategies in order: direct → code block → array pattern → fallback', async () => {
    // A response that fails all strategies
    const allBad = async () => 'This is completely unparseable as JSON or array 12345';
    const result = await embed('all strategies fail', allBad as any);
    expect(result).toHaveLength(EMBEDDING_DIM);
    expect(result.every((v) => v === 0)).toBe(true);
  });

  // ── Cosine Similarity at integration level ───────────────────────────

  describe('cosineSimilarity integration', () => {
    it('should compute 1.0 for identical vectors', () => {
      expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 5);
    });

    it('should compute 0 for orthogonal vectors', () => {
      expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
    });

    it('should compute -1 for opposite vectors', () => {
      expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 5);
    });

    it('should return 0 for different-length vectors', () => {
      expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
    });

    it('should return 0 when a vector has zero magnitude', () => {
      expect(cosineSimilarity([0, 0, 0], [1, 0, 0])).toBe(0);
      expect(cosineSimilarity([1, 0, 0], [0, 0, 0])).toBe(0);
    });

    it('should order results by similarity descending via VectorStore', async () => {
      const vs = getVectorStore();
      await vs.clear();

      // Insert vectors with decreasing similarity to [1, 0, 0]
      await vs.insert('best-match', [1, 0, 0], { label: 'match' });
      await vs.insert('ok-match', [0.7, 0.3, 0], { label: 'ok' });
      await vs.insert('bad-match', [0.1, 0.9, 0], { label: 'bad' });

      const results = await vs.search([1, 0, 0], 3);

      expect(results).toHaveLength(3);
      expect(results[0].entry.id).toBe('best-match');
      expect(results[1].entry.id).toBe('ok-match');
      expect(results[2].entry.id).toBe('bad-match');
      // Verify similarity ordering
      for (let i = 0; i < results.length - 1; i++) {
        expect(results[i].similarity).toBeGreaterThanOrEqual(results[i + 1].similarity);
      }
    });
  });

  // ── Cache behavior ──────────────────────────────────────────────────

  it('should cache embeddings and reuse them', async () => {
    let callCount = 0;
    const cachingLLM = async () => {
      callCount++;
      return JSON.stringify(FIXED_EMBEDDING);
    };

    const result1 = await embed('cache me please', cachingLLM as any);
    const result2 = await embed('cache me please', cachingLLM as any); // Should hit cache
    const result3 = await embed('CACHE ME PLEASE', cachingLLM as any); // Different case, same normalized text

    expect(result1).toEqual(result2);
    expect(result2).toEqual(result3);
    expect(callCount).toBe(1); // Only one LLM call due to caching
  });

  it('should not reuse cache across different inputs', async () => {
    let callCount = 0;
    const cachingLLM = async () => {
      callCount++;
      return JSON.stringify(FIXED_EMBEDDING);
    };

    await embed('first input', cachingLLM as any);
    await embed('second input', cachingLLM as any);
    await embed('third input', cachingLLM as any);

    expect(callCount).toBe(3);
  });

  it('should clear cache when clearEmbeddingCache is called', async () => {
    let callCount = 0;
    const cachingLLM = async () => {
      callCount++;
      return JSON.stringify(FIXED_EMBEDDING);
    };

    await embed('clearable', cachingLLM as any);
    clearEmbeddingCache();
    await embed('clearable', cachingLLM as any);

    expect(callCount).toBe(2); // Cache was cleared, so second call goes to LLM
  });

  // ── Store then retrieve by trajectory ID ────────────────────────────

  it('should persist trajectory to disk and allow retrieval by ID', async () => {
    const result = makeResult({
      goal: 'unique-test-goal',
      fileChanges: '  📄 src/test.ts (created)',
    });

    const id = await storeExecutionTrajectory(result, mockLLM, makeTaskPlan(), ['src/test.ts'], false);
    expect(id).toBeTruthy();

    // Retrieve directly via TrajectoryStore
    const store = getTrajectoryStore();
    const trajectory = await store.get(id);
    expect(trajectory).not.toBeNull();
    expect(trajectory!.goal).toBe('unique-test-goal');
    expect(trajectory!.fileChanges).toHaveLength(1);
    expect(trajectory!.fileChanges[0].path).toBe('src/test.ts');
    expect(trajectory!.score).toBeCloseTo(0.7, 1); // heuristic: completion 0.4 + review 0.2 + efficiency 0.1
  });

  // ── Ensure searchByGoal actually finds results ──────────────────────

  it('searchByGoal should find trajectories when they exist', async () => {
    // Existing unit tests only check Array.isArray(results), which passes for []
    // This test asserts actual results are found.

    const store = getTrajectoryStore();

    // Store a trajectory
    const id = await store.save(makeResult(), mockLLM, makeTaskPlan(), ['src/auth.ts']);
    expect(id).toBeTruthy();

    // Search with the same mock LLM (returns fixed vector) → should find the trajectory
    const results = await store.searchByGoal('authentication', mockLLM, 5);

    // CRITICAL: We assert results are actually found, not just that it returns an array
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe(id);
    expect(results[0].goal).toContain('JWT');
  });
});
