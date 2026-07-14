import { describe, it, expect, beforeEach } from 'vitest';
import { ContextVault } from '../../src/agents/context-vault.js';
import type { TaskStep, Artifact, FileChange } from '../../src/agents/agent.js';

describe('ContextVault', () => {
  let vault: ContextVault;

  beforeEach(() => {
    vault = new ContextVault('test goal', '/test/working/dir');
  });

  // ─── Construction ──────────────────────────────────────────────────────

  describe('constructor', () => {
    it('should initialize with given goal and working directory', () => {
      expect(vault.context.goal).toBe('test goal');
      expect(vault.context.workingDirectory).toBe('/test/working/dir');
    });

    it('should start with empty task plan, artifacts, conversations, and file changes', () => {
      expect(vault.context.taskPlan).toEqual([]);
      expect(vault.context.artifacts).toEqual([]);
      expect(vault.context.conversations).toEqual([]);
      expect(vault.context.fileChanges).toEqual([]);
      expect(vault.context.metadata).toEqual({});
    });

    it('should be complete when no tasks exist (nothing to do)', () => {
      // An empty task plan means everything is complete
      expect(vault.isComplete).toBe(true);
      expect(vault.hasFailedTasks).toBe(false);
    });
  });

  // ─── Task Plan Management ──────────────────────────────────────────────

  describe('setTaskPlan', () => {
    it('should replace the full task plan', () => {
      const steps: TaskStep[] = [
        { id: 'step-1', description: 'First step', agentType: 'planner', dependsOn: [], status: 'pending' },
        { id: 'step-2', description: 'Second step', agentType: 'writer', dependsOn: ['step-1'], status: 'pending' },
      ];
      vault.setTaskPlan(steps);
      expect(vault.context.taskPlan).toEqual(steps);
      expect(vault.context.taskPlan).toHaveLength(2);
    });

    it('should overwrite any existing plan', () => {
      vault.setTaskPlan([
        { id: 'old', description: 'Old step', agentType: 'planner', dependsOn: [], status: 'pending' },
      ]);
      vault.setTaskPlan([
        { id: 'new', description: 'New step', agentType: 'writer', dependsOn: [], status: 'pending' },
      ]);
      expect(vault.context.taskPlan).toHaveLength(1);
      expect(vault.context.taskPlan[0].id).toBe('new');
    });
  });

  describe('updateTaskStatus', () => {
    beforeEach(() => {
      vault.setTaskPlan([
        { id: 'step-1', description: 'First', agentType: 'gatherer', dependsOn: [], status: 'pending' },
        { id: 'step-2', description: 'Second', agentType: 'writer', dependsOn: ['step-1'], status: 'pending' },
        { id: 'step-3', description: 'Third', agentType: 'reviewer', dependsOn: ['step-2'], status: 'pending' },
      ]);
    });

    it('should update the status of an existing task', () => {
      vault.updateTaskStatus('step-1', 'completed');
      expect(vault.context.taskPlan[0].status).toBe('completed');
    });

    it('should update the result message when provided', () => {
      vault.updateTaskStatus('step-1', 'completed', 'Done successfully');
      expect(vault.context.taskPlan[0].result).toBe('Done successfully');
    });

    it('should not change the result when not provided', () => {
      vault.updateTaskStatus('step-1', 'completed');
      expect(vault.context.taskPlan[0].result).toBeUndefined();
    });

    it('should do nothing for a non-existent task ID', () => {
      vault.updateTaskStatus('nonexistent', 'completed');
      expect(vault.context.taskPlan[0].status).toBe('pending');
      expect(vault.context.taskPlan[1].status).toBe('pending');
    });
  });

  describe('getRunnableTasks', () => {
    beforeEach(() => {
      vault.setTaskPlan([
        { id: 'step-1', description: 'Gather', agentType: 'gatherer', dependsOn: [], status: 'pending' },
        { id: 'step-2', description: 'Write A', agentType: 'writer', dependsOn: ['step-1'], status: 'pending' },
        { id: 'step-3', description: 'Write B', agentType: 'writer', dependsOn: ['step-1'], status: 'pending' },
        { id: 'step-4', description: 'Review', agentType: 'reviewer', dependsOn: ['step-2', 'step-3'], status: 'pending' },
      ]);
    });

    it('should return tasks with no dependencies initially', () => {
      const runnable = vault.getRunnableTasks();
      expect(runnable).toHaveLength(1);
      expect(runnable[0].id).toBe('step-1');
    });

    it('should return tasks whose dependencies are all completed', () => {
      vault.updateTaskStatus('step-1', 'completed');
      const runnable = vault.getRunnableTasks();
      expect(runnable).toHaveLength(2);
      expect(runnable.map((t) => t.id)).toEqual(['step-2', 'step-3']);
    });

    it('should not return tasks with incomplete dependencies', () => {
      vault.updateTaskStatus('step-1', 'completed');
      vault.updateTaskStatus('step-2', 'completed');
      const runnable = vault.getRunnableTasks();
      // step-3's dependency is completed (step-1), but step-4 needs step-3
      expect(runnable).toHaveLength(1);
      expect(runnable[0].id).toBe('step-3');
    });

    it('should not return tasks with failed dependencies', () => {
      vault.updateTaskStatus('step-1', 'failed');
      const runnable = vault.getRunnableTasks();
      expect(runnable).toHaveLength(0);
    });

    it('should return empty array when all tasks are completed', () => {
      vault.updateTaskStatus('step-1', 'completed');
      vault.updateTaskStatus('step-2', 'completed');
      vault.updateTaskStatus('step-3', 'completed');
      vault.updateTaskStatus('step-4', 'completed');
      expect(vault.getRunnableTasks()).toHaveLength(0);
    });

    it('should handle tasks with multiple dependencies', () => {
      vault.updateTaskStatus('step-1', 'completed');
      vault.updateTaskStatus('step-2', 'completed');
      vault.updateTaskStatus('step-3', 'completed');
      const runnable = vault.getRunnableTasks();
      expect(runnable).toHaveLength(1);
      expect(runnable[0].id).toBe('step-4');
    });

    it('should not return tasks already running or completed', () => {
      vault.updateTaskStatus('step-1', 'completed');
      vault.updateTaskStatus('step-2', 'running');
      const runnable = vault.getRunnableTasks();
      // step-3 is pending and depends on step-1 (completed), so it's runnable
      // step-2 is running, so not runnable
      expect(runnable).toHaveLength(1);
      expect(runnable[0].id).toBe('step-3');
    });
  });

  describe('isComplete', () => {
    it('should be true when all tasks are completed', () => {
      vault.setTaskPlan([
        { id: 'a', description: 'A', agentType: 'gatherer', dependsOn: [], status: 'completed' },
        { id: 'b', description: 'B', agentType: 'writer', dependsOn: ['a'], status: 'completed' },
      ]);
      expect(vault.isComplete).toBe(true);
    });

    it('should be true when tasks are completed or failed', () => {
      vault.setTaskPlan([
        { id: 'a', description: 'A', agentType: 'gatherer', dependsOn: [], status: 'completed' },
        { id: 'b', description: 'B', agentType: 'writer', dependsOn: ['a'], status: 'failed' },
      ]);
      expect(vault.isComplete).toBe(true);
    });

    it('should be false when tasks are pending', () => {
      vault.setTaskPlan([
        { id: 'a', description: 'A', agentType: 'gatherer', dependsOn: [], status: 'pending' },
      ]);
      expect(vault.isComplete).toBe(false);
    });

    it('should be false when tasks are running', () => {
      vault.setTaskPlan([
        { id: 'a', description: 'A', agentType: 'gatherer', dependsOn: [], status: 'running' },
      ]);
      expect(vault.isComplete).toBe(false);
    });

    it('should be true when there are no tasks', () => {
      expect(vault.isComplete).toBe(true);
    });
  });

  describe('hasFailedTasks', () => {
    it('should be true when at least one task failed', () => {
      vault.setTaskPlan([
        { id: 'a', description: 'A', agentType: 'gatherer', dependsOn: [], status: 'failed' },
      ]);
      expect(vault.hasFailedTasks).toBe(true);
    });

    it('should be false when no tasks failed', () => {
      vault.setTaskPlan([
        { id: 'a', description: 'A', agentType: 'gatherer', dependsOn: [], status: 'completed' },
        { id: 'b', description: 'B', agentType: 'writer', dependsOn: ['a'], status: 'completed' },
      ]);
      expect(vault.hasFailedTasks).toBe(false);
    });

    it('should be false when there are no tasks', () => {
      expect(vault.hasFailedTasks).toBe(false);
    });
  });

  // ─── Artifacts ─────────────────────────────────────────────────────────

  describe('addArtifacts / getArtifacts', () => {
    it('should store artifacts', () => {
      const artifacts: Artifact[] = [
        { path: 'src/index.ts', content: 'export const x = 1;', description: 'Main file' },
        { path: 'src/utils.ts', content: 'export const y = 2;', description: 'Utils file' },
      ];
      vault.addArtifacts(artifacts);
      expect(vault.context.artifacts).toHaveLength(2);
      expect(vault.context.artifacts[0].path).toBe('src/index.ts');
    });

    it('should return all artifacts when no pattern given', () => {
      vault.addArtifacts([
        { path: 'a.ts', content: 'a', description: 'A' },
        { path: 'b.ts', content: 'b', description: 'B' },
      ]);
      const all = vault.getArtifacts();
      expect(all).toHaveLength(2);
    });

    it('should filter artifacts by path pattern', () => {
      vault.addArtifacts([
        { path: 'src/index.ts', content: 'a', description: 'A' },
        { path: 'src/utils.ts', content: 'b', description: 'B' },
        { path: 'tests/index.test.ts', content: 'c', description: 'C' },
      ]);
      const filtered = vault.getArtifacts('index');
      expect(filtered).toHaveLength(2);
      expect(filtered.map((a) => a.path)).toEqual(['src/index.ts', 'tests/index.test.ts']);
    });

    it('should return copy of artifacts array', () => {
      vault.addArtifacts([{ path: 'a.ts', content: 'a', description: 'A' }]);
      const got = vault.getArtifacts();
      got.push({ path: 'b.ts', content: 'b', description: 'B' });
      expect(vault.context.artifacts).toHaveLength(1);
    });
  });

  // ─── Conversations ─────────────────────────────────────────────────────

  describe('addMessage / getConversationLog', () => {
    it('should log a message with timestamp', () => {
      vault.addMessage('Planner', 'Orchestrator', 'Plan created');
      expect(vault.context.conversations).toHaveLength(1);
      expect(vault.context.conversations[0].from).toBe('Planner');
      expect(vault.context.conversations[0].to).toBe('Orchestrator');
      expect(vault.context.conversations[0].content).toBe('Plan created');
      expect(vault.context.conversations[0].timestamp).toBeGreaterThan(0);
    });

    it('should format conversation log', () => {
      vault.addMessage('Planner', 'Orchestrator', 'Plan created');
      vault.addMessage('Writer', 'Reviewer', 'File changed');
      const log = vault.getConversationLog();
      expect(log).toContain('[Planner → Orchestrator]: Plan created');
      expect(log).toContain('[Writer → Reviewer]: File changed');
    });

    it('should return empty string for no messages', () => {
      expect(vault.getConversationLog()).toBe('');
    });
  });

  // ─── File Changes ──────────────────────────────────────────────────────

  describe('addFileChange / getFileChanges / getDiffSummary', () => {
    it('should store a created file change', () => {
      const change: FileChange = {
        path: 'src/new-file.ts',
        newContent: 'export const x = 1;',
        status: 'created',
      };
      vault.addFileChange(change);
      expect(vault.context.fileChanges).toHaveLength(1);
    });

    it('should replace existing change for the same path', () => {
      vault.addFileChange({ path: 'same.ts', newContent: 'v1', status: 'created' });
      vault.addFileChange({ path: 'same.ts', newContent: 'v2', status: 'modified', originalContent: 'v1' });
      expect(vault.context.fileChanges).toHaveLength(1);
      expect(vault.context.fileChanges[0].newContent).toBe('v2');
      expect(vault.context.fileChanges[0].status).toBe('modified');
    });

    it('should return copy of file changes array', () => {
      vault.addFileChange({ path: 'a.ts', newContent: 'a', status: 'created' });
      const changes = vault.getFileChanges();
      changes.push({ path: 'b.ts', newContent: 'b', status: 'created' });
      expect(vault.context.fileChanges).toHaveLength(1);
    });

    it('should produce diff summary with icons', () => {
      vault.addFileChange({ path: 'new.ts', newContent: 'code', status: 'created' });
      vault.addFileChange({ path: 'old.ts', originalContent: 'old', newContent: 'new', status: 'modified' });
      const summary = vault.getDiffSummary();
      expect(summary).toContain('📄');
      expect(summary).toContain('new.ts');
      expect(summary).toContain('✏️');
      expect(summary).toContain('old.ts');
    });

    it('should return default message when no changes', () => {
      expect(vault.getDiffSummary()).toBe('No files changed.');
    });
  });

  // ─── Metadata ──────────────────────────────────────────────────────────

  describe('setMeta / getMeta', () => {
    it('should store and retrieve metadata', () => {
      vault.setMeta('key1', 'value1');
      vault.setMeta('key2', 42);
      expect(vault.getMeta<string>('key1')).toBe('value1');
      expect(vault.getMeta<number>('key2')).toBe(42);
    });

    it('should return undefined for non-existent keys', () => {
      expect(vault.getMeta('nonexistent')).toBeUndefined();
    });

    it('should overwrite existing key', () => {
      vault.setMeta('key', 'old');
      vault.setMeta('key', 'new');
      expect(vault.getMeta('key')).toBe('new');
    });
  });

  // ─── Snapshot ──────────────────────────────────────────────────────────

  describe('snapshot', () => {
    it('should return a deep clone of the context', () => {
      vault.setTaskPlan([
        { id: 's1', description: 'Step 1', agentType: 'gatherer', dependsOn: [], status: 'pending' },
      ]);
      vault.addArtifacts([{ path: 'f.ts', content: 'code', description: 'File' }]);

      const snap = vault.snapshot();
      expect(snap.goal).toBe('test goal');
      expect(snap.taskPlan).toHaveLength(1);
      expect(snap.artifacts).toHaveLength(1);

      // Verify it's a deep clone — mutations shouldn't affect original
      snap.taskPlan[0].status = 'completed';
      expect(vault.context.taskPlan[0].status).toBe('pending');
    });
  });
});
