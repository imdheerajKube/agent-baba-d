/**
 * TrajectoryScorer — Scores execution trajectories based on outcome quality.
 *
 * Scoring heuristics (max score = 1.0):
 * - Base completion: 0.4 (all tasks completed → 0.4, partial → proportional)
 * - No test failures: +0.3 (all tests passed)
 * - No reviewer issues: +0.2 (reviewer approved)
 * - Fewer iterations: +0.1 (fewer agent steps = more efficient)
 *
 * Scores are computed when a trajectory is saved and can be re-scored later
 * if the user provides feedback (e.g., "accepted changes").
 *
 * Scoring happens at save time in the TrajectoryStore and is stored
 * in the trajectory's `score` field for search ranking.
 */

import type { OrchestrationResult } from '../agents/orchestrator.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ScoreComponents {
  /** 0–0.4: based on task completion ratio */
  completionScore: number;
  /** 0–0.3: based on test success */
  testScore: number;
  /** 0–0.2: based on reviewer approval */
  reviewScore: number;
  /** 0–0.1: based on efficiency (fewer iterations) */
  efficiencyScore: number;
  /** Total score (0–1), clamped */
  total: number;
}

export interface ScoreInput {
  /** Tasks completed vs total (e.g., 5/5) */
  tasksCompleted: number;
  tasksTotal: number;
  /** Whether all tests passed (from TesterAgent) */
  testsPassed?: boolean;
  /** Whether the reviewer approved (no critical issues) */
  reviewPassed?: boolean;
  /** Number of agent steps executed (fewer = more efficient) */
  totalSteps?: number;
  /** 0–1 user feedback (1 = accepted without changes) */
  userAcceptance?: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_COMPLETION_SCORE = 0.4;
const MAX_TEST_SCORE = 0.3;
const MAX_REVIEW_SCORE = 0.2;
const MAX_EFFICIENCY_SCORE = 0.1;
const MAX_USER_FEEDBACK_SCORE = 0.5;
const BASELINE_STEPS = 3; // "Ideal" minimum steps for most tasks

// ─── Scorer ─────────────────────────────────────────────────────────────────

/**
 * Score a trajectory execution outcome.
 * Returns component scores and the total.
 */
export function scoreTrajectory(input: ScoreInput): ScoreComponents {
  const completionScore = computeCompletionScore(input.tasksCompleted, input.tasksTotal);
  const testScore = input.testsPassed === true ? MAX_TEST_SCORE : 0;
  const reviewScore = input.reviewPassed === true ? MAX_REVIEW_SCORE : 0;
  const efficiencyScore = computeEfficiencyScore(input.totalSteps);
  const userScore = input.userAcceptance
    ? input.userAcceptance * MAX_USER_FEEDBACK_SCORE
    : 0;

  const total = Math.min(
    completionScore + testScore + reviewScore + efficiencyScore + userScore,
    1.0,
  );

  return { completionScore, testScore, reviewScore, efficiencyScore, total };
}

/**
 * Convenience: score an OrchestrationResult directly.
 */
export function scoreOrchestrationResult(
  result: OrchestrationResult,
  extra?: Partial<ScoreInput>,
): number {
  const scored = scoreTrajectory({
    tasksCompleted: result.tasksCompleted,
    tasksTotal: result.tasksTotal,
    reviewPassed: result.success,
    ...extra,
  });
  return scored.total;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function computeCompletionScore(completed: number, total: number): number {
  if (total === 0) return 0;
  return (completed / total) * MAX_COMPLETION_SCORE;
}

function computeEfficiencyScore(totalSteps?: number): number {
  if (totalSteps === undefined || totalSteps <= 0) return 0;
  // Fewer steps = higher efficiency. 3 steps = max score, 10+ steps = 0.
  const ratio = Math.max(0, 1 - (totalSteps - BASELINE_STEPS) / 10);
  return ratio * MAX_EFFICIENCY_SCORE;
}
