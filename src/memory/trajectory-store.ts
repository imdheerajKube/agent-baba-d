/**
 * TrajectoryStore — Stores and retrieves successful agent execution trajectories.
 *
 * A trajectory captures a full agent session: the goal, the plan,
 * what files were touched, what changes were made, and the outcome.
 * This data is stored in a JSON file and indexed via the VectorStore
 * for semantic similarity search.
 *
 * When a new goal arrives, the Orchestrator queries past trajectories
 * and injects similar ones as few-shot examples into agent prompts.
 *
 * File location: ~/.buff/memory/trajectories.json
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import type { TaskStep, FileChange, AgentResult } from '../agents/agent.js';
import type { OrchestrationResult } from '../agents/orchestrator.js';
import { getVectorStore } from './vector-store.js';
import type { LLMCallFn } from '../agents/agent.js';
import { embed } from './embedder.js';
import { logger } from '../utils/logger.js';
import { scoreTrajectory } from '../learning/scorer.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** A lightweight summary of a task step, suitable for few-shot prompting */
export interface TrajectoryStep {
  id: string;
  description: string;
  agentType: string;
}

/** A stored agent execution trajectory */
export interface Trajectory {
  /** Unique identifier */
  id: string;
  /** The original user goal */
  goal: string;
  /** A concise description of the project's tech stack / domain */
  projectFingerprint: string;
  /** The execution plan (lightweight — descriptions only, no full content) */
  taskPlan: TrajectoryStep[];
  /** File paths that were read as context */
  contextFiles: string[];
  /** File changes (just paths and status, not full diffs) */
  fileChanges: Array<{ path: string; status: string }>;
  /** How many agent steps completed successfully */
  tasksCompleted: number;
  tasksTotal: number;
  /** Quality score (0-1) — higher = more reliable trajectory */
  score: number;
  /** When this trajectory was created */
  timestamp: number;
}

/** On-disk format */
interface TrajectoryData {
  trajectories: Record<string, Trajectory>;
  version: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const MEMORY_DIR = join(homedir(), '.buff', 'memory');
const TRAJECTORIES_PATH = join(MEMORY_DIR, 'trajectories.json');
const CURRENT_VERSION = 1;
const MAX_TRAJECTORIES = 500;

// ─── Helpers ────────────────────────────────────────────────────────────────

function ensureDir(): void {
  if (!existsSync(MEMORY_DIR)) {
    mkdirSync(MEMORY_DIR, { recursive: true });
  }
}

function readTrajectories(): TrajectoryData {
  try {
    ensureDir();
    if (!existsSync(TRAJECTORIES_PATH)) {
      return { trajectories: {}, version: CURRENT_VERSION };
    }
    const raw = readFileSync(TRAJECTORIES_PATH, 'utf-8');
    return JSON.parse(raw) as TrajectoryData;
  } catch {
    return { trajectories: {}, version: CURRENT_VERSION };
  }
}

function writeTrajectories(data: TrajectoryData): void {
  ensureDir();
  writeFileSync(TRAJECTORIES_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

/** Generate a unique trajectory ID */
function generateId(): string {
  return `traj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Simple heuristic to guess a project fingerprint from file changes */
function guessProjectFingerprint(fileChanges: FileChange[]): string {
  const paths = fileChanges.map((c) => c.path);
  const allExtensions = paths
    .map((p) => p.slice(p.lastIndexOf('.')))
    .filter(Boolean);

  const extSet = new Set(allExtensions);
  const tags: string[] = [];

  if (extSet.has('.ts') || extSet.has('.tsx')) tags.push('typescript');
  if (extSet.has('.js') || extSet.has('.jsx')) tags.push('javascript');
  if (extSet.has('.py')) tags.push('python');
  if (extSet.has('.go')) tags.push('go');
  if (extSet.has('.rs')) tags.push('rust');
  if (extSet.has('.json')) tags.push('json');
  if (paths.some((p) => p.includes('package.json'))) tags.push('node');
  if (paths.some((p) => p.includes('Dockerfile'))) tags.push('docker');

  return tags.length > 0 ? tags.join(', ') : 'unknown';
}

// ─── TrajectoryStore ────────────────────────────────────────────────────────

/**
 * Manages the storage and retrieval of agent execution trajectories.
 */
export class TrajectoryStore {
  /**
   * Save a successful orchestration result as a trajectory.
   * Also indexes it in the VectorStore for semantic search.
   *
   * @param result       The orchestration result to save
   * @param callLLM      LLM function for generating the embedding vector
   * @param taskPlan     The original task plan steps
   * @returns            The trajectory ID
   */
  async save(
    result: OrchestrationResult,
    callLLM: LLMCallFn,
    taskPlan: TaskStep[],
    contextFiles: string[],
  ): Promise<string> {
    // Only save successful trajectories
    if (!result.success) return '';

    const data = readTrajectories();

    // Prune old trajectories if we're at the limit
    this.pruneIfNeeded(data);

    const id = generateId();

    const trajectory: Trajectory = {
      id,
      goal: result.goal,
      projectFingerprint: '', // Will be set below after parsing file changes
      taskPlan: taskPlan.map((s) => ({
        id: s.id,
        description: s.description,
        agentType: s.agentType,
      })),
      contextFiles,
      fileChanges: result.fileChanges
        .split('\n')
        .filter((l) => l.includes('📄') || l.includes('✏️') || l.includes('🗑️'))
        .map((l) => {
          const match = l.match(/[✏️📄🗑️]\s+(.+?)\s+\((.*?)\)/);
          return match
            ? { path: match[1], status: match[2] }
            : { path: l.trim(), status: 'modified' };
        }),
      tasksCompleted: result.tasksCompleted,
      tasksTotal: result.tasksTotal,
      // Use the heuristic scorer for a more nuanced quality score
      score: scoreTrajectory({
        tasksCompleted: result.tasksCompleted,
        tasksTotal: result.tasksTotal,
        reviewPassed: result.success && !result.error,
        totalSteps: taskPlan.length,
      }).total,
      timestamp: Date.now(),
    };

    // Compute the project fingerprint from real file changes
    trajectory.projectFingerprint = guessProjectFingerprint(
      trajectory.fileChanges.map((fc) => ({
        path: fc.path,
        status: fc.status as FileChange['status'],
      })),
    );

    // Store the trajectory
    data.trajectories[id] = trajectory;
    writeTrajectories(data);

    // Generate embedding and index in VectorStore
    try {
      const embeddingText = this.buildEmbeddingText(trajectory);
      const vector = await embed(embeddingText, callLLM);

      const vs = getVectorStore();
      await vs.insert(id, vector, {
        goal: trajectory.goal,
        projectFingerprint: trajectory.projectFingerprint,
        score: trajectory.score,
        timestamp: trajectory.timestamp,
      });
    } catch (err) {
      // Non-fatal: trajectory is stored but not indexed for search
      logger.debug(`Failed to index trajectory ${id}: ${err}`);
    }

    return id;
  }

  /**
   * Retrieve a single trajectory by ID.
   */
  async get(id: string): Promise<Trajectory | null> {
    const data = readTrajectories();
    return data.trajectories[id] || null;
  }

  /**
   * Search for trajectories similar to a goal.
   *
   * @param goal      The goal text to search by
   * @param callLLM   LLM function for generating the query embedding
   * @param k         Maximum number of results
   * @returns         Array of trajectories sorted by relevance
   */
  async searchByGoal(
    goal: string,
    callLLM: LLMCallFn,
    k: number = 3,
  ): Promise<Trajectory[]> {
    try {
      // Generate embedding for the query
      const queryPrompt = `Search query for past agent trajectories: ${goal}`;
      const queryVector = await embed(queryPrompt, callLLM);

      // Skip search if we got a zero vector (embedding failed)
      if (queryVector.every((v) => v === 0)) return [];

      // Search the vector index
      const vs = getVectorStore();
      const results = await vs.search(queryVector, k, (entry) => {
        const score = entry.metadata.score as number || 0;
        return score >= 0.5; // Only retrieve quality trajectories
      });

      // Load full trajectories from the store
      const trajectories: Trajectory[] = [];
      const data = readTrajectories();

      for (const { entry, similarity } of results) {
        const traj = data.trajectories[entry.id];
        if (traj && similarity > 0.3) {
          trajectories.push(traj);
        }
      }

      return trajectories;
    } catch (err) {
      logger.debug(`Trajectory search failed: ${err}`);
      return [];
    }
  }

  /**
   * Format trajectories as few-shot examples for agent prompts.
   * Truncates plans to the first 5 steps to save token budget.
   * Returns a string that can be injected into the PlannerAgent's prompt.
   */
  formatAsFewShot(trajectories: Trajectory[]): string {
    if (trajectories.length === 0) return '';

    const MAX_STEPS_PER_TRAJECTORY = 5;

    const parts = trajectories.map((t, i) => {
      // Truncate long plans to save tokens in the prompt
      const truncatedPlan = t.taskPlan.slice(0, MAX_STEPS_PER_TRAJECTORY);
      const stepsJson = JSON.stringify(truncatedPlan, null, 2);
      const truncatedNote = t.taskPlan.length > MAX_STEPS_PER_TRAJECTORY
        ? `\n  (... and ${t.taskPlan.length - MAX_STEPS_PER_TRAJECTORY} more steps)`
        : '';

      return `## Similar Past Task ${i + 1}\nGoal: ${t.goal}\nProject: ${t.projectFingerprint}\nPlan:\n${stepsJson}${truncatedNote}\nFiles changed: ${t.fileChanges.map((fc) => fc.path).join(', ')}\n`;
    });

    return `\n---\nHere are examples of how similar goals were decomposed into execution plans in the past. Use them as reference for creating the plan for the current goal.\n\n${parts.join('\n')}\n---\n`;
  }

  /**
   * Get statistics about stored trajectories.
   */
  async stats(): Promise<{
    total: number;
    avgScore: number;
    byProjectFingerprint: Record<string, number>;
  }> {
    const data = readTrajectories();
    const trajectories = Object.values(data.trajectories);

    const avgScore = trajectories.length > 0
      ? trajectories.reduce((sum, t) => sum + t.score, 0) / trajectories.length
      : 0;

    const byProjectFingerprint: Record<string, number> = {};
    for (const t of trajectories) {
      const fp = t.projectFingerprint || 'unknown';
      byProjectFingerprint[fp] = (byProjectFingerprint[fp] || 0) + 1;
    }

    return {
      total: trajectories.length,
      avgScore: Math.round(avgScore * 100) / 100,
      byProjectFingerprint,
    };
  }

  /**
   * Get all stored trajectories.
   */
  getAll(): Trajectory[] {
    const data = readTrajectories();
    return Object.values(data.trajectories);
  }

  /**
   * Clear all trajectories.
   */
  async clear(): Promise<void> {
    writeTrajectories({ trajectories: {}, version: CURRENT_VERSION });
    const vs = getVectorStore();
    await vs.clear();
  }

  // ─── Private Helpers ────────────────────────────────────────────────────

  /**
   * Build text to generate an embedding for a trajectory.
   */
  private buildEmbeddingText(trajectory: Trajectory): string {
    return [
      `Goal: ${trajectory.goal}`,
      `Project: ${trajectory.projectFingerprint}`,
      `Steps: ${trajectory.taskPlan.map((s) => `${s.agentType}: ${s.description}`).join('; ')}`,
      `Files: ${trajectory.fileChanges.map((fc) => fc.path).join(', ')}`,
    ].join('\n');
  }

  /**
   * Remove oldest trajectories when the store exceeds MAX_TRAJECTORIES.
   */
  private pruneIfNeeded(data: TrajectoryData): void {
    const entries = Object.entries(data.trajectories);
    if (entries.length < MAX_TRAJECTORIES) return;

    // Sort by timestamp (oldest first), remove excess
    const sorted = entries.sort(([, a], [, b]) => a.timestamp - b.timestamp);
    const toRemove = sorted.slice(0, entries.length - MAX_TRAJECTORIES + 10);

    // Remove from trajectory store AND vector index to avoid orphaned entries
    for (const [id] of toRemove) {
      delete data.trajectories[id];
      // Async cleanup — fire and forget (non-critical)
      getVectorStore().delete(id).catch(() => {});
    }
  }
}

// Singleton instance
let storeInstance: TrajectoryStore | null = null;

export function getTrajectoryStore(): TrajectoryStore {
  if (!storeInstance) {
    storeInstance = new TrajectoryStore();
  }
  return storeInstance;
}
