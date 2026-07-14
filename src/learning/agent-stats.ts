/**
 * AgentStats — Tracks per-agent performance metrics to enable
 * data-driven improvements in agent execution.\n *
 * What it tracks:
 * - Success/failure counts per agent type
 * - Which models perform best for each agent type
 * - Average task duration (optional, for future use)
 * - Total runs count
 *
 * Data is stored as JSON at ~/.buff/memory/agent-stats.json
 * and updated after each orchestration run.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AgentPerformance {
  /** Total attempts */
  totalRuns: number;
  /** Successful completions */
  successfulRuns: number;
  /** Failed completions */
  failedRuns: number;
  /** Success rate (0–1) */
  successRate: number;
  /** Which models have been used and with what success */
  modelPerformance: Record<string, { runs: number; successes: number }>;
  /** Last time this agent was run */
  lastRun: number;
}

export interface AgentStatsData {
  /** Per-agent stats keyed by agent type (e.g., 'writer', 'planner') */
  agents: Record<string, AgentPerformance>;
  /** Total orchestration runs recorded */
  totalRuns: number;
  /** Overall success rate across all agents */
  overallSuccessRate: number;
  /** When stats were last updated */
  lastUpdated: number;
  /** Schema version */
  version: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const MEMORY_DIR = join(homedir(), '.buff', 'memory');
const STATS_PATH = join(MEMORY_DIR, 'agent-stats.json');
const CURRENT_VERSION = 1;

// ─── AgentStats Tracker ─────────────────────────────────────────────────────

export class AgentStats {
  private data: AgentStatsData;

  constructor() {
    this.data = this.load();
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Record a single agent execution result.
   * Updates per-agent stats and recalculates rates.
   */
  recordRun(agentType: string, success: boolean, model?: string): void {
    if (!this.data.agents[agentType]) {
      this.data.agents[agentType] = this.createEmpty();
    }

    const agent = this.data.agents[agentType];
    agent.totalRuns++;
    if (success) {
      agent.successfulRuns++;
    } else {
      agent.failedRuns++;
    }
    agent.successRate = agent.totalRuns > 0
      ? agent.successfulRuns / agent.totalRuns
      : 0;
    agent.lastRun = Date.now();

    // Track model performance
    if (model) {
      if (!agent.modelPerformance[model]) {
        agent.modelPerformance[model] = { runs: 0, successes: 0 };
      }
      agent.modelPerformance[model].runs++;
      if (success) {
        agent.modelPerformance[model].successes++;
      }
    }

    this.data.totalRuns++;
    this.data.lastUpdated = Date.now();
    this.recalculateOverallRate();
    this.save();
  }

  /**
   * Record multiple agent runs from an orchestration result.
   */
  recordRuns(runs: Array<{ agent: string; success: boolean }>, modelMap?: Record<string, string>): void {
    for (const run of runs) {
      const model = modelMap?.[run.agent];
      this.recordRun(run.agent, run.success, model);
    }
  }

  /**
   * Get stats for a specific agent type.
   */
  getAgentStats(agentType: string): AgentPerformance | undefined {
    return this.data.agents[agentType];
  }

  /**
   * Get all agent stats.
   */
  getAllAgents(): Record<string, AgentPerformance> {
    return { ...this.data.agents };
  }

  /**
   * Get the best-performing model for a given agent type.
   * Returns undefined if no data is available.
   */
  getBestModel(agentType: string): string | undefined {
    const agent = this.data.agents[agentType];
    if (!agent) return undefined;

    const models = Object.entries(agent.modelPerformance);
    if (models.length === 0) return undefined;

    // Sort by success rate (descending), then by run count (descending)
    models.sort(([, a], [, b]) => {
      const rateA = a.runs > 0 ? a.successes / a.runs : 0;
      const rateB = b.runs > 0 ? b.successes / b.runs : 0;
      if (rateA !== rateB) return rateB - rateA;
      return b.runs - a.runs; // More runs = more confidence
    });

    return models[0][0];
  }

  /**
   * Get agents sorted by success rate (ascending — worst performers first).
   * Useful for identifying which agents need attention.
   */
  getWorstPerformers(limit: number = 5): Array<{ agentType: string; stats: AgentPerformance }> {
    return Object.entries(this.data.agents)
      .map(([agentType, stats]) => ({ agentType, stats }))
      .sort((a, b) => a.stats.successRate - b.stats.successRate)
      .slice(0, limit);
  }

  /**
   * Get agents sorted by success rate (descending — best performers first).
   */
  getBestPerformers(limit: number = 5): Array<{ agentType: string; stats: AgentPerformance }> {
    return Object.entries(this.data.agents)
      .map(([agentType, stats]) => ({ agentType, stats }))
      .sort((a, b) => b.stats.successRate - a.stats.successRate)
      .slice(0, limit);
  }

  /**
   * Format stats as a human-readable string.
   */
  formatStats(): string {
    const lines: string[] = [
      '📊 Agent Performance Stats',
      `   Total runs: ${this.data.totalRuns}`,
      `   Overall success rate: ${(this.data.overallSuccessRate * 100).toFixed(1)}%`,
      '',
      '   ┌─────────────────────┬────────┬────────┬────────┬──────────┐',
      '   │ Agent               │  Runs  │  OK    │  FAIL  │  Rate    │',
      '   ├─────────────────────┼────────┼────────┼────────┼──────────┤',
    ];

    const sorted = Object.entries(this.data.agents).sort(
      ([, a], [, b]) => b.successRate - a.successRate,
    );

    for (const [agentType, stats] of sorted) {
      const name = agentType.padEnd(18).slice(0, 18);
      const runs = String(stats.totalRuns).padStart(6);
      const ok = String(stats.successfulRuns).padStart(6);
      const fail = String(stats.failedRuns).padStart(6);
      const rate = `${(stats.successRate * 100).toFixed(0)}%`.padStart(7);
      lines.push(`   │ ${name} │ ${runs} │ ${ok} │ ${fail} │ ${rate} │`);
    }

    lines.push(
      '   └─────────────────────┴────────┴────────┴────────┴──────────┘',
    );

    return lines.join('\n');
  }

  /**
   * Format best model recommendations as a string.
   */
  formatModelRecommendations(): string {
    const lines: string[] = ['🤖 Recommended Models per Agent'];

    const sorted = Object.entries(this.data.agents).sort(
      ([, a], [, b]) => b.totalRuns - a.totalRuns,
    );

    for (const [agentType, stats] of sorted) {
      const bestModel = this.getBestModel(agentType);
      if (bestModel) {
        const modelPerf = stats.modelPerformance[bestModel];
        const modelRate = modelPerf.runs > 0
          ? (modelPerf.successes / modelPerf.runs * 100).toFixed(0)
          : '?';
        lines.push(
          `   ${agentType.padEnd(18)} → ${bestModel.padEnd(30)} ` +
          `(${modelPerf.successes}/${modelPerf.runs} OK, ${modelRate}%)`,
        );
      }
    }

    return lines.join('\n');
  }

  /**
   * Clear all stats.
   */
  clear(): void {
    this.data = this.createFresh();
    this.save();
  }

  /**
   * Get raw data for inspection.
   */
  getRaw(): AgentStatsData {
    return { ...this.data };
  }

  // ── Private ────────────────────────────────────────────────────────────

  private createEmpty(): AgentPerformance {
    return {
      totalRuns: 0,
      successfulRuns: 0,
      failedRuns: 0,
      successRate: 0,
      modelPerformance: {},
      lastRun: 0,
    };
  }

  private createFresh(): AgentStatsData {
    return {
      agents: {},
      totalRuns: 0,
      overallSuccessRate: 0,
      lastUpdated: Date.now(),
      version: CURRENT_VERSION,
    };
  }

  private recalculateOverallRate(): void {
    const agents = Object.values(this.data.agents);
    if (agents.length === 0) {
      this.data.overallSuccessRate = 0;
      return;
    }
    const totalSuccesses = agents.reduce((sum, a) => sum + a.successfulRuns, 0);
    const totalRuns = agents.reduce((sum, a) => sum + a.totalRuns, 0);
    this.data.overallSuccessRate = totalRuns > 0 ? totalSuccesses / totalRuns : 0;
  }

  private load(): AgentStatsData {
    try {
      this.ensureDir();
      if (!existsSync(STATS_PATH)) return this.createFresh();
      const raw = readFileSync(STATS_PATH, 'utf-8');
      return JSON.parse(raw) as AgentStatsData;
    } catch {
      return this.createFresh();
    }
  }

  private save(): void {
    this.ensureDir();
    writeFileSync(STATS_PATH, JSON.stringify(this.data, null, 2), 'utf-8');
  }

  private ensureDir(): void {
    if (!existsSync(MEMORY_DIR)) {
      mkdirSync(MEMORY_DIR, { recursive: true });
    }
  }
}

// Singleton
let statsInstance: AgentStats | null = null;

export function getAgentStats(): AgentStats {
  if (!statsInstance) {
    statsInstance = new AgentStats();
  }
  return statsInstance;
}
