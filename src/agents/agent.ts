/**
 * Agent interfaces and abstract base class for the multi-agent orchestration system.
 *
 * Each agent is a specialized unit that performs a specific role in the pipeline
 * (planning, context gathering, writing, reviewing, etc.). Agents communicate
 * through a shared {@link AgentContext} bus managed by the Orchestrator.
 */

import type { InferenceOptions } from '../config/types.js';

// ─── Shared Types ───────────────────────────────────────────────────────────

/** Status of a single task step within the execution plan */
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed';

/** A single step in the ordered execution plan produced by the PlannerAgent */
export interface TaskStep {
  id: string;
  description: string;
  agentType: string;
  dependsOn: string[];
  status: TaskStatus;
  result?: string;
}

/** A file artifact discovered or produced during agent execution */
export interface Artifact {
  path: string;
  content: string;
  description: string;
}

/** A message exchanged between agents via the context bus */
export interface AgentMessage {
  from: string;
  to: string;
  content: string;
  timestamp: number;
}

/** A file change proposed or applied by an agent */
export interface FileChange {
  path: string;
  originalContent?: string;
  newContent?: string;
  status: 'created' | 'modified' | 'deleted';
}

/**
 * The shared context bus that all agents read from and write to.
 * This is the single source of truth for inter-agent communication.
 */
export interface AgentContext {
  /** The original user goal / task description */
  goal: string;

  /** Absolute path to the working directory (project root) */
  workingDirectory: string;

  /** Ordered task plan produced by PlannerAgent */
  taskPlan: TaskStep[];

  /** File artifacts discovered (context) or produced (output) */
  artifacts: Artifact[];

  /** Agent-to-agent conversation log */
  conversations: AgentMessage[];

  /** File changes proposed by WriterAgent */
  fileChanges: FileChange[];

  /** Arbitrary metadata for extensibility */
  metadata: Record<string, unknown>;
}

/** The result returned by an agent after execution */
export interface AgentResult {
  success: boolean;
  summary: string;
  details?: string;
  error?: string;
}

/**
 * Callback type that agents use to invoke the LLM.
 * The orchestrator injects this so it can control provider/model per agent.
 */
export type LLMCallFn = (
  prompt: string,
  options?: InferenceOptions,
) => Promise<string>;

// ─── Abstract Agent ─────────────────────────────────────────────────────────

/**
 * Base class for all specialized agents.
 *
 * To create a new agent:
 * 1. Extend this class
 * 2. Set `name` and `description`
 * 3. Implement `execute(context, callLLM)`
 */
export abstract class Agent {
  /** Human-readable agent name (e.g. "Planner", "Writer") */
  abstract readonly name: string;

  /** Short description of what this agent does */
  abstract readonly description: string;

  /**
   * Execute the agent's specialized task.
   *
   * @param context  Shared context bus — read inputs, write outputs
   * @param callLLM  Function to call the LLM with a prompt
   * @returns        Result indicating success/failure + summary
   */
  abstract execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult>;
}
