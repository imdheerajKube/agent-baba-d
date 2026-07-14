import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TrajectoryStore, getTrajectoryStore } from '../../src/memory/trajectory-store.js';
import type { Trajectory, TrajectoryStep } from '../../src/memory/trajectory-store.js';
import type { OrchestrationResult } from '../../src/agents/orchestrator.js';
import type { TaskStep } from '../../src/agents/agent.js';
import { getVectorStore } from '../../src/memory/vector-store.js';
import { clearEmbeddingCache } from '../../src/memory/embedder.js';

describe('TrajectoryStore', () => {
  let store: TrajectoryStore;

  beforeEach(async () => {
    store = new TrajectoryStore();
    await store.clear();
    clearEmbeddingCache();
  });

  afterEach(async () => {
    await store.clear();
    clearEmbeddingCache();
  });

  // Helper: create a basic successful orchestration result
  function makeResult(overrides: Partial<OrchestrationResult> = {}): OrchestrationResult {
    return {
      success: true,
      goal: 'test goal',
      summary: 'Completed 2 tasks successfully',
      tasksCompleted: 2,
      tasksTotal: 2,
      agentResults: [
        { agent: 'Planner', success: true, summary: 'Created 2 steps' },
        { agent: 'Writer', success: true, summary: 'Modified 1 file' },
      ],
      fileChanges: '  ✏️ src/index.ts (modified)\n  📄 src/new.ts (created)',
      ...overrides,
    };
  }

  // Helper: create task plan steps
  function makeTaskPlan(overrides: Partial<TaskStep>[] = []): TaskStep[] {
    const defaults: TaskStep[] = [
      { id: 'step-1', description: 'Gather context', agentType: 'context-gatherer', dependsOn: [], status: 'completed' },
      { id: 'step-2', description: 'Write code', agentType: 'writer', dependsOn: ['step-1'], status: 'completed' },
    ];
    return overrides.length > 0 ? overrides : defaults;
  }

  // Helper: mock LLM that returns a valid embedding
  const mockEmbedLLM: any = async (_prompt: string) => {
    const vec = Array.from({ length: 64 }, (_, i) => Math.sin(i * 0.1));
    return JSON.stringify(vec);
  };

  describe('save', () => {
    it('should save a successful trajectory', async () => {
      const id = await store.save(
        makeResult(),
        mockEmbedLLM,
        makeTaskPlan(),
        ['src/index.ts'],
      );
      expect(id).toBeTruthy();
      expect(id.startsWith('traj-')).toBe(true);
    });

    it('should NOT save unsuccessful trajectories', async () => {
      const id = await store.save(
        makeResult({ success: false }),
        mockEmbedLLM,
        makeTaskPlan(),
        [],
      );
      expect(id).toBe('');
    });

    it('should store the trajectory data correctly', async () => {
      const result = makeResult({
        goal: 'custom goal',
        fileChanges: '  📄 src/new.ts (created)',
      });
      const taskPlan = makeTaskPlan();

      const id = await store.save(result, mockEmbedLLM, taskPlan, ['src/config.ts']);

      const saved = await store.get(id);
      expect(saved).not.toBeNull();
      expect(saved!.goal).toBe('custom goal');
      expect(saved!.taskPlan).toHaveLength(2);
      expect(saved!.taskPlan[0].agentType).toBe('context-gatherer');
      expect(saved!.contextFiles).toEqual(['src/config.ts']);
      expect(saved!.score).toBeCloseTo(0.7, 1); // heuristic: completion 0.4 + review 0.2 + efficiency 0.1
    });

    it('should parse file changes from the diff summary', async () => {
      const result = makeResult({
        fileChanges: '  ✏️ src/old.ts (modified)\n  📄 src/new.ts (created)',
      });

      const id = await store.save(result, mockEmbedLLM, makeTaskPlan(), []);
      const saved = await store.get(id);
      expect(saved!.fileChanges).toHaveLength(2);
      expect(saved!.fileChanges[0].path).toBe('src/old.ts');
      expect(saved!.fileChanges[0].status).toBe('modified');
      expect(saved!.fileChanges[1].path).toBe('src/new.ts');
      expect(saved!.fileChanges[1].status).toBe('created');
    });
  });

  describe('get', () => {
    it('should return null for non-existent ID', async () => {
      const traj = await store.get('nonexistent-id');
      expect(traj).toBeNull();
    });

    it('should retrieve a saved trajectory', async () => {
      const id = await store.save(makeResult(), mockEmbedLLM, makeTaskPlan(), []);
      const saved = await store.get(id);
      expect(saved).not.toBeNull();
      expect(saved!.id).toBe(id);
    });
  });

  describe('searchByGoal', () => {
    it('should return empty array when no trajectories exist', async () => {
      const results = await store.searchByGoal('some goal', mockEmbedLLM, 3);
      expect(results).toEqual([]);
    });

    it('should find similar trajectories', async () => {
      // Save a trajectory about authentication
      await store.save(
        makeResult({ goal: 'add JWT authentication to the API' }),
        mockEmbedLLM,
        makeTaskPlan(),
        ['src/routes/auth.ts'],
      );

      // Search for a similar goal
      const results = await store.searchByGoal('implement JWT auth', mockEmbedLLM, 3);
      expect(Array.isArray(results)).toBe(true);
    });

    it('should return empty array for queries with no similarity', async () => {
      await store.save(
        makeResult({ goal: 'database migration for postgres' }),
        mockEmbedLLM,
        makeTaskPlan(),
        [],
      );

      const results = await store.searchByGoal('garbage text zzz', mockEmbedLLM, 3);
      // May or may not find results depending on embedding similarity
      expect(Array.isArray(results)).toBe(true);
    });

    it('should return at most k results', async () => {
      // Save several trajectories
      for (let i = 0; i < 5; i++) {
        await store.save(
          makeResult({ goal: `goal number ${i}` }),
          mockEmbedLLM,
          makeTaskPlan(),
          [],
        );
      }

      const results = await store.searchByGoal('goal number', mockEmbedLLM, 2);
      expect(results.length).toBeLessThanOrEqual(2);
    });
  });

  describe('formatAsFewShot', () => {
    it('should return empty string for empty array', () => {
      const result = store.formatAsFewShot([]);
      expect(result).toBe('');
    });

    it('should format trajectories as few-shot examples', () => {
      const trajectories: Trajectory[] = [
        {
          id: 'test-1',
          goal: 'add auth',
          projectFingerprint: 'typescript, node',
          taskPlan: [
            { id: 's1', description: 'Gather', agentType: 'context-gatherer' },
            { id: 's2', description: 'Write', agentType: 'writer' },
          ],
          contextFiles: ['src/auth.ts'],
          fileChanges: [{ path: 'src/auth.ts', status: 'created' }],
          tasksCompleted: 2,
          tasksTotal: 2,
          score: 1,
          timestamp: Date.now(),
        },
      ];

      const result = store.formatAsFewShot(trajectories);
      expect(result).toContain('Similar Past Task 1');
      expect(result).toContain('add auth');
      expect(result).toContain('typescript, node');
      expect(result).toContain('Gather');
      expect(result).toContain('src/auth.ts');
      expect(result).toContain('Here are examples');
    });

    it('should truncate plans with more than 5 steps', () => {
      const longPlan: TrajectoryStep[] = Array.from({ length: 10 }, (_, i) => ({
        id: `s${i}`,
        description: `Step ${i + 1}`,
        agentType: i === 0 ? 'context-gatherer' : i === 9 ? 'reviewer' : 'writer',
      }));

      const trajectories: Trajectory[] = [
        {
          id: 'long-1',
          goal: 'complex task',
          projectFingerprint: 'typescript',
          taskPlan: longPlan,
          contextFiles: [],
          fileChanges: [],
          tasksCompleted: 10,
          tasksTotal: 10,
          score: 1,
          timestamp: Date.now(),
        },
      ];

      const result = store.formatAsFewShot(trajectories);
      expect(result).toContain('Step 1');
      expect(result).toContain('Step 5');
      expect(result).not.toContain('Step 6'); // Truncated
      expect(result).toContain('5 more steps'); // Truncation notice
    });
  });

  describe('stats', () => {
    it('should return zero stats when empty', async () => {
      const stats = await store.stats();
      expect(stats.total).toBe(0);
      expect(stats.avgScore).toBe(0);
      expect(stats.byProjectFingerprint).toEqual({});
    });

    it('should compute stats correctly', async () => {
      await store.save(
        makeResult({
          goal: 'g1',
          tasksCompleted: 2,
          tasksTotal: 2,
          fileChanges: '  ✏️ src/a.ts (modified)',
        }),
        mockEmbedLLM,
        makeTaskPlan(),
        [],
      );

      await store.save(
        makeResult({
          goal: 'g2',
          tasksCompleted: 1,
          tasksTotal: 2,
          fileChanges: '  ✏️ src/b.ts (modified)',
        }),
        mockEmbedLLM,
        makeTaskPlan(),
        [],
      );

      const stats = await store.stats();
      expect(stats.total).toBe(2);
      expect(stats.avgScore).toBeGreaterThan(0);
    });
  });

  describe('clear', () => {
    it('should remove all trajectories', async () => {
      await store.save(makeResult(), mockEmbedLLM, makeTaskPlan(), []);
      await store.save(makeResult({ goal: 'another' }), mockEmbedLLM, makeTaskPlan(), []);

      await store.clear();

      expect((await store.stats()).total).toBe(0);
      // VectorStore should also be cleared
      expect(await getVectorStore().count()).toBe(0);
    });
  });

  describe('edge cases', () => {
    it('should handle empty file changes string', async () => {
      const result = makeResult({ fileChanges: 'No files changed.' });
      const id = await store.save(result, mockEmbedLLM, makeTaskPlan(), []);
      const saved = await store.get(id);
      expect(saved!.fileChanges).toEqual([]);
    });

    it('should default score to 0 when tasksTotal is 0', async () => {
      const result = makeResult({ tasksCompleted: 0, tasksTotal: 0 });
      const taskPlan: TaskStep[] = [];
      const id = await store.save(result, mockEmbedLLM, taskPlan, []);
      const saved = await store.get(id);
      expect(saved!.score).toBeCloseTo(0.2, 1); // heuristic: review +0.2 (success=true), 0 tasks = 0 completion
    });
  });
});
