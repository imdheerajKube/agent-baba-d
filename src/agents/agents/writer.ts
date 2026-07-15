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

import { Agent, type AgentContext, type AgentResult, type FileChange } from '../agent.js';
import type { LLMCallFn } from '../agent.js';
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

/** Base delay for exponential backoff in milliseconds (doubles each retry: 1s, 2s) */
const BASE_RETRY_DELAY_MS = 1000;

/**
 * WriterAgent — Proposes code changes by reading files, generating new versions
 * via the LLM, and storing FileChange objects in the shared context.
 * Does NOT write to disk directly; the orchestrator handles that.
 *
 * Retry strategy:
 * 1. API errors (rate limits, timeouts): retry with exponential backoff (1s, 2s)
 * 2. Empty parse results (format issue): retry once with stricter prompt instructions
 */
export class WriterAgent extends Agent {
  readonly name = 'Writer';
  readonly description = 'Generates code changes based on the plan and context';

  async execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult> {
    let lastError: string | undefined;

    // Outer retry loop: handles transient API errors (rate limits, timeouts)
    for (let attempt = 0; attempt <= MAX_API_RETRIES; attempt++) {
      try {
        const result = await this.attemptWrite(context, callLLM);

        // Inner retry: handles empty parse results (format issue)
        // This runs on EVERY API attempt — API errors and format issues are independent.
        // The format retry always returns (success or note), so no infinite loop risk.
        if (result.success && result.summary === 'No files needed changes') {
          // Retry once with stricter format instructions
          const retryResult = await this.attemptWrite(context, callLLM, true);

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

        // Check if this is a transient API error worth retrying
        if (attempt < MAX_API_RETRIES) {
          const delayMs = BASE_RETRY_DELAY_MS * Math.pow(2, attempt); // 1s, 2s
          logger.warn(
            `Writer API error (attempt ${attempt + 1}/${MAX_API_RETRIES + 1}): ` +
            `${lastError.slice(0, 200)}. Retrying in ${delayMs}ms...`,
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
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
      logger.debug(`[Writer ${label}]   ${fc.status === 'created' ? '📄' : '✏️'} ${fc.path} (${(fc.newContent || '').length} chars)`);
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
          const icon = c.status === 'created' ? '📄' : '✏️';
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
            `--- ${artifact.path} ---${truncated ? ` (truncated, ${artifact.content.length}→${truncated.length} chars)` : ''}\n${truncated || artifact.content}`
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
   *
   * Expected format:
   * - ```filepath:path/to/file.ts\ncontent\n```
   * - ```typescript filepath:path/to/file.ts\ncontent\n```
   * - ```path/to/file.ts\ncontent\n```
   *
   * The regex requires the captured path to contain either a dot (file extension)
   * or a slash (directory separator), which naturally skips bare language tags
   * like ```typescript without a file path.
   */
  private parseFileChanges(response: string, workingDir: string): FileChange[] {
    const changes: FileChange[] = [];

    // Match code blocks containing a real file path.
    // The path must have either: `.ext` (file extension) or `/` (directory separator).
    // This naturally skips bare language tags like ```typescript without file paths.
    // Groups: 1 = file path, 2 = content
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
   * Larger files are truncated to fit within the remaining budget.
   */
  private selectFilesWithinBudget(
    artifacts: import('../agent.js').Artifact[],
    budget: number,
  ): Array<{ artifact: import('../agent.js').Artifact; truncated: string | null }> {
    // Sort by size ascending (smallest first)
    const sorted = [...artifacts]
      .map((a) => ({ artifact: a, size: a.content.length }))
      .sort((a, b) => a.size - b.size);

    const result: Array<{ artifact: import('../agent.js').Artifact; truncated: string | null }> = [];
    let used = 0;

    // Track overhead per file (header lines like "--- path.ts ---\n")
    const OVERHEAD_PER_FILE = 50;

    for (const { artifact, size } of sorted) {
      if (result.length >= MAX_CONTEXT_FILES) break;

      const totalNeeded = size + OVERHEAD_PER_FILE;

      if (used + totalNeeded <= budget) {
        // File fits entirely
        result.push({ artifact, truncated: null });
        used += totalNeeded;
      } else if (used + OVERHEAD_PER_FILE < budget) {
        // File doesn't fit entirely, but we can show a truncated version
        const remaining = budget - used - OVERHEAD_PER_FILE;
        if (remaining > 200) {
          // Only include if we can show at least 200 meaningful chars
          const truncated = artifact.content.slice(0, remaining);
          result.push({ artifact, truncated });
          used = budget; // Budget exhausted
        }
        break;
      } else {
        // No budget left
        break;
      }
    }

    return result;
  }

  /**
   * Add a file change if the content differs from the existing file.
   */
  private addFileChange(
    changes: FileChange[],
    filePath: string,
    content: string,
    workingDir: string,
  ): void {
    const absolutePath = isAbsolute(filePath) ? filePath : `${workingDir}/${filePath}`;

    if (existsSync(absolutePath)) {
      const originalContent = readFileSync(absolutePath, 'utf-8');
      // Only add if content actually changed
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
