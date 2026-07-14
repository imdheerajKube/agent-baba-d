/**
 * SelfImprover — The self-improvement loop that ties together scoring,
 * agent performance tracking, pattern extraction, and model optimization.
 *
 * After each orchestration run (when `useMemory: true`), the SelfImprover:
 * 1. Scores the trajectory (how well did we do?)
 * 2. Records per-agent stats (which agents/models succeed/fail?)
 * 3. Periodically extracts patterns from high-scoring trajectories
 * 4. Provides optimization recommendations (best models per agent)
 *
 * The SelfImprover is called by the Orchestrator post-execution hook.
 * Users can also interact with it via the `buff learn` CLI commands.
 */

import type { OrchestrationResult } from '../agents/orchestrator.js';
import type { Trajectory } from '../memory/trajectory-store.js';
import type { LLMCallFn } from '../agents/agent.js';
import { getTrajectoryStore } from '../memory/trajectory-store.js';
import { getPatternStore } from './pattern-extractor.js';
import { getAgentStats } from './agent-stats.js';
import { scoreOrchestrationResult } from './scorer.js';
import { logger } from '../utils/logger.js';

// ─── Constants ──────────────────────────────────────────────────────────────

/** How many successful runs before auto-extracting patterns */
const PATTERN_EXTRACTION_INTERVAL = 5;

/** How many trajectories to pass for pattern extraction */
const TRAJECTORIES_FOR_EXTRACTION = 3;

/** Minimum score to consider a trajectory as "good" */
const GOOD_SCORE_THRESHOLD = 0.6;

// ─── SelfImprover ───────────────────────────────────────────────────────────

export class SelfImprover {
  private runCountSinceLastExtraction: number = 0;

  /**
   * Process a completed orchestration run through the self-improvement loop.
   * Scores the result, tracks agent stats, and conditionally extracts patterns.
   *
   * @param result       The completed orchestration result
   * @param callLLM      LLM function for pattern extraction
   * @param agentModels  The model map used for this run (for tracking model perf)
   * @param verbose      Whether to log details
   */
  async processRun(
    result: OrchestrationResult,
    callLLM: LLMCallFn,
    agentModels?: Record<string, string>,
    verbose: boolean = false,
  ): Promise<void> {
    // Step 1: Score the trajectory
    const score = scoreOrchestrationResult(result);
    if (verbose) {
      logger.info(`   Self-improvement: trajectory score = ${(score * 100).toFixed(0)}%`);
    }

    // Step 2: Record per-agent stats
    const stats = getAgentStats();
    stats.recordRuns(result.agentResults, agentModels);

    // Step 3: Conditionally extract patterns from good trajectories
    if (score >= GOOD_SCORE_THRESHOLD) {
      this.runCountSinceLastExtraction++;

      if (this.runCountSinceLastExtraction >= PATTERN_EXTRACTION_INTERVAL) {
        this.runCountSinceLastExtraction = 0;

        if (verbose) {
          logger.info('   Extracting coding patterns from successful trajectories...');
        }

        await this.extractPatterns(callLLM, verbose);
      }
    }
  }

  /**
   * Force pattern extraction from the best trajectories in the store.
   */
  async extractPatterns(
    callLLM: LLMCallFn,
    verbose: boolean = false,
  ): Promise<number> {
    try {
      const store = getTrajectoryStore();
      const allTrajectories = store.getAll();

      // Get the highest-scoring trajectories
      const best = allTrajectories
        .filter((t) => t.score !== undefined)
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .slice(0, TRAJECTORIES_FOR_EXTRACTION);

      if (best.length < 2) {
        if (verbose) {
          logger.info('   Not enough scored trajectories for pattern extraction');
        }
        return 0;
      }

      const patternStore = getPatternStore();
      const count = await patternStore.extractFromTrajectories(best, callLLM);

      if (verbose && count > 0) {
        logger.success(`   Extracted ${count} new pattern(s) from ${best.length} trajectories`);
      }

      return count;
    } catch (err) {
      if (verbose) {
        logger.debug(`Pattern extraction failed: ${err}`);
      }
      return 0;
    }
  }

  /**
   * Get optimization recommendations based on collected stats.
   * Returns a recommended model map for the Orchestrator.
   */
  getOptimizedModelMap(): Record<string, string> {
    const stats = getAgentStats();
    const allAgents = stats.getAllAgents();
    const modelMap: Record<string, string> = {};

    for (const agentType of Object.keys(allAgents)) {
      const bestModel = stats.getBestModel(agentType);
      if (bestModel) {
        modelMap[agentType] = bestModel;
      }
    }

    return modelMap;
  }

  /**
   * Get a human-readable summary of the self-improvement status.
   */
  getStatus(): string {
    const stats = getAgentStats();
    const patternStore = getPatternStore();
    const patterns = patternStore.getAll();
    const store = getTrajectoryStore();
    const allTrajectories = store.getAll();

    const lines: string[] = [
      '🔄 Self-Improvement Status',
      '',
      '── Trajectories ──',
      `   Total stored: ${allTrajectories.length}`,
      `   Scored: ${allTrajectories.filter((t) => t.score !== undefined).length}`,
      `   Avg score: ${this.averageScore(allTrajectories)}`,
      '',
      '── Patterns ──',
      `   Total patterns: ${patterns.length}`,
      `   Domains covered: ${[...new Set(patterns.flatMap((p) => p.applicableDomains))].join(', ') || 'none'}`,
      '',
      `── Performance ──`,
      `   Total runs tracked: ${stats.getRaw().totalRuns}`,
      `   Agents tracked: ${Object.keys(stats.getAllAgents()).length}`,
    ];

    lines.push('');
    lines.push(stats.formatStats());
    lines.push('');
    lines.push(stats.formatModelRecommendations());

    return lines.join('\n');
  }

  /**
   * Reset extraction counter (called when user manually extracts patterns).
   */
  resetExtractionCounter(): void {
    this.runCountSinceLastExtraction = 0;
  }

  // ── Private ────────────────────────────────────────────────────────────

  private averageScore(trajectories: Trajectory[]): string {
    const scored = trajectories.filter((t) => t.score !== undefined);
    if (scored.length === 0) return 'N/A';
    const avg = scored.reduce((sum, t) => sum + (t.score || 0), 0) / scored.length;
    return `${(avg * 100).toFixed(0)}%`;
  }
}

// Singleton
let improverInstance: SelfImprover | null = null;

export function getSelfImprover(): SelfImprover {
  if (!improverInstance) {
    improverInstance = new SelfImprover();
  }
  return improverInstance;
}
