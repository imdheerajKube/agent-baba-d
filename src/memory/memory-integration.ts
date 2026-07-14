/**
 * MemoryIntegration — Connects the persistent memory system to the Orchestrator.
 *
 * This module provides the glue between agent execution and memory:
 * - Before planning: retrieves similar past trajectories as few-shot examples
 * - After execution: stores the successful trajectory for future use
 *
 * The Orchestrator calls these hooks when the `useMemory` option is enabled.
 */

import type { TaskStep } from '../agents/agent.js';
import type { LLMCallFn } from '../agents/agent.js';
import type { OrchestrationResult } from '../agents/orchestrator.js';
import { getTrajectoryStore } from './trajectory-store.js';
import type { Trajectory } from './trajectory-store.js';
import { getPatternStore } from '../learning/pattern-extractor.js';
import { logger } from '../utils/logger.js';

/**
 * Retrieve relevant past trajectories to use as few-shot examples
 * for the PlannerAgent.
 *
 * @param goal     The current user goal
 * @param callLLM  LLM function for embedding generation
 * @param k        Maximum number of trajectories to retrieve
 * @returns        An object with:
 *   - trajectories: the raw trajectory objects
 *   - fewShotContext: formatted string for injection into planner prompts
 */
export async function retrieveMemoryContext(
  goal: string,
  callLLM: LLMCallFn,
  k: number = 3,
): Promise<{
  trajectories: Trajectory[];
  fewShotContext: string;
  patternContext: string;
}> {
  const store = getTrajectoryStore();
  const trajectories = await store.searchByGoal(goal, callLLM, k);
  const fewShotContext = store.formatAsFewShot(trajectories);

  // Also retrieve relevant coding patterns
  let patternContext = '';
  try {
    const patternStore = getPatternStore();
    // Use the first trajectory's project fingerprint for domain matching
    const domainTags = trajectories.length > 0
      ? trajectories[0].projectFingerprint.split(',').map((s) => s.trim())
      : [];
    patternContext = patternStore.formatAsPrompt(domainTags);
  } catch {
    // Non-critical — patterns are optional
  }

  return { trajectories, fewShotContext, patternContext: patternContext || '' };
}

/**
 * Store a successful orchestration result as a trajectory for future use.
 * This is called at the end of the orchestration pipeline.
 *
 * @param result         The orchestration result
 * @param callLLM        LLM function for embedding generation
 * @param taskPlan       The task plan that was executed
 * @param contextFiles   The files that were gathered as context
 * @param verbose        Whether to log details
 * @returns              The trajectory ID, or empty string if not saved
 */
export async function storeExecutionTrajectory(
  result: OrchestrationResult,
  callLLM: LLMCallFn,
  taskPlan: TaskStep[],
  contextFiles: string[],
  verbose: boolean = false,
): Promise<string> {
  try {
    const store = getTrajectoryStore();
    const id = await store.save(result, callLLM, taskPlan, contextFiles);

    if (id && verbose) {
      logger.success(`   Stored execution trajectory: ${id}`);
    }

    return id;
  } catch (err) {
    if (verbose) {
      logger.debug(`Failed to store trajectory: ${err}`);
    }
    return '';
  }
}

/**
 * Get memory storage statistics.
 */
export async function getMemoryStats(): Promise<{
  total: number;
  avgScore: number;
  byProjectFingerprint: Record<string, number>;
}> {
  const store = getTrajectoryStore();
  return store.stats();
}

/**
 * Clear all stored memory (trajectories and vector index).
 */
export async function clearMemory(): Promise<void> {
  const store = getTrajectoryStore();
  await store.clear();
}
