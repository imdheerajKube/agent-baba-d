/**
 * ReviewerAgent — Validates code changes produced by the WriterAgent.
 *
 * The reviewer checks for:
 * - Syntax errors and type mismatches
 * - Security vulnerabilities (SQL injection, XSS, etc.)
 * - Code style and conventions
 * - Correctness of the implementation against the task description
 * - Missing edge cases and error handling
 *
 * Output is stored in the shared context bus as conversation messages.
 */

import { Agent, type AgentContext, type AgentResult } from '../agent.js';
import type { LLMCallFn } from '../agent.js';
import { logger } from '../../utils/logger.js';

const REVIEWER_SYSTEM_PROMPT = `You are a senior code reviewer. Review the following code changes for quality, correctness, and security.

Focus on:
1. **Correctness** — Does the code correctly implement the described task?
2. **Security** — Any SQL injection, XSS, path traversal, or other vulnerabilities?
3. **Error handling** — Are edge cases and invalid inputs handled?
4. **Code quality** — Is the code clean, readable, and maintainable?
5. **Type safety** — Are there any type mismatches or implicit any types?
6. **Performance** — Any obvious performance issues?

## Output Format

ONLY list issues that actually exist. Do NOT describe absent issues.

For each issue found, use this exact format:
- CRITICAL: <description>
  Location: <file/line>
  Fix: <suggestion>

- WARNING: <description>
  Location: <file/line>
  Fix: <suggestion>

- SUGGESTION: <description>
  Location: <file/line>

If NO issues are found, respond ONLY with:
✅ Review passed. No issues found.

Do NOT mention potential issues that don't exist. Do NOT use the words "CRITICAL", "WARNING", or "SUGGESTION" unless you are actually flagging an issue.`;

/** Maximum API retry attempts for transient LLM failures */
const MAX_API_RETRIES = 2;

/** Base delay for exponential backoff (doubles each retry: 1s, 2s) */
const BASE_RETRY_DELAY_MS = 1000;

/**
 * ReviewerAgent — Validates code changes produced by WriterAgent.
 */
export class ReviewerAgent extends Agent {
  readonly name = 'Reviewer';
  readonly description = 'Validates code changes for correctness, security, and quality';

  async execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult> {
    let lastError: string | undefined;

    if (context.fileChanges.length === 0) {
      return {
        success: true,
        summary: 'No files to review',
        details: 'The WriterAgent did not produce any file changes.',
      };
    }

    for (let attempt = 0; attempt <= MAX_API_RETRIES; attempt++) {
      try {
        const prompt = this.buildPrompt(context);
        const response = await callLLM(prompt, {
          temperature: 0.2,
          maxTokens: 4096,
        });

        // Log the review as a conversation message
        context.conversations.push({
          from: 'Reviewer',
          to: 'Orchestrator',
          content: response,
          timestamp: Date.now(),
        });

        const hasCriticalIssues = this.hasCriticalIssues(response);

        return {
          success: !hasCriticalIssues,
          summary: hasCriticalIssues
            ? 'Review found critical issues'
            : 'Review passed',
          details: response,
          error: hasCriticalIssues
            ? 'Critical issues found — see review details'
            : undefined,
        };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);

        if (attempt < MAX_API_RETRIES) {
          const delayMs = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
          logger.warn(
            `Reviewer API error (attempt ${attempt + 1}/${MAX_API_RETRIES + 1}): ` +
            `${lastError.slice(0, 200)}. Retrying in ${delayMs}ms...`,
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        logger.error(`Reviewer failed after ${MAX_API_RETRIES + 1} API attempts: ${lastError}`);
        return {
          success: false,
          summary: 'Review failed',
          error: lastError,
        };
      }
    }

    // Unreachable
    return {
      success: false,
      summary: 'Review failed',
      error: lastError || 'Unknown error',
    };
  }

  /**
   * Build the review prompt from the task plan, relevant context, and changes.
   */
  private buildPrompt(context: AgentContext): string {
    // Format the task description
    const taskDescriptions = context.taskPlan
      .filter((s) => s.agentType === 'writer')
      .map((s) => `  - ${s.description}`)
      .join('\n');

    // Format the file changes as diffs
    const diffs = context.fileChanges
      .map((change) => {
        const header = `--- a/${change.path}\n+++ b/${change.path}`;
        if (change.originalContent && change.newContent) {
          // Simple diff: show old and new
          return `${header}\n@@ ... @@\n${change.originalContent}\n---\n${change.newContent}`;
        }
        if (change.status === 'created') {
          return `${header}\n@@ -0,0 +1 @@\n+ (new file)\n${change.newContent}`;
        }
        return header;
      })
      .join('\n\n');

    return `${REVIEWER_SYSTEM_PROMPT}\n\n## Task Description\n${taskDescriptions || context.goal}\n\n## Changes to Review\n${diffs || '(No changes provided)'}\n\n## Instructions\nReview the above changes. Identify any issues and provide feedback.`;
  }

  /**
   * Check if the review response contains any critical issues.
   * Looks for "CRITICAL:" (with colon) at the start of a bullet or line.
   * This avoids false positives from LLMs that say things like
   * "No critical issues found" (which lacks the colon prefix).
   */
  private hasCriticalIssues(review: string): boolean {
    // Match "CRITICAL:" (with colon) on its own line, as a bullet, or in flow text.
    // The colon prefix is critical — it's how the prompt tells the LLM to format issues.
    // "No critical issues found" won't match; "CRITICAL: SQL injection" will.
    const criticalPrefix = /(?:^|\n|[-*]\s*)CRITICAL\s*:/im;

    // Also match the old patterns for backwards compatibility
    const oldPatterns = [
      /🔴/,
      /\bBlocking\b/,
      /\bSecurity\s*vulnerability\b/i,
    ];

    return criticalPrefix.test(review) || oldPatterns.some((p) => p.test(review));
  }
}
