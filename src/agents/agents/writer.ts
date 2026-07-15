/**
 * WriterAgent — Proposes code changes based on the task plan and gathered context.
 *
 * For each "writer" step in the execution plan, this agent:
 * 1. Reads the relevant source files (from artifacts in the context bus)
 * 2. Generates modified versions using the LLM
 * 3. Stores FileChange objects in the context bus for the orchestrator to apply
 *
 * The agent does NOT write to disk — it only proposes changes.
 * The orchestrator decides whether to apply them (based on dry-run mode).
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import { Agent, type AgentContext, type AgentResult, type FileChange, type LLMCallFn } from '../agent.js';
import { logger } from '../../utils/logger.js';

const WRITER_SYSTEM_PROMPT = `You are an expert software engineer implementing changes to a codebase.

Given file contents and an implementation task, you will:
1. Read the current file content carefully
2. Implement the requested changes
3. Return the COMPLETE updated file content for EACH modified file

## Output Format (MANDATORY)

Wrap EACH file you modify in its own code block. The file path MUST go right after the opening backticks with the prefix "filepath:".

CORRECT (use this format):
\`\`\`filepath:path/to/file.ts
// FULL updated file content here
\`\`\`

INCORRECT (do NOT use these):
- ❌ \`\`\`typescript\n...\n\`\`\` (missing filepath)
- ❌ \`\`\`\n...\n\`\`\` (missing language and filepath)
- ❌ Just describing the changes instead of returning the file

## Rules
- Return the FULL file content, not just the changed parts
- Preserve existing code style and conventions
- Add appropriate error handling
- Write clean, well-documented code
- If you modify multiple files, return ONE code block per file
`;

/** Maximum files to include in a single writer prompt */
const MAX_CONTEXT_FILES = 10;

/**
 * Maximum total characters across all files sent to the LLM.
 * 16,000 chars ≈ 4,000 tokens — leaves room for the rest of the prompt and response.
 * Files are prioritized: smaller files first, larger files are trunkated if over budget.
 */
const MAX_CONTEXT_CHARS = 16_000;

/** Maximum number of API retry attempts for transient LLM failures (rate limits, timeouts, etc.) */
const MAX_API_RETRIES = 2;

/** Base delay for exponential backoff in milliseconds (doubles each retry: 5s, 10s) */
const BASE_RETRY_DELAY_MS = 5000;

/**
 * Threshold above which we consider a rate-limit wait "long" and prompt the user.
 * Short waits (< 3s) are auto-retried silently. Long waits prompt the user.
 */
const LONG_WAIT_THRESHOLD_MS = 3000;

/**
 * Parse the "try again in Xs" hint from a rate-limit error response.
 * Supports formats: "try again in 10.49s", "try again in 5000ms"
 * Returns the suggested wait time in ms, or null if not found.
 */
function parseRetryAfterHint(errorMessage: string): number | null {
  // Match patterns like: "try again in 10.49s" or "try again in 5000ms"
  const secondMatch = errorMessage.match(/try again in ([\d.]+)s/i);
  if (secondMatch) {
    const seconds = parseFloat(secondMatch[1]);
    if (!isNaN(seconds) && seconds > 0) {
      return Math.ceil(seconds * 1000);
    }
  }

  const msMatch = errorMessage.match(/try again in (\d+)ms/i);
  if (msMatch) {
    const ms = parseInt(msMatch[1], 10);
    if (!isNaN(ms) && ms > 0) {
      return ms;
    }
  }

  return null;
}

/**
 * Extract the model name from a rate-limit error message.
 * Matches patterns like: "Rate limit reached for model `qwen/qwen3-32b`"
 */
function parseModelName(errorMessage: string): string | undefined {
  const match = errorMessage.match(/model\s+`([^`]+)`|model\s+'([^']+)'|model\s+([^\s]+)/i);
  return match?.[1] || match?.[2] || match?.[3] || undefined;
}

/**
 * Check if an error message indicates a rate-limit (429) error.
 */
function isRateLimitError(errorMessage: string): boolean {
  return /rate\s*limit|429|too many requests|try again in/i.test(errorMessage);
}

/**
 * Calculate the retry delay for a given attempt.
 * If the error message contains a "try again in Xs" hint, use that.
 * Otherwise, fall back to exponential backoff with BASE_RETRY_DELAY_MS.
 */
function calculateRetryDelay(attempt: number, errorMessage: string): number {
  const hintDelay = parseRetryAfterHint(errorMessage);
  if (hintDelay !== null) {
    return hintDelay;
  }
  // Fallback: exponential backoff (5s, 10s, 20s...)
  return BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
}

/**
 * WriterAgent — Proposes code changes by reading files, generating new versions
 * via the LLM, and storing FileChange objects in the shared context.
 * Does NOT write to disk directly; the orchestrator handles that.
 *
 * Retry strategy:
 * 1. Rate-limit (429) errors with LONG wait (>3s): invokes onRateLimit callback
 *    (if available) to let the user choose: wait, switch model, skip, or abort.
 * 2. Rate-limit errors with SHORT wait (<=3s): auto-retry with smart delay.
 * 3. Other transient errors (timeouts, network): auto-retry with backoff.
 * 4. Empty parse results (format issue): retry once with stricter prompt.
 */
export class WriterAgent extends Agent {
  readonly name = 'Writer';
  readonly description = 'Generates code changes based on the plan and context';

  async execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult> {
    let lastError: string | undefined;
    let latestCallLLM = callLLM;

    // Outer retry loop: handles transient API errors (rate limits, timeouts)
    for (let attempt = 0; attempt <= MAX_API_RETRIES; attempt++) {
      try {
        const result = await this.attemptWrite(context, latestCallLLM);

        // Inner retry: handles empty parse results (format issue)
        // This runs on EVERY API attempt — API errors and format issues are independent.
        // The format retry always returns (success or note), so no infinite loop risk.
        if (result.success && result.summary === 'No files needed changes') {
          // Retry once with stricter format instructions
          const retryResult = await this.attemptWrite(context, latestCallLLM, true);

          if (retryResult.success && retryResult.summary !== 'No files needed changes') {
            return retryResult;
          }

          return {
            success: true,
            summary: result.summary,
            details: `${result.details}\n(Retried once with explicit format instructions — still no parseable output)`,
          };
        }

        return result;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);

        // ── Rate limit handling with user prompt ─────────────────────
        if (isRateLimitError(lastError) && context.onRateLimit) {
          const retryAfterMs = parseRetryAfterHint(lastError) || BASE_RETRY_DELAY_MS;

          if (retryAfterMs >= LONG_WAIT_THRESHOLD_MS) {
            const modelName = parseModelName(lastError);
            const action = await context.onRateLimit({
              retryAfterMs,
              modelName,
              agentName: this.name,
              errorMessage: lastError.slice(0, 300),
            });

            if (action.action === 'abort') {
              logger.error(`Writer aborted by user: ${lastError}`);
              return {
                success: false,
                summary: 'Writer aborted by user due to rate limit',
                error: lastError,
              };
            }

            if (action.action === 'skip') {
              logger.info('Writer step skipped by user');
              return {
                success: true,
                summary: 'Skipped by user (rate limit)',
                details: 'The writer step was skipped because the API rate limit was exceeded.',
              };
            }

            if (action.action === 'switch-model') {
              logger.info('Switching model per user request...');
              latestCallLLM = action.callLLM;
              // Continue the retry loop with the new callLLM
              await new Promise((resolve) => setTimeout(resolve, 500)); // Brief pause before retry
              continue;
            }

            // 'retry': fall through to wait and retry below
            logger.warn(
              `Writer rate limited. Waiting ${(retryAfterMs / 1000).toFixed(1)}s as chosen by user...`,
            );
            await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
            continue;
          }
          // Short wait: auto-retry (fall through to standard retry logic below)
        }

        // ── Standard retry for transient errors ──────────────────────
        if (attempt < MAX_API_RETRIES) {
          if (isRateLimitError(lastError)) {
            // Short wait rate limit: auto-retry with smart delay
            const delayMs = calculateRetryDelay(attempt, lastError);
            logger.warn(
              `Writer API error (attempt ${attempt + 1}/${MAX_API_RETRIES + 1}): ` +
              `${lastError.slice(0, 200)}. Waiting ${(delayMs / 1000).toFixed(1)}s...`,
            );
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          } else {
            // Other transient errors (timeout, network): standard exponential backoff
            const delayMs = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
            logger.warn(
              `Writer API error (attempt ${attempt + 1}/${MAX_API_RETRIES + 1}): ` +
              `${lastError.slice(0, 200)}. Retrying in ${(delayMs / 1000).toFixed(1)}s...`,
            );
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
          continue;
        }

        // All attempts exhausted
        logger.error(`Writer failed after ${MAX_API_RETRIES + 1} API attempts: ${lastError}`);
        return {
          success: false,
          summary: 'Writer failed to generate changes',
          error: lastError,
        };
      }
    }

    // TypeScript safety — unreachable due to return in catch/finally
    return {
      success: false,
      summary: 'Writer failed to generate changes',
      error: lastError || 'Unknown error',
    };
  }

  /**
   * Perform a single write attempt.
   * Optionally uses a stricter retry prompt.
   */
  private async attemptWrite(
    context: AgentContext,
    callLLM: LLMCallFn,
    isRetry: boolean = false,
  ): Promise<AgentResult> {
    const prompt = this.buildPrompt(context, isRetry);

    // Log prompt size for debugging token limit issues
    const label = isRetry ? 'Retry' : 'Initial';
    logger.debug(`[Writer ${label}] Prompt size: ${prompt.length} chars, ~${Math.ceil(prompt.length / 4)} tokens`);

    const response = await callLLM(prompt, {
      temperature: isRetry ? 0.1 : 0.3, // Lower temperature for retry
      maxTokens: 2048,
    });

    // ── Verbose logging: capture what the LLM actually returned ──────
    logger.debug(`[Writer ${label}] LLM response length: ${response.length} chars`);
    logger.debug(`[Writer ${label}] LLM response preview (first 600 chars):`);
    logger.debug(response.slice(0, 600));
    if (response.length > 600) {
      logger.debug(`[Writer ${label}] ... (${response.length - 600} more chars truncated)`);
    }

    // Extract file changes from the response
    const fileChanges = this.parseFileChanges(response, context.workingDirectory);

    logger.debug(`[Writer ${label}] Parsed ${fileChanges.length} file change(s)`);
    for (const fc of fileChanges) {
      logger.debug(`[Writer ${label}]   ${fc.status === 'created' ? '\u{1F4C4}' : '\u{270F}\u{FE0F}'} ${fc.path} (${(fc.newContent || '').length} chars)`);
    }

    // Store changes in the shared context
    for (const change of fileChanges) {
      const existing = context.fileChanges.findIndex((c) => c.path === change.path);
      if (existing >= 0) {
        context.fileChanges[existing] = change;
      } else {
        context.fileChanges.push(change);
      }
    }

    const count = fileChanges.length;
    if (count === 0) {
      const excerpt = response.slice(0, 300).replace(/\n/g, '\\n');
      logger.debug(`[Writer ${label}] No files parsed. Response starts with: ${excerpt.slice(0, 200)}...`);
      return {
        success: true,
        summary: 'No files needed changes',
        details: `Response preview: ${excerpt}...`,
      };
    }

    return {
      success: true,
      summary: `Proposed changes to ${count} file${count !== 1 ? 's' : ''}`,
      details: fileChanges
        .map((c) => {
          const icon = c.status === 'created' ? '\u{1F4C4}' : '\u{270F}\u{FE0F}';
          return `  ${icon} ${c.path} (${c.status})`;
        })
        .join('\n'),
    };
  }

  /**
   * Build the prompt for the writer agent from the shared context.
   * Limits the number of files sent to avoid token budget issues.
   * When isRetry is true, uses a more explicit prompt.
   */
  private buildPrompt(context: AgentContext, isRetry: boolean = false): string {
    // Find the writer tasks in the plan
    const writerTask = context.taskPlan.find(
      (s) => s.agentType === 'writer' && s.status === 'running',
    );
    const taskDescription = writerTask?.description || context.goal;

    // Use token-budget-aware file selection: show as many files as possible
    // within MAX_CONTEXT_CHARS, prioritizing smaller files to max context.
    const filesToSend = this.selectFilesWithinBudget(context.artifacts, MAX_CONTEXT_CHARS);

    const fileContext = filesToSend.length > 0
      ? filesToSend
          .map(({ artifact, truncated }) =>
            `--- ${artifact.path} ---${truncated ? ` (truncated, ${artifact.content.length}\u2192${truncated.length} chars)` : ''}\n${truncated || artifact.content}`
          )
          .join('\n\n') +
        (context.artifacts.length > filesToSend.length
          ? `\n\n... and ${context.artifacts.length - filesToSend.length} more files in the project (excluded to fit token budget)`
          : '')
      : '(No files found in context — you may need to create new files)';

    const instructions = isRetry
      ? `\n## CRITICAL — Read This Carefully\nThe previous response could not be parsed because the files were not wrapped in correctly formatted code blocks.\n\nYou MUST follow this format EXACTLY for EACH file you modify:\n\n\`\`\`filepath:src/example.ts\n// THE COMPLETE UPDATED FILE CONTENT GOES HERE (every line, full file)\n\`\`\`\n\nIMPORTANT:\n- The filepath: prefix is REQUIRED after the opening backticks\n- Return the FULL file, not a diff or snippet\n- If you modify 2 files, return 2 separate code blocks in this format`
      : `\n## Instructions\nImplement the changes described in the task. Return the complete updated file content for each file you modify. Remember: each file must be wrapped in \`\`\`filepath:...\n\`\`\` format.`;

    return `${WRITER_SYSTEM_PROMPT}\n\n## Task Description\n${taskDescription}\n\n## Current File Content\n${fileContext}\n${instructions}`;
  }

  /**
   * Parse the LLM response to extract file changes.
   */
  private parseFileChanges(response: string, workingDir: string): FileChange[] {
    const changes: FileChange[] = [];

    // Match code blocks containing a real file path.
    const blockRegex = /```(?:[a-zA-Z0-9+#]*\s+)?(?:filepath:)?([^\n`]+(?:\.[a-zA-Z0-9]+|\/[^\n`]+))\n([\s\S]*?)```/g;
    let match: RegExpExecArray | null;

    while ((match = blockRegex.exec(response)) !== null) {
      let filePath = match[1].trim();
      const content = match[2].trim();

      // Clean up the file path (remove leading/trailing quotes, whitespace)
      filePath = filePath.replace(/^['"]|['"]$/g, '').trim();

      if (!filePath || !content) continue;

      this.addFileChange(changes, filePath, content, workingDir);
    }

    return changes;
  }

  /**
   * Select files within the given character budget.
   * Prioritizes smaller files first so the LLM sees as much complete context as possible.
   */
  private selectFilesWithinBudget(
    artifacts: import('../agent.js').Artifact[],
    budget: number,
  ): Array<{ artifact: import('../agent.js').Artifact; truncated: string | null }> {
    const sorted = [...artifacts]
      .map((a) => ({ artifact: a, size: a.content.length }))
      .sort((a, b) => a.size - b.size);

    const result: Array<{ artifact: import('../agent.js').Artifact; truncated: string | null }> = [];
    let used = 0;
    const OVERHEAD_PER_FILE = 50;

    for (const { artifact, size } of sorted) {
      if (result.length >= MAX_CONTEXT_FILES) break;

      const totalNeeded = size + OVERHEAD_PER_FILE;

      if (used + totalNeeded <= budget) {
        result.push({ artifact, truncated: null });
        used += totalNeeded;
      } else if (used + OVERHEAD_PER_FILE < budget) {
        const remaining = budget - used - OVERHEAD_PER_FILE;
        if (remaining > 200) {
          const truncated = artifact.content.slice(0, remaining);
          result.push({ artifact, truncated });
          used = budget;
        }
        break;
      } else {
        break;
      }
    }

    return result;
  }

  private addFileChange(
    changes: FileChange[],
    filePath: string,
    content: string,
    workingDir: string,
  ): void {
    const absolutePath = isAbsolute(filePath) ? filePath : `${workingDir}/${filePath}`;

    if (existsSync(absolutePath)) {
      const originalContent = readFileSync(absolutePath, 'utf-8');
      if (originalContent.trim() !== content.trim()) {
        changes.push({
          path: filePath,
          originalContent,
          newContent: content,
          status: 'modified',
        });
      }
    } else {
      changes.push({
        path: filePath,
        newContent: content,
        status: 'created',
      });
    }
  }
}
