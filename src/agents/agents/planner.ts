/**
 * PlannerAgent — Analyzes a user goal and produces an ordered, dependency-aware
 * execution plan consisting of TaskSteps for other agents to execute.
 *
 * The planner is the first agent to run in every orchestration session.
 * It now receives the project file tree (injected by the Orchestrator via
 * context.metadata.projectFileTree) so it can make informed decisions about
 * which files to create, modify, or reference in its plan.
 */

import { Agent, type AgentContext, type AgentResult, type TaskStep } from '../agent.js';
import type { LLMCallFn } from '../agent.js';

const PLANNER_SYSTEM_PROMPT = [
  'You are a senior software architect. Your job is to decompose a user\'s goal into a detailed, ordered execution plan.',
  '',
  'For each step, specify:',
  '- id: A short unique identifier (e.g., "step-01-gather-context")',
  '- description: What needs to be done in clear language',
  '- agentType: One of "context-gatherer", "writer", "reviewer", "tester", "debugger", "runner", "security"',
  '- dependsOn: Array of step IDs that must complete before this one (empty array for first steps)',
  '',
  'Rules:',
  '1. Start with a "context-gatherer" step to understand the codebase (if files exist)',
  '2. Add one or more "writer" steps to implement changes (max 2-3 files per step)',
  '3. If the project is EMPTY or the goal is to CREATE something from scratch,',
  '   skip the context-gatherer step and go straight to writer steps.',
  '4. For goals that require running something (like "create a Python script and run it"),',
  '   add a "runner" step AFTER the writer step(s).',
  '   Use the description to specify the command: "Run: python hello.py" or "Run `npm test`"',
  '5. End with a "reviewer" step to validate the work',
  '6. Set dependsOn correctly so steps run in the right order',
  '7. Keep steps granular — each step should change at most 2-3 files',
  '8. Maximum 12 steps total',
  '',
  'Return ONLY a valid JSON array. No markdown, no explanations.',
  '',
  'Example (modifying existing project):',
  '[',
  '  {',
  '    "id": "step-01-understand",',
  '    "description": "Scan the codebase to understand the current project structure and identify files related to authentication",',
  '    "agentType": "context-gatherer",',
  '    "dependsOn": []',
  '  },',
  '  {',
  '    "id": "step-02-add-routes",',
  '    "description": "Create JWT authentication routes in src/routes/auth.ts with login, register, and refresh endpoints",',
  '    "agentType": "writer",',
  '    "dependsOn": ["step-01-understand"]',
  '  },',
  '  {',
  '    "id": "step-03-add-middleware",',
  '    "description": "Add JWT verification middleware in src/middleware/auth.ts",',
  '    "agentType": "writer",',
  '    "dependsOn": ["step-01-understand"]',
  '  },',
  '  {',
  '    "id": "step-04-review",',
  '    "description": "Review all changes for security vulnerabilities, correctness, and code quality",',
  '    "agentType": "reviewer",',
  '    "dependsOn": ["step-02-add-routes", "step-03-add-middleware"]',
  '  }',
  ']',
  '',
  'Example (creating from scratch + running):',
  '[',
  '  {',
  '    "id": "step-01-create-script",',
  '    "description": "Create a Python script hello.py that prints Hello, World!",',
  '    "agentType": "writer",',
  '    "dependsOn": []',
  '  },',
  '  {',
  '    "id": "step-02-run-script",',
  '    "description": "Run: python hello.py', '    "agentType": "runner",',
  '    "dependsOn": ["step-01-create-script"]',
  '  },',
  '  {',
  '    "id": "step-03-review",',
  '    "description": "Verify the output is correct",',
  '    "agentType": "reviewer",',
  '    "dependsOn": ["step-02-run-script"]',
  '  }',
  ']',
].join('\n');

/**
 * PlannerAgent — Decomposes user goals into ordered task plans.
 * Now accepts `projectFileTree` from context.metadata to make informed plans.
 */
export class PlannerAgent extends Agent {
  readonly name = 'Planner';
  readonly description = 'Analyzes user goals and creates detailed execution plans';

  async execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult> {
    try {
      // Check for file tree (injected by Orchestrator) and memory context
      const fileTree = context.metadata.projectFileTree as string | undefined;
      const memoryContext = context.metadata.memoryContext as string | undefined;

      const promptParts: string[] = [
        PLANNER_SYSTEM_PROMPT,
        '',
        '## User Goal',
        context.goal,
        '',
        '## Working Directory',
        context.workingDirectory,
      ];

      // Inject the project file tree so the planner knows what exists
      if (fileTree) {
        const treeLines = fileTree.split('\n').length;
        promptParts.push(
          '',
          '## Current Project Structure',
          fileTree || '(empty directory — no source files found)',
          treeLines > 1 ? `\n(${treeLines} files/directories visible)` : ' (empty)',
        );
      } else {
        promptParts.push(
          '',
          '## Current Project Structure',
          '(unknown — file tree not available)',
        );
      }

      // Append memory/few-shot examples if available
      if (memoryContext) {
        promptParts.push('', memoryContext);
      }

      promptParts.push('', 'Create an execution plan for this goal. Return ONLY a valid JSON array of task steps.');

      const prompt = promptParts.join('\n');

      const response = await callLLM(prompt, {
        temperature: 0.3, // Low temperature for structured output
        maxTokens: 4096,
      });

      const rawPlan = this.parsePlan(response);

      // Normalize and validate each step
      // LLMs often return numbers for id, null for dependsOn, or different formats
      const plan: TaskStep[] = [];
      for (const step of rawPlan) {
        if (!step || typeof step !== 'object') continue;
        if (!step.description || !step.agentType) continue;

        // Normalize: convert id to string if it's a number
        const id = String(step.id ?? `step-${plan.length + 1}`);

        // Normalize: dependsOn can be null, undefined, a single string, or an array
        let dependsOn: string[] = [];
        if (Array.isArray(step.dependsOn)) {
          dependsOn = step.dependsOn.map((d: unknown) => String(d));
        } else if (typeof step.dependsOn === 'string' || typeof step.dependsOn === 'number') {
          dependsOn = [String(step.dependsOn)];
        }

        plan.push({
          id,
          description: String(step.description),
          agentType: String(step.agentType),
          dependsOn,
          status: 'pending',
        });
      }

      if (plan.length === 0) {
        return {
          success: false,
          summary: 'Planner produced an empty or invalid plan',
          details: response,
          error: 'The LLM returned a plan with no valid task steps',
        };
      }

      // Store the parsed plan directly in the shared context for the orchestrator
      context.taskPlan.push(...plan);

      return {
        success: true,
        summary: `Created ${plan.length} task steps`,
        details: plan.map((s) => `  [${s.agentType}] ${s.description}`).join('\n'),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Detect non-chat-model errors and provide helpful suggestions
      let summary = 'Planner failed';
      if (msg.includes('does not support chat completions')) {
        summary = 'Planner failed — selected model does not support text chat. Use a text model like llama-3.3-70b-versatile or llama-3.1-8b-instant';
      }
      return {
        success: false,
        summary,
        error: msg,
      };
    }
  }

  /**
   * Extract the task plan from the LLM response.
   * Tries JSON.parse first, then falls back to extracting from code blocks.
   */
  private parsePlan(response: string): TaskStep[] {
    // Try direct JSON parse
    const trimmed = response.trim();
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed as TaskStep[];
    } catch {
      // Not direct JSON — try extracting from code block
    }

    // Try extracting from ```json ... ``` block
    const jsonMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1].trim());
        if (Array.isArray(parsed)) return parsed as TaskStep[];
      } catch {
        // Fall through
      }
    }

    // Try finding a JSON array anywhere in the response
    const arrayMatch = trimmed.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try {
        const parsed = JSON.parse(arrayMatch[0]);
        if (Array.isArray(parsed)) return parsed as TaskStep[];
      } catch {
        // Fall through
      }
    }

    return [];
  }
}
