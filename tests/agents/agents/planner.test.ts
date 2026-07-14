import { describe, it, expect } from 'vitest';
import { PlannerAgent } from '../../../src/agents/agents/planner.js';

describe('PlannerAgent', () => {
  let planner: PlannerAgent;

  beforeEach(() => {
    planner = new PlannerAgent();
  });

  describe('parsePlan (private method access via prototype)', () => {
    const parse = (response: string) =>
      (planner as any).parsePlan.call(planner, response);

    // ─── Direct JSON ────────────────────────────────────────────────────

    it('should parse direct JSON array', () => {
      const json = JSON.stringify([
        { id: 'step-1', description: 'Gather context', agentType: 'context-gatherer', dependsOn: [] },
        { id: 'step-2', description: 'Write code', agentType: 'writer', dependsOn: ['step-1'] },
      ]);

      const result = parse(json);
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('step-1');
      expect(result[1].dependsOn).toEqual(['step-1']);
    });

    it('should parse JSON with numeric IDs', () => {
      const json = JSON.stringify([
        { id: 1, description: 'First step', agentType: 'context-gatherer', dependsOn: [] },
      ]);

      const result = parse(json);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(1); // Raw parse — normalization happens in execute() 
    });

    it('should parse JSON with null dependsOn', () => {
      const json = JSON.stringify([
        { id: 'step-1', description: 'First', agentType: 'writer', dependsOn: null },
      ]);

      const result = parse(json);
      expect(result).toHaveLength(1);
      expect(result[0].dependsOn).toBeNull(); // Raw parse preserves null
    });

    it('should parse JSON with empty array', () => {
      const result = parse('[]');
      expect(result).toEqual([]);
    });

    // ─── Code Block JSON ────────────────────────────────────────────────

    it('should parse JSON from ```json code block', () => {
      const response = 'Some text\n\n```json\n[\n  { "id": "step-1", "description": "Gather", "agentType": "context-gatherer", "dependsOn": [] }\n]\n```\n\nMore text';

      const result = parse(response);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('step-1');
    });

    it('should parse JSON from ``` code block without language', () => {
      const response = '```\n[{"id": "s1", "description": "Desc", "agentType": "writer", "dependsOn": []}]\n```';

      const result = parse(response);
      expect(result).toHaveLength(1);
      expect(result[0].description).toBe('Desc');
    });

    // ─── Fallback Array ─────────────────────────────────────────────────

    it('should find JSON array anywhere in the response', () => {
      const response = 'Here is the plan:\n[{"id":"s1","description":"Do thing","agentType":"writer","dependsOn":[]}]\nThat is all.';

      const result = parse(response);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('s1');
    });

    // ─── Edge Cases ─────────────────────────────────────────────────────

    it('should return empty array for completely invalid response', () => {
      const result = parse('This is not JSON at all. No arrays here.');
      expect(result).toEqual([]);
    });

    it('should return empty array for non-array JSON', () => {
      const result = parse('{"key": "value"}');
      expect(result).toEqual([]);
    });

    it('should return empty array for empty string', () => {
      const result = parse('');
      expect(result).toEqual([]);
    });

    it('should return empty array for whitespace-only string', () => {
      const result = parse('   \n\n   ');
      expect(result).toEqual([]);
    });

    it('should return empty array for single-quoted invalid JSON', () => {
      // Some LLMs return single quotes instead of double quotes, which JSON.parse rejects.
      // The fallback strategies should still return an empty array (not throw).
      const response = "[{id: 's1', description: 'Desc', agentType: 'writer', dependsOn: []}]";
      const result = parse(response);
      expect(result).toEqual([]);
    });
  });

  describe('execute response normalization (via test agent behavior)', () => {
    it('should normalize numeric IDs to strings', async () => {
      const context = {
        goal: 'test goal',
        workingDirectory: '/test',
        taskPlan: [],
        artifacts: [],
        conversations: [],
        fileChanges: [],
        metadata: {},
      } as any;

      // Mock LLM to return JSON with numeric id and null dependsOn
      const mockLLM = async () => JSON.stringify([
        { id: 1, description: 'Step one', agentType: 'context-gatherer', dependsOn: null },
      ]);

      const result = await planner.execute(context, mockLLM as any);

      expect(result.success).toBe(true);
      // After normalization in execute(), the plan should have string IDs and empty dependsOn
      expect(context.taskPlan).toHaveLength(1);
      expect(context.taskPlan[0].id).toBe('1'); // Numeric normalized to string
      expect(context.taskPlan[0].dependsOn).toEqual([]); // null normalized to []
    });

    it('should normalize single string dependsOn to array', async () => {
      const context = {
        goal: 'test',
        workingDirectory: '/test',
        taskPlan: [],
        artifacts: [],
        conversations: [],
        fileChanges: [],
        metadata: {},
      } as any;

      const mockLLM = async () => JSON.stringify([
        { id: 's1', description: 'Do', agentType: 'writer', dependsOn: 'parent-step' },
      ]);

      const result = await planner.execute(context, mockLLM as any);
      expect(result.success).toBe(true);
      expect(context.taskPlan[0].dependsOn).toEqual(['parent-step']);
    });

    it('should filter out steps missing required fields', async () => {
      const context = {
        goal: 'test',
        workingDirectory: '/test',
        taskPlan: [],
        artifacts: [],
        conversations: [],
        fileChanges: [],
        metadata: {},
      } as any;

      const mockLLM = async () => JSON.stringify([
        { description: 'Missing id and agentType' }, // Missing id and agentType
        { id: 'valid', description: 'Valid step', agentType: 'writer', dependsOn: [] },
      ]);

      const result = await planner.execute(context, mockLLM as any);
      expect(result.success).toBe(true);
      expect(context.taskPlan).toHaveLength(1);
      expect(context.taskPlan[0].id).toBe('valid');
    });

    it('should return failure when no valid steps remain after filtering', async () => {
      const context = {
        goal: 'test',
        workingDirectory: '/test',
        taskPlan: [],
        artifacts: [],
        conversations: [],
        fileChanges: [],
        metadata: {},
      } as any;

      const mockLLM = async () => '["invalid", "data"]';

      const result = await planner.execute(context, mockLLM as any);
      expect(result.success).toBe(false);
      expect(result.summary).toContain('empty or invalid');
      expect(context.taskPlan).toHaveLength(0);
    });

    it('should handle LLM throwing an error', async () => {
      const context = {
        goal: 'test',
        workingDirectory: '/test',
        taskPlan: [],
        artifacts: [],
        conversations: [],
        fileChanges: [],
        metadata: {},
      } as any;

      const mockLLM = async () => { throw new Error('API timeout'); };

      const result = await planner.execute(context, mockLLM as any);
      expect(result.success).toBe(false);
      expect(result.error).toContain('API timeout');
    });

    it('should include memory context when present in metadata', async () => {
      const context = {
        goal: 'test',
        workingDirectory: '/test',
        taskPlan: [],
        artifacts: [],
        conversations: [],
        fileChanges: [],
        metadata: { memoryContext: '## Similar Past Task\nGoal: similar task\nPlan:\n[{"id":"prev","description":"Previous","agentType":"writer","dependsOn":[]}]\n' },
      } as any;

      let capturedPrompt = '';
      const mockLLM = async (prompt: string) => {
        capturedPrompt = prompt;
        return JSON.stringify([
          { id: 's1', description: 'New step', agentType: 'writer', dependsOn: [] },
        ]);
      };

      await planner.execute(context, mockLLM as any);
      expect(capturedPrompt).toContain('Similar Past Task');
      expect(capturedPrompt).toContain('senior software architect');
    });
  });

  describe('metadata', () => {
    it('should have correct name and description', () => {
      expect(planner.name).toBe('Planner');
      expect(planner.description).toContain('execution plans');
    });
  });
});
