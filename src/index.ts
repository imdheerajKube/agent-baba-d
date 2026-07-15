#!/usr/bin/env node

import { createCLI } from './cli/router.js';
import { setLogLevel } from './utils/logger.js';

// ─── Agent exports (public API) ─────────────────────────────────────────────
export { Orchestrator } from './agents/orchestrator.js';
export type { OrchestratorOptions, OrchestrationResult } from './agents/orchestrator.js';
export { buildProjectFileTree, truncateTree } from './agents/utils/file-tree.js';
export { ContextVault } from './agents/context-vault.js';
export { Agent } from './agents/agent.js';
export type {
  AgentContext,
  AgentResult,
  TaskStep,
  Artifact,
  AgentMessage,
  FileChange,
  LLMCallFn,
} from './agents/agent.js';
export { PlannerAgent } from './agents/agents/planner.js';
export { ContextGathererAgent } from './agents/agents/context-gatherer.js';
export { WriterAgent } from './agents/agents/writer.js';
export { ReviewerAgent } from './agents/agents/reviewer.js';
export { TesterAgent, cleanupSandbox } from './agents/agents/tester.js';
export type { TestResult } from './agents/agents/tester.js';
export { DebuggerAgent } from './agents/agents/debugger.js';
export { RunnerAgent } from './agents/agents/runner.js';
export type { RunResult } from './agents/agents/runner.js';
export { GitHubReleaseAgent } from './agents/agents/github-release-agent.js';
export { SecurityAgent } from './agents/agents/security-agent.js';
export { runAllScans, scanForPII, scanForInjections, scanForDangerousCode, formatScanReport } from './security/scanner.js';
export type { SecurityFinding, ScanResult } from './security/scanner.js';

// ─── Learning exports ───────────────────────────────────────────────────────
export { SelfImprover, getSelfImprover } from './learning/self-improver.js';
export { AgentStats, getAgentStats } from './learning/agent-stats.js';
export type { AgentPerformance, AgentStatsData } from './learning/agent-stats.js';
export { scoreTrajectory, scoreOrchestrationResult } from './learning/scorer.js';
export type { ScoreComponents, ScoreInput } from './learning/scorer.js';

// ─── Memory exports ────────────────────────────────────────────────────────
export { VectorStore, getVectorStore, cosineSimilarity } from './memory/vector-store.js';
export type { VectorEntry } from './memory/vector-store.js';
export { embed, clearEmbeddingCache, embeddingCacheSize } from './memory/embedder.js';
export { TrajectoryStore, getTrajectoryStore } from './memory/trajectory-store.js';
export type { Trajectory, TrajectoryStep } from './memory/trajectory-store.js';
export {
  retrieveMemoryContext,
  storeExecutionTrajectory,
  getMemoryStats,
  clearMemory,
} from './memory/memory-integration.js';

// ─── Existing exports ───────────────────────────────────────────────────────
export { ConfigManager } from './config/manager.js';
export { ProviderFactory } from './inference/factory.js';
export type { InferenceProvider, ModelDescriptor } from './inference/interface.js';
export type { ProviderType, ProviderConfig, InferenceOptions } from './config/types.js';
export { getPluginRegistry, PluginRegistry } from './plugins/registry.js';
export type { ProviderPlugin, PluginMetadata } from './plugins/registry.js';

/**
 * Buff CLI — Flexible AI inference tool
 * Supports local models (Ollama, HuggingFace, GGML) and cloud APIs
 * (NVIDIA NIM, Google Gemini, OpenRouter)
 */
async function main(): Promise<void> {
  const program = createCLI();

  // Parse args and handle debug mode
  const debugIndex = process.argv.indexOf('--debug');
  if (debugIndex > -1 || process.argv.includes('-d')) {
    setLogLevel('debug');
  }

  await program.parseAsync(process.argv);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
