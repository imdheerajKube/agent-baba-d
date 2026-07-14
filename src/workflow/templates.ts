/**
 * Workflow Templates — Pre-built agent pipeline templates.
 *
 * Each template defines a sequence of agent steps for common tasks.
 * The WorkflowEngine uses these to pre-fill the orchestrator's task plan,
 * bypassing the PlannerAgent when a fixed workflow is desired.
 *
 * Built-in templates:
 * - quick-fix: gather context → edit → review (small, fast changes)
 * - feature-implement: plan → gather → write → test → review (new features)
 * - publish-release: test → build → version → publish (release pipeline)
 */

import type { TaskStep } from '../agents/agent.js';
import type { OrchestratorOptions } from '../agents/orchestrator.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WorkflowTemplate {
  /** Template identifier (used in CLI: `buff workflow run quick-fix`) */
  id: string;
  /** Human-readable name */
  name: string;
  /** Short description */
  description: string;
  /** Ordered agent steps that form the pipeline */
  steps: WorkflowStep[];
  /** Recommended model routing for this workflow */
  recommendedModels?: Partial<Record<string, string>>;
  /** Whether to use memory for this workflow type */
  useMemory?: boolean;
}

export interface WorkflowStep {
  /** Agent type (must be registered in Orchestrator's createAgent) */
  agentType: string;
  /** Description of what this step does (becomes the task description) */
  description: string;
  /** IDs of steps this step depends on (index-based: ['step-0', 'step-1']) */
  dependsOn: string[];
}

// ─── Built-in Templates ─────────────────────────────────────────────────────

const BUILTIN_TEMPLATES: WorkflowTemplate[] = [
  {
    id: 'quick-fix',
    name: 'Quick Fix',
    description: 'Fast context → edit → review for small changes (bug fixes, typos, simple edits)',
    steps: [
      {
        agentType: 'context-gatherer',
        description: 'Scan codebase to find relevant files for the fix',
        dependsOn: [],
      },
      {
        agentType: 'writer',
        description: 'Apply the fix based on gathered context',
        dependsOn: ['step-0'],
      },
      {
        agentType: 'reviewer',
        description: 'Review the fix for correctness and quality',
        dependsOn: ['step-1'],
      },
      {
        agentType: 'security',
        description: 'Run all security scans on changes',
        dependsOn: ['step-2'],
      },
    ],
    recommendedModels: {
      'context-gatherer': 'groq/llama-3.1-8b-instant',
      writer: 'groq/llama-3.1-8b-instant',
      reviewer: 'groq/llama-3.1-8b-instant',
    },
  },
  {
    id: 'feature-implement',
    name: 'Feature Implementation',
    description: 'Full feature workflow: plan → gather → write → test → review',
    steps: [
      {
        agentType: 'planner',
        description: 'Analyze the goal and create an implementation plan',
        dependsOn: [],
      },
      {
        agentType: 'context-gatherer',
        description: 'Gather relevant files and context for the feature',
        dependsOn: ['step-0'],
      },
      {
        agentType: 'writer',
        description: 'Implement the feature code changes',
        dependsOn: ['step-1'],
      },
      {
        agentType: 'tester',
        description: 'Run tests to verify the implementation',
        dependsOn: ['step-2'],
      },
      {
        agentType: 'reviewer',
        description: 'Review the implementation for quality and completeness',
        dependsOn: ['step-2'],
      },
      {
        agentType: 'security',
        description: 'Run all security scans on changes',
        dependsOn: ['step-4'],
      },
    ],
    recommendedModels: {
      planner: 'groq/llama-3.1-8b-instant',
      'context-gatherer': 'groq/llama-3.1-8b-instant',
      writer: 'groq/llama-3.1-8b-instant',
      tester: 'groq/llama-3.1-8b-instant',
      reviewer: 'groq/llama-3.1-8b-instant',
    },
    useMemory: true,
  },
  {
    id: 'publish-release',
    name: 'Publish Release',
    description: 'Full release pipeline: test → version bump → review → commit → build&publish → github release',
    steps: [
      {
        agentType: 'tester',
        description: 'Run the full test suite to verify the codebase is healthy',
        dependsOn: [],
      },
      {
        agentType: 'writer',
        description: 'Bump version number in package.json and update changelog',
        dependsOn: ['step-0'],
      },
      {
        agentType: 'reviewer',
        description: 'Review version bump and changelog for correctness',
        dependsOn: ['step-1'],
      },
      {
        agentType: 'security',
        description: 'Run all security scans on changes before committing',
        dependsOn: ['step-2'],
      },
      {
        agentType: 'git',
        description: 'Commit the version bump and changelog changes to git',
        dependsOn: ['step-3'],
      },
      {
        agentType: 'package',
        description: 'Build project and publish to npm',
        dependsOn: ['step-4'],
      },
      {
        agentType: 'github-release',
        description: 'Create git tag and GitHub release with auto-generated notes',
        dependsOn: ['step-5'],
      },
    ],
    recommendedModels: {
      writer: 'groq/llama-3.1-8b-instant',
      reviewer: 'groq/llama-3.1-8b-instant',
    },
    useMemory: false,
  },
];

// ─── Workflow Engine ────────────────────────────────────────────────────────

/**
 * Get all available workflow templates.
 */
export function getWorkflowTemplates(): WorkflowTemplate[] {
  return [...BUILTIN_TEMPLATES];
}

/**
 * Get a specific workflow template by ID.
 */
export function getWorkflowTemplate(id: string): WorkflowTemplate | undefined {
  return BUILTIN_TEMPLATES.find((t) => t.id === id);
}

/**
 * Build a task plan from a workflow template, filling in the user's goal.
 * Each step gets a stable ID (step-0, step-1, etc.) and the dependsOn
 * references are translated from index-based to ID-based.
 */
export function buildTaskPlanFromTemplate(
  template: WorkflowTemplate,
  goal: string,
): TaskStep[] {
  return template.steps.map((step, index) => ({
    id: `step-${index}`,
    description: `${step.description} for: ${goal}`,
    agentType: step.agentType,
    dependsOn: step.dependsOn,
    status: 'pending' as const,
  }));
}

/**
 * Build OrchestratorOptions from a workflow template.
 * Merges the template's recommended models with user overrides.
 */
export function buildWorkflowOptions(
  template: WorkflowTemplate,
  userOptions: Partial<OrchestratorOptions> = {},
): OrchestratorOptions {
  return {
    agentModels: template.recommendedModels,
    useMemory: template.useMemory,
    autoRouteModels: !template.recommendedModels,
    verbose: userOptions.verbose,
    dryRun: userOptions.dryRun,
    provider: userOptions.provider,
    model: userOptions.model,
  };
}
