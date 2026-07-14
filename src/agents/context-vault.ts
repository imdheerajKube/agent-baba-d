/**
 * ContextVault — The shared in-memory context bus for inter-agent communication.
 *
 * All agents read from and write to this vault. The orchestrator creates one
 * per execution session and passes references to every agent.
 *
 * This is deliberately a simple class wrapping a plain object so that
 * it can be serialized/deserialized in Phase 2 (persistent memory).
 */

import type { AgentContext, TaskStep, Artifact, AgentMessage, FileChange } from './agent.js';

/** Default empty context */
function createEmptyContext(goal: string, workingDirectory: string): AgentContext {
  return {
    goal,
    workingDirectory,
    taskPlan: [],
    artifacts: [],
    conversations: [],
    fileChanges: [],
    metadata: {},
  };
}

/**
 * Shared, mutable context bus for a single orchestration session.
 */
export class ContextVault {
  /** The underlying shared context */
  readonly context: AgentContext;

  constructor(goal: string, workingDirectory: string) {
    this.context = createEmptyContext(goal, workingDirectory);
  }

  // ─── Task Plan ──────────────────────────────────────────────────────────

  /** Replace the full task plan */
  setTaskPlan(steps: TaskStep[]): void {
    this.context.taskPlan = steps;
  }

  /** Update status for a single task step */
  updateTaskStatus(taskId: string, status: TaskStep['status'], result?: string): void {
    const step = this.context.taskPlan.find((s) => s.id === taskId);
    if (step) {
      step.status = status;
      if (result !== undefined) {
        step.result = result;
      }
    }
  }

  /** Get pending tasks whose dependencies are all completed */
  getRunnableTasks(): TaskStep[] {
    return this.context.taskPlan.filter((step) => {
      if (step.status !== 'pending') return false;
      return step.dependsOn.every((depId) => {
        const dep = this.context.taskPlan.find((s) => s.id === depId);
        return dep?.status === 'completed';
      });
    });
  }

  /** Check if all tasks are completed or failed */
  get isComplete(): boolean {
    return this.context.taskPlan.every((s) => s.status === 'completed' || s.status === 'failed');
  }

  /** Check if any task has failed */
  get hasFailedTasks(): boolean {
    return this.context.taskPlan.some((s) => s.status === 'failed');
  }

  // ─── Artifacts ──────────────────────────────────────────────────────────

  /** Add one or more file artifacts */
  addArtifacts(artifacts: Artifact[]): void {
    this.context.artifacts.push(...artifacts);
  }

  /** Get all artifacts (optionally filtered by path match) */
  getArtifacts(pathPattern?: string): Artifact[] {
    if (!pathPattern) return [...this.context.artifacts];
    return this.context.artifacts.filter((a) => a.path.includes(pathPattern));
  }

  // ─── Conversations ──────────────────────────────────────────────────────

  /** Log an agent-to-agent message */
  addMessage(from: string, to: string, content: string): void {
    this.context.conversations.push({
      from,
      to,
      content,
      timestamp: Date.now(),
    });
  }

  /** Get conversation history formatted for LLM context */
  getConversationLog(): string {
    return this.context.conversations
      .map((m) => `[${m.from} → ${m.to}]: ${m.content}`)
      .join('\n');
  }

  // ─── File Changes ───────────────────────────────────────────────────────

  /** Record a file change */
  addFileChange(change: FileChange): void {
    // Replace existing entry for same path if present
    const existing = this.context.fileChanges.findIndex((c) => c.path === change.path);
    if (existing >= 0) {
      this.context.fileChanges[existing] = change;
    } else {
      this.context.fileChanges.push(change);
    }
  }

  /** Get all file changes */
  getFileChanges(): FileChange[] {
    return [...this.context.fileChanges];
  }

  /** Get a formatted diff summary for display */
  getDiffSummary(): string {
    if (this.context.fileChanges.length === 0) return 'No files changed.';
    return this.context.fileChanges
      .map((c) => {
        const icon = c.status === 'created' ? '📄' : c.status === 'deleted' ? '🗑️' : '✏️';
        return `  ${icon} ${c.path} (${c.status})`;
      })
      .join('\n');
  }

  // ─── Metadata ───────────────────────────────────────────────────────────

  /** Store a metadata value */
  setMeta(key: string, value: unknown): void {
    this.context.metadata[key] = value;
  }

  /** Retrieve a metadata value */
  getMeta<T = unknown>(key: string): T | undefined {
    return this.context.metadata[key] as T | undefined;
  }

  // ─── Snapshot ───────────────────────────────────────────────────────────

  /** Get a serialisable snapshot (handy for logging / Phase 2 persistence) */
  snapshot(): AgentContext {
    return structuredClone(this.context);
  }
}
