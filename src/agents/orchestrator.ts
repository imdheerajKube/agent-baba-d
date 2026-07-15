/**
 * Orchestrator — The central coordinator of the multi-agent system.
 *
 * Responsibilities:
 * 1. Accept a user goal and optionally a provider/model config
 * 2. Create a ContextVault (shared context bus)
 * 3. Build the project file tree and inject it for the Planner
 * 4. Optionally retrieve memory context from past similar trajectories
 * 5. Run the PlannerAgent to produce an execution plan
 * 6. Execute tasks sequentially, respecting dependencies
 * 7. Spawn the appropriate agent for each task
 * 8. Apply file changes to disk
 * 9. Execute runner commands and capture output
 * 10. Optionally store the trajectory in memory
 * 11. Synthesize and return the final result
 *
 * Called by the `agent-baba-d execute` CLI command.
 */

import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import inquirer from 'inquirer';

import { ProviderFactory } from '../inference/factory.js';
import { ConfigManager } from '../config/manager.js';
import type { ProviderType, InferenceOptions } from '../config/types.js';
import { logger } from '../utils/logger.js';

import { ContextVault } from './context-vault.js';
import { Agent } from './agent.js';
import type { LLMCallFn, AgentResult, TaskStep, OnRateLimit } from './agent.js';
import { buildProjectFileTree, truncateTree } from './utils/file-tree.js';
import { PlannerAgent } from './agents/planner.js';
import { ContextGathererAgent } from './agents/context-gatherer.js';
import { WriterAgent } from './agents/writer.js';
import { ReviewerAgent } from './agents/reviewer.js';
import { RunnerAgent } from './agents/runner.js';
import type { RunResult } from './agents/runner.js';
import { TesterAgent, cleanupSandbox } from './agents/tester.js';
import { DebuggerAgent } from './agents/debugger.js';
import { GitAgent } from './agents/git-agent.js';
import { PackageAgent } from './agents/package-agent.js';
import { GitHubReleaseAgent } from './agents/github-release-agent.js';
import { SecurityAgent } from './agents/security-agent.js';
import { scanForInjections, formatScanReport } from '../security/scanner.js';
import { buildAgentModelMap } from '../learning/model-router.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Configuration for an orchestration session */
export interface OrchestratorOptions {
  /** Inference provider type (default: from configManager) */
  provider?: string;
  /** Model override (default: from provider config) */
  model?: string;
  /** Whether to write files to disk (false = dry-run) */
  dryRun?: boolean;
  /** Enable verbose logging */
  verbose?: boolean;
  /** Agent-specific model overrides */
  agentModels?: Partial<Record<string, string>>;
  /** Enable persistent memory (trajectory storage and retrieval) */
  useMemory?: boolean;
  /** Auto-route each agent to its recommended model from the ModelRouter */
  autoRouteModels?: boolean;
  /** Pre-built task plan to use instead of calling the PlannerAgent (for workflow templates) */
  prefillPlan?: TaskStep[];
}

/** The final result of an orchestration session */
export interface OrchestrationResult {
  /** Overall success */
  success: boolean;
  /** The original user goal */
  goal: string;
  /** Summary of what was accomplished */
  summary: string;
  /** Number of tasks completed vs total */
  tasksCompleted: number;
  tasksTotal: number;
  /** Detailed results from each agent */
  agentResults: Array<{ agent: string; success: boolean; summary: string }>;
  /** File change summary */
  fileChanges: string;
  /** Runner output (from executed commands) */
  runOutput?: string;
  /** Error message if failed */
  error?: string;
  /** Memory trajectory ID if stored */
  trajectoryId?: string;
}

// ─── Agent Registry ─────────────────────────────────────────────────────────

function createAgent(agentType: string, _options: OrchestratorOptions): Agent | null {
  switch (agentType) {
    case 'context-gatherer':
      return new ContextGathererAgent();
    case 'planner':
      return new PlannerAgent();
    case 'writer':
      return new WriterAgent();
    case 'reviewer':
      return new ReviewerAgent();
    case 'runner':
      return new RunnerAgent();
    case 'tester':
      return new TesterAgent();
    case 'debugger':
      return new DebuggerAgent();
    case 'git':
      return new GitAgent();
    case 'package':
      return new PackageAgent();
    case 'github-release':
      return new GitHubReleaseAgent();
    case 'security':
      return new SecurityAgent();
    default:
      return null;
  }
}

// ─── Orchestrator ───────────────────────────────────────────────────────────

export class Orchestrator {
  private configManager: ConfigManager;

  constructor(configManager?: ConfigManager) {
    this.configManager = configManager ?? new ConfigManager();
  }

  /**
   * Execute a multi-agent pipeline for the given goal.
   */
  async execute(goal: string, options: OrchestratorOptions = {}): Promise<OrchestrationResult> {
    const startTime = Date.now();
    const vault = new ContextVault(goal, process.cwd());
    const defaultCallLLM = this.createLLMProvider(options);
    const agentResults: OrchestrationResult['agentResults'] = [];
    const contextFiles: string[] = [];

    // ── 2b. Build project file tree and inject for Planner ────────────────
    if (options.verbose) logger.highlight('\n📂 Scanning project structure...');
    try {
      const fullTree = await buildProjectFileTree(process.cwd());
      // Truncate to 100 lines max to avoid blowing token limits
      const treeForPlanner = truncateTree(fullTree, 100);
      vault.setMeta('projectFileTree', treeForPlanner);
      if (options.verbose) {
        const fileCount = fullTree.split('\n').filter((l) => l.includes('📄')).length;
        logger.info(`   Found ${fileCount} source files in project`);
      }
    } catch (err) {
      logger.debug(`File tree build failed (non-critical): ${err}`);
      vault.setMeta('projectFileTree', '');
    }

    // ── 3. Memory Retrieval ──────────────────────────────────────────────
    let memoryContext = '';

    if (options.useMemory) {
      if (options.verbose) logger.highlight('\n🔍 Searching memory for similar past tasks...');
      let patternContext = '';
      try {
        const { retrieveMemoryContext } = await import('../memory/memory-integration.js');
        const memoryResult = await retrieveMemoryContext(goal, defaultCallLLM, 3);
        memoryContext = memoryResult.fewShotContext;
        // Also inject coding patterns if available
        patternContext = memoryResult.patternContext || '';
        if (options.verbose) {
          if (memoryResult.trajectories.length > 0) {
            logger.info(`   Found ${memoryResult.trajectories.length} similar past trajectories`);
          } else {
            logger.info('   No similar past tasks found in memory');
          }
        }
      } catch (err) {
        logger.debug(`Memory retrieval failed: ${err}`);
      }
      // Inject memory context and patterns into vault for agents
      if (memoryContext) {
        vault.setMeta('memoryContext', memoryContext);
      }
      if (patternContext) {
        vault.setMeta('patternContext', patternContext);
        memoryContext += `\n${patternContext}`;
      }
    }

    // ── 3b. Auto-route models ─────────────────────────────────────────────
    if (options.autoRouteModels && !options.agentModels) {
      const autoModels = buildAgentModelMap();
      options.agentModels = autoModels;
      if (options.verbose) {
        logger.info('   Auto-routing models based on task type');
      }
    }

    // ── 4. Planner (or pre-built plan from workflow template) ────────────
    if (options.prefillPlan && options.prefillPlan.length > 0) {
      for (const step of options.prefillPlan) {
        vault.context.taskPlan.push({ ...step });
      }
      agentResults.push({ agent: 'Planner', success: true, summary: `Using pre-built '${options.prefillPlan.length}-step' workflow plan` });
      if (options.verbose) {
        logger.highlight('\n📋 Using workflow template plan...');
        logger.info(`   Using ${options.prefillPlan.length} pre-defined steps`);
        for (const step of options.prefillPlan) {
          logger.info(`      [${step.agentType}] ${step.description}`);
        }
      }
    } else {
      if (options.verbose) logger.highlight('\n📋 Planning...');

      const planResult = await this.runAgent(new PlannerAgent(), vault, defaultCallLLM, options);
      agentResults.push({ agent: 'Planner', success: planResult.success, summary: planResult.summary });

      if (!planResult.success) {
        return this.buildResult(false, goal, agentResults, vault, {
          error: planResult.error || 'Planning failed',
        });
      }

      if (vault.context.taskPlan.length === 0) {
        return this.buildResult(false, goal, agentResults, vault, {
          error: 'Planner did not produce a valid task plan',
        });
      }

      if (options.verbose) {
        logger.info(`   Created ${vault.context.taskPlan.length} task steps`);
        for (const step of vault.context.taskPlan) {
          logger.info(`      [${step.agentType}] ${step.description}`);
        }
      }
    }

    // ── 5. Execute tasks ─────────────────────────────────────────────────
    if (options.verbose) logger.highlight('\n⚡ Executing tasks...');

    for (let iteration = 0; iteration < 50; iteration++) {
      if (vault.isComplete) break;

      const runnableTasks = vault.getRunnableTasks();
      if (runnableTasks.length === 0 && !vault.isComplete) {
        const stuck = vault.context.taskPlan.filter((s) => s.status === 'pending');
        for (const s of stuck) {
          const failedDep = vault.context.taskPlan.find(
            (d) => s.dependsOn.includes(d.id) && d.status === 'failed',
          );
          const reason = failedDep
            ? `Dependency failed: ${failedDep.id} (${failedDep.description.slice(0, 60)})`
            : 'Deadlocked: dependencies could not be satisfied';
          vault.updateTaskStatus(s.id, 'failed', reason);
        }
        break;
      }

      // Runner and sandbox agents need exclusive access (no parallel)
      const exclusiveAgentTypes = ['tester', 'debugger', 'runner'];
      const canParallel = runnableTasks.length > 1 &&
        !runnableTasks.some((t) => exclusiveAgentTypes.includes(t.agentType));

      if (canParallel) {
        for (const task of runnableTasks) {
          vault.updateTaskStatus(task.id, 'running');
        }

        if (options.verbose) {
          logger.info(`\n   ⚡ Running ${runnableTasks.length} tasks in parallel...`);
        }

        const taskPromises = runnableTasks.map((task) =>
          this.executeSingleTask(task, vault, options, agentResults, contextFiles, defaultCallLLM)
        );
        await Promise.all(taskPromises);
      } else {
        for (const task of runnableTasks) {
          await this.executeSingleTask(task, vault, options, agentResults, contextFiles, defaultCallLLM);
        }
      }
    }

    // ── 6. Clean up sandbox if any ────────────────────────────────────────
    const sandboxPath = vault.getMeta<string>('sandboxPath');
    if (sandboxPath) {
      try {
        cleanupSandbox(sandboxPath);
      } catch {
        // Best-effort cleanup
      }
    }

    // ── 6b. Apply file changes ────────────────────────────────────────────
    if (!options.dryRun) {
      const applied = this.applyFileChanges(vault);
      if (applied > 0 && options.verbose) {
        logger.success(`\n   💾 Applied ${applied} file change${applied !== 1 ? 's' : ''} to disk`);
      }
    }

    // ── 6c. Collect runner output for display ────────────────────────────
    let runOutput: string | undefined;
    const runResult = vault.getMeta<RunResult>('runResult');
    if (runResult) {
      const lines: string[] = [];
      lines.push(`$ ${runResult.command}`);
      lines.push(`Exit code: ${runResult.exitCode} | Duration: ${runResult.duration}ms`);
      if (runResult.stdout) {
        lines.push('');
        lines.push(runResult.stdout.slice(0, 2000)); // Limit displayed output
        if (runResult.stdout.length > 2000) {
          lines.push('... (output truncated)');
        }
      }
      if (runResult.stderr && runResult.exitCode !== 0) {
        lines.push('');
        lines.push('stderr:');
        lines.push(runResult.stderr.slice(0, 1000));
      }
      runOutput = lines.join('\n');
    }

    // ── 7. Store trajectory in memory + self-improvement loop ───────────
    let trajectoryId = '';
    if (options.useMemory) {
      try {
        const orchestrationSummary = {
          success: !vault.hasFailedTasks,
          goal,
          summary: '',
          tasksCompleted: vault.context.taskPlan.filter((s) => s.status === 'completed').length,
          tasksTotal: vault.context.taskPlan.length,
          agentResults,
          fileChanges: vault.getDiffSummary(),
        };

        const { storeExecutionTrajectory } = await import('../memory/memory-integration.js');
        trajectoryId = await storeExecutionTrajectory(
          orchestrationSummary,
          defaultCallLLM,
          vault.context.taskPlan,
          contextFiles,
          options.verbose,
        );

        // Self-improvement
        try {
          const { getSelfImprover } = await import('../learning/self-improver.js');
          const improver = getSelfImprover();
          await improver.processRun(
            { ...orchestrationSummary, trajectoryId },
            defaultCallLLM,
            options.agentModels as Record<string, string> | undefined,
            options.verbose,
          );

          if (options.verbose && trajectoryId) {
            logger.info('   Self-improvement stats saved. Run `buff learn optimize` to see recommendations.');
          }
        } catch (err) {
          logger.debug(`Self-improvement loop failed: ${err}`);
        }
      } catch (err) {
        logger.debug(`Trajectory storage failed: ${err}`);
      }
    }

    // ── 8. Synthesize result ─────────────────────────────────────────────
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const completed = vault.context.taskPlan.filter((s) => s.status === 'completed').length;
    const total = vault.context.taskPlan.length;
    const hasFailures = vault.hasFailedTasks;

    const summaryLines: string[] = [];
    summaryLines.push(hasFailures
      ? `Completed ${completed}/${total} tasks with some failures in ${elapsed}s`
      : `Completed all ${completed} tasks successfully in ${elapsed}s`);
    summaryLines.push('');
    summaryLines.push('Changes:');
    summaryLines.push(vault.getDiffSummary());

    return this.buildResult(!hasFailures, goal, agentResults, vault, {
      summary: summaryLines.join('\n'),
      tasksCompleted: completed,
      tasksTotal: total,
      trajectoryId,
      runOutput,
    });
  }

  // ─── Private Helpers ──────────────────────────────────────────────────

  private createLLMProvider(options: OrchestratorOptions): LLMCallFn {
    const providerType = (options.provider ||
      this.configManager.getAll().defaultProvider) as ProviderType;

    const { config } = this.configManager.getProviderConfig(providerType);
    const provider = ProviderFactory.createProvider(providerType, config);

    return async (prompt: string, inferenceOptions?: InferenceOptions) => {
      // Runtime injection guardrail
      const injectionFindings = scanForInjections(prompt);
      if (injectionFindings.length > 0) {
        const report = formatScanReport({
          passed: false,
          findings: injectionFindings,
          summary: 'Prompt injection detected — call blocked',
        });
        throw new Error(`Injection guardrail blocked LLM call:\n${report}`);
      }

      const mergedOptions = {
        ...inferenceOptions,
        model: options.model || inferenceOptions?.model || config.model,
        temperature: inferenceOptions?.temperature ?? config.temperature ?? 0.7,
        maxTokens: inferenceOptions?.maxTokens ?? config.maxTokens ?? 4096,
      };
      return provider.generate(prompt, mergedOptions);
    };
  }

  private async runAgent(
    agent: Agent,
    vault: ContextVault,
    callLLM: LLMCallFn,
    _options: OrchestratorOptions,
  ): Promise<AgentResult> {
    try {
      return await agent.execute(vault.context, callLLM);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, summary: `${agent.name} errored`, error: msg };
    }
  }

  /**
   * Create the onRateLimit callback that prompts the user.
   * Returns undefined if we're in non-interactive mode (no TTY or dry-run).
   */
  private createRateLimitHandler(
    options: OrchestratorOptions,
    currentModel: string | undefined,
  ): OnRateLimit | undefined {
    // Don't prompt in non-interactive or dry-run mode — just use auto-retry
    if (options.dryRun || !process.stdout.isTTY) {
      return undefined;
    }

    return async (info) => {
      const waitSeconds = (info.retryAfterMs / 1000).toFixed(1);
      const modelStr = info.modelName
        ? `Model: ${info.modelName}`
        : currentModel
          ? `Model: ${currentModel}`
          : '';

      console.log('');
      logger.warn(`\u26A0\uFE0F  Rate limit hit for ${info.agentName}`);
      logger.info(`   ${modelStr}`);
      logger.info(`   Please wait ${waitSeconds}s before next request`);
      console.log('');

      const { action } = await inquirer.prompt<{ action: string }>([
        {
          type: 'list',
          name: 'action',
          message: `What would you like to do?`,
          prefix: '\u{1F504}',
          choices: [
            { name: `\u23F3  Wait ${waitSeconds}s and retry`, value: 'retry' },
            { name: '\u{1F500}  Switch to a different model', value: 'switch-model' },
            { name: '\u23ED  Skip this step', value: 'skip' },
            { name: '\u274C  Abort the pipeline', value: 'abort' },
          ],
        },
      ]);

      console.log('');

      if (action === 'retry') {
        logger.info(`Waiting ${waitSeconds}s as requested...`);
        return { action: 'retry' };
      }

      if (action === 'skip') {
        logger.info('Skipping this step.');
        return { action: 'skip' };
      }

      if (action === 'abort') {
        logger.error('Pipeline aborted by user.');
        return { action: 'abort' };
      }

      if (action === 'switch-model') {
        // Prompt for the new model name
        const { model } = await inquirer.prompt<{ model: string }>([
          {
            type: 'input',
            name: 'model',
            message: 'Enter the new model name (e.g., llama-3.1-8b-instant, gemini-2.0-flash):',
            prefix: '\u{1F3AF}',
            validate: (input: string) => {
              if (!input.trim()) return 'Please enter a model name';
              return true;
            },
          },
        ]);

        console.log('');
        logger.info(`Switching to model: ${model.trim()}`);

        // Create a new LLM provider with the switched model
        const newCallLLM = this.createLLMProvider({
          ...options,
          model: model.trim(),
        });

        return { action: 'switch-model', callLLM: newCallLLM };
      }

      // Fallback: retry
      return { action: 'retry' };
    };
  }

  private async executeSingleTask(
    task: { id: string; agentType: string; description: string },
    vault: ContextVault,
    options: OrchestratorOptions,
    agentResults: OrchestrationResult['agentResults'],
    contextFiles: string[],
    defaultCallLLM: LLMCallFn,
  ): Promise<void> {
    vault.updateTaskStatus(task.id, 'running');

    if (options.verbose) {
      logger.info(`\n   ▶️  ${task.agentType}: ${task.description.slice(0, 80)}${task.description.length > 80 ? '...' : ''}`);
    }

    try {
      const agentModel = options.model || options.agentModels?.[task.agentType];
      const agentCallLLM = agentModel
        ? this.createLLMProvider({ ...options, model: agentModel })
        : defaultCallLLM;

      // Skip runner tasks in dry-run mode (no commands executed)
      if (task.agentType === 'runner' && options.dryRun) {
        vault.updateTaskStatus(task.id, 'completed', 'Skipped (dry-run mode)');
        agentResults.push({
          agent: 'runner',
          success: true,
          summary: 'Skipped (dry-run mode — no commands executed)',
        });
        if (options.verbose) {
          logger.info('      ⏭️  Skipped (dry-run — no commands executed)');
        }
        return;
      }

      const agent = createAgent(task.agentType, options);
      if (!agent) {
        vault.updateTaskStatus(task.id, 'failed', `Unknown agent type: ${task.agentType}`);
        agentResults.push({
          agent: task.agentType,
          success: false,
          summary: `Unknown agent type: ${task.agentType}`,
        });
        return;
      }

      // Wire up the rate-limit handler so agents can prompt the user
      vault.context.onRateLimit = this.createRateLimitHandler(options, agentModel || options.model);
      const result = await agent.execute(vault.context, agentCallLLM);
      vault.updateTaskStatus(task.id, result.success ? 'completed' : 'failed', result.summary);
      agentResults.push({ agent: task.agentType, success: result.success, summary: result.summary });

      // Track sandbox path for cleanup
      if (result.success && task.agentType === 'tester') {
        const testResult = vault.getMeta<any>('testResult');
        if (testResult?.sandboxPath) {
          vault.setMeta('sandboxPath', testResult.sandboxPath);
        }
      }

      // After writer step: sync new/modified files into artifacts
      if (task.agentType === 'writer' && result.success) {
        const newArtifacts = vault.context.fileChanges
          .filter((c) => c.status === 'created' || c.status === 'modified')
          .filter((c) => c.newContent)
          .map((c) => ({
            path: c.path,
            content: c.newContent!,
            description: `${c.status} by WriterAgent (${task.description.slice(0, 60)})`,
          }));

        for (const artifact of newArtifacts) {
          const existing = vault.context.artifacts.findIndex((a) => a.path === artifact.path);
          if (existing >= 0) {
            vault.context.artifacts[existing] = artifact;
          } else {
            vault.context.artifacts.push(artifact);
          }
        }
      }

      // After runner step: refresh artifacts with any files created during execution
      if (task.agentType === 'runner' && result.success) {
        const runResult = vault.getMeta<any>('runResult');
        if (runResult?.stdout) {
          vault.setMeta('runOutput', runResult.stdout);
        }
      }

      // Track context file paths for memory storage
      if (task.agentType === 'context-gatherer' && result.success) {
        for (const artifact of vault.context.artifacts) {
          if (!contextFiles.includes(artifact.path)) {
            contextFiles.push(artifact.path);
          }
        }
      }

      if (options.verbose) {
        const icon = result.success ? '✅' : '⚠️';
        logger.info(`      ${icon} ${result.summary}`);
        // If it's a runner, show the output inline
        if (task.agentType === 'runner' && result.success && result.details) {
          const outputLines = result.details.split('\n').filter((l) => l.startsWith('stdout:') || l.startsWith('Command:'));
          for (const line of outputLines) {
            logger.info(`      ${line}`);
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vault.updateTaskStatus(task.id, 'failed', msg);
      agentResults.push({ agent: task.agentType, success: false, summary: `Error: ${msg}` });
    }
  }

  private applyFileChanges(vault: ContextVault): number {
    let count = 0;
    for (const change of vault.context.fileChanges) {
      if (change.status === 'deleted') continue;
      if (!change.newContent) continue;

      const absolutePath = change.path.startsWith('/')
        ? change.path
        : `${process.cwd()}/${change.path}`;

      const dir = dirname(absolutePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      writeFileSync(absolutePath, change.newContent, 'utf-8');
      count++;
    }
    return count;
  }

  private buildResult(
    success: boolean,
    goal: string,
    agentResults: OrchestrationResult['agentResults'],
    vault: ContextVault,
    overrides: Partial<OrchestrationResult> = {},
  ): OrchestrationResult {
    const completed = overrides.tasksCompleted ?? agentResults.filter((r) => r.success).length;
    const total = overrides.tasksTotal ?? agentResults.length;
    return {
      success,
      goal,
      summary: overrides.summary || `Execution completed with status: ${success ? 'success' : 'failure'}`,
      tasksCompleted: completed,
      tasksTotal: total,
      agentResults,
      fileChanges: vault.getDiffSummary(),
      runOutput: overrides.runOutput,
      error: overrides.error,
      trajectoryId: overrides.trajectoryId,
    };
  }
}
