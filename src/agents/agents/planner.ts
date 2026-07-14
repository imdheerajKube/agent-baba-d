/**
 * PlannerAgent — Analyzes a user goal and produces an ordered, dependency-aware
 * execution plan consisting of TaskSteps for other agents to execute.
 *
 * The planner is the first agent to run in every orchestration session.
 */

import { Agent, type AgentContext, type AgentResult, type TaskStep } from '../agent.js';
import type { LLMCallFn } from '../agent.js';

const PLANNER_SYSTEM_PROMPT = `You are a senior software architect. Your job is to decompose a user's goal into a detailed, ordered execution plan.

For each step, specify:
- id: A short unique identifier (e.g., "step-01-gather-context")
- description: What needs to be done in clear language
- agentType: One of "context-gatherer", "writer", "reviewer", "tester", "debugger"
- dependsOn: Array of step IDs that must complete before this one (empty array for first steps)

Rules:
1. Start with a "context-gatherer" step to understand the codebase
2. Add one or more "writer" steps to implement changes
3. End with a "reviewer" step to validate the work
4. Set dependsOn correctly so steps run in the right order
5. Keep steps granular — each step should change at most 2-3 files
6. Maximum 10 steps total

Return ONLY a valid JSON array. No markdown, no explanations.

Example:
[
  {
    "id": "step-01-understand",
    "description": "Scan the codebase to understand the current project structure and identify files related to authentication",
    "agentType": "context-gatherer",
    "dependsOn": []
  },
  {
    "id": "step-02-add-routes",
    "description": "Create JWT authentication routes in src/routes/auth.ts with login, register, and refresh endpoints",
    "agentType": "writer",
    "dependsOn": ["step-01-understand"]
  },
  {
    "id": "step-03-add-middleware",
    "description": "Add JWT verification middleware in src/middleware/auth.ts",
    "agentType": "writer",
    "dependsOn": ["step-01-understand"]
  },
  {
    "id": "step-04-review",
    "description": "Review all changes for security vulnerabilities, correctness, and code quality",
    "agentType": "reviewer",
    "dependsOn": ["step-02-add-routes", "step-03-add-middleware"]
  }
]
`;

/**
 * PlannerAgent — Decomposes user goals into ordered task plans.
 */
export class PlannerAgent extends Agent {
  readonly name = 'Planner';
  readonly description = 'Analyzes user goals and creates detailed execution plans';

  async execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult> {
    try {
      // Check for memory context (retrieved from past similar trajectories)
      const memoryContext = context.metadata.memoryContext as string | undefined;

      let prompt = `${PLANNER_SYSTEM_PROMPT}\n\n## User Goal\n${context.goal}\n\n## Working Directory\n${context.workingDirectory}`;

      // Append memory/few-shot examples if available
      if (memoryContext) {
        prompt += `\n\n${memoryContext}`;
      }

      prompt += `\n\nCreate an execution plan for this goal. Return ONLY a valid JSON array of task steps.`;

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
      return {
        success: false,
        summary: 'Planner failed',
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
