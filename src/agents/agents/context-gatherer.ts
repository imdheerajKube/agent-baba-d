/**
 * ContextGathererAgent — Scans the codebase to find files relevant to the user's
 * goal and execution plan. It reads file contents and stores them as artifacts
 * in the shared context bus for downstream agents (Writer, Reviewer) to use.
 *
 * Rate-limit handling:
 * - Short waits (<3s): auto-retry silently
 * - Long waits (>=3s): invokes onRateLimit callback (if available) to let the
 *   user choose: wait, switch model, skip (falls back to keyword scan), or abort
 * - Other LLM errors: caught gracefully, falls back to keyword scanning
 */

import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { Agent, type AgentContext, type AgentResult, type Artifact } from '../agent.js';
import type { LLMCallFn } from '../agent.js';
import { buildProjectFileTree, truncateTree } from '../utils/file-tree.js';
import { logger } from '../../utils/logger.js';

/** File extensions we consider as source code */
const SOURCE_EXTENSIONS = new Set([
  '.ts', '.js', '.tsx', '.jsx',
  '.go', '.py', '.rs', '.rb', '.java', '.kt',
  '.json', '.yaml', '.yml', '.md', '.toml', '.xml',
  '.css', '.scss', '.html', '.vue', '.svelte',
]);

/** Directories to skip during traversal */
const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next',
  '.cache', 'coverage', '.nyc_output', '__pycache__',
  '.venv', 'venv', '.env',
]);

/** Maximum number of API retry attempts for transient LLM failures (rate limits, timeouts) */
const MAX_API_RETRIES = 2;

/** Base delay for exponential backoff in milliseconds (doubles each retry: 5s, 10s) */
const BASE_RETRY_DELAY_MS = 5000;

/** Threshold above which we consider a rate-limit wait "long" and prompt the user. */
const LONG_WAIT_THRESHOLD_MS = 3000;

// ─── Rate-limit Helpers ────────────────────────────────────────────────────

function parseRetryAfterHint(errorMessage: string): number | null {
  const secondMatch = errorMessage.match(/try again in ([\d.]+)s/i);
  if (secondMatch) {
    const seconds = parseFloat(secondMatch[1]);
    if (!isNaN(seconds) && seconds > 0) return Math.ceil(seconds * 1000);
  }
  const msMatch = errorMessage.match(/try again in (\d+)ms/i);
  if (msMatch) {
    const ms = parseInt(msMatch[1], 10);
    if (!isNaN(ms) && ms > 0) return ms;
  }
  return null;
}

function parseModelName(errorMessage: string): string | undefined {
  const match = errorMessage.match(/model\s+`([^`]+)`|model\s+'([^']+)'|model\s+([^\s]+)/i);
  return match?.[1] || match?.[2] || match?.[3] || undefined;
}

function isRateLimitError(errorMessage: string): boolean {
  return /rate\s*limit|429|too many requests|try again in/i.test(errorMessage);
}

/**
 * ContextGathererAgent — Discovers and reads relevant files from the codebase.
 */
export class ContextGathererAgent extends Agent {
  readonly name = 'Context Gatherer';
  readonly description = 'Scans the codebase and identifies relevant files';

  async execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult> {
    try {
      // 1. Get a broad overview of the project structure
      const fileTree = await buildProjectFileTree(context.workingDirectory);

      // 2. Ask the LLM which files are relevant — with retry and rate-limit handling
      const { paths: relevantPaths, llmError } = await this.identifyWithRetry(
        context,
        fileTree,
        callLLM,
      );

      // 3. Fallback: if LLM returned nothing or errored, try keyword scanning
      if (llmError) {
        logger.debug(`LLM call failed: ${llmError}`);
      }

      let effectivePaths = relevantPaths;
      if (relevantPaths.length === 0) {
        if (llmError) {
          logger.warn(`   LLM error: ${llmError}`);
        }
        effectivePaths = this.scanByKeywords(context.goal, context.workingDirectory);
      }

      // 4. Read the identified files
      const artifacts: Artifact[] = [];
      const errors: string[] = [];

      if (llmError && effectivePaths.length > 0) {
        logger.debug(`Keywords matched ${effectivePaths.length} file(s) after LLM error`);
      }

      for (const filePath of effectivePaths) {
        const absolutePath = join(context.workingDirectory, filePath);
        if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
          errors.push(`File not found: ${filePath}`);
          continue;
        }

        try {
          const content = readFileSync(absolutePath, 'utf-8');
          artifacts.push({
            path: filePath,
            content,
            description: `${filePath} (${this.formatSize(content.length)} characters)`,
          });
        } catch {
          errors.push(`Could not read: ${filePath}`);
        }
      }

      // 5. Store artifacts in the shared context
      context.artifacts.push(...artifacts);

      const details = artifacts.length > 0
        ? artifacts.map((a) => `  \u{1F4C4} ${a.path}`).join('\n')
        : undefined;

      const resultSummary = artifacts.length > 0
        ? `Gathered ${artifacts.length} file${artifacts.length !== 1 ? 's' : ''}`
        : `No relevant files found${errors.length > 0 ? ` (${errors.length} errors while scanning)` : ''}`;

      return {
        success: true,
        summary: resultSummary,
        details,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        summary: 'Context gathering failed',
        error: msg,
      };
    }
  }

  /**
   * Call identifyRelevantFiles with a retry loop that handles rate-limit errors
   * via the onRateLimit callback.
   */
  private async identifyWithRetry(
    context: AgentContext,
    fileTree: string,
    callLLM: LLMCallFn,
  ): Promise<{ paths: string[]; llmError?: string }> {
    let latestCallLLM = callLLM;
    let lastError: string | undefined;

    for (let attempt = 0; attempt <= MAX_API_RETRIES; attempt++) {
      try {
        // identifyRelevantFiles re-throws rate-limit errors so we can handle them here
        const result = await this.identifyRelevantFiles(
          context.goal,
          context.taskPlan,
          fileTree,
          latestCallLLM,
        );
        // Success or non-rate-limit error (caught internally by identifyRelevantFiles)
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);

        // ── Rate-limit handling with user prompt ─────────────────────
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
              // User wants to abort — return failure
              return {
                paths: [],
                llmError: `Aborted by user: ${lastError}`,
              };
            }

            if (action.action === 'skip') {
              // User wants to skip — fall through to keyword scanning
              logger.info('Context-gatherer LLM call skipped by user');
              return { paths: [], llmError: undefined };
            }

            if (action.action === 'switch-model') {
              // Switch model and retry immediately
              logger.info('Switching model for context gathering per user request...');
              latestCallLLM = action.callLLM;
              await new Promise((resolve) => setTimeout(resolve, 500));
              continue;
            }

            // 'retry': wait and retry
            logger.warn(
              `Context-gatherer rate limited. Waiting ${(retryAfterMs / 1000).toFixed(1)}s as chosen by user...`,
            );
            await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
            continue;
          }
          // Short wait: fall through to auto-retry below
        }

        // ── Standard retry for transient errors ──────────────────────
        if (attempt < MAX_API_RETRIES) {
          const delayMs = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
          if (isRateLimitError(lastError)) {
            logger.warn(
              `Context-gatherer API error (attempt ${attempt + 1}/${MAX_API_RETRIES + 1}): ` +
              `${lastError.slice(0, 200)}. Waiting ${(delayMs / 1000).toFixed(1)}s...`,
            );
          } else {
            logger.warn(
              `Context-gatherer API error (attempt ${attempt + 1}/${MAX_API_RETRIES + 1}): ` +
              `${lastError.slice(0, 200)}. Retrying...`,
            );
          }
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        // All retries exhausted
        logger.warn(`Context-gatherer LLM unavailable after retries: ${lastError}`);
        return { paths: [], llmError: lastError };
      }
    }

    // Fallback
    return { paths: [], llmError: lastError || 'Unknown error' };
  }

  /**
   * Ask the LLM to identify which files are relevant to the goal.
   * Non-rate-limit errors are caught internally (falls back to keyword scanning).
   * Rate-limit errors are re-thrown so identifyWithRetry can handle them.
   */
  private async identifyRelevantFiles(
    goal: string,
    taskPlan: AgentContext['taskPlan'],
    fileTree: string,
    callLLM: LLMCallFn,
  ): Promise<{ paths: string[]; llmError?: string }> {
    const taskDescriptions = taskPlan
      .filter((s) => s.status !== 'failed')
      .map((s) => `  - ${s.description}`)
      .join('\n');

    // Limit file tree to avoid token overflow on large projects
    const truncatedTree = truncateTree(fileTree, 80);

    const prompt = [
      'You are a codebase navigation expert. Identify files relevant to the task.',
      '',
      'Project files:',
      truncatedTree || '(empty directory)',
      '',
      `Goal: ${goal}`,
      taskDescriptions ? `Plan: ${taskDescriptions}` : '',
      '',
      'Return ONLY a valid JSON array of file paths. Example:',
      '["src/index.ts", "package.json"]',
      '',
      'Rules:',
      '- Only include files shown in the project listing above',
      '- Include config files (package.json, tsconfig.json) when relevant',
      '- Max 10 files',
      '- NO explanation text before or after the JSON',
    ].filter(Boolean).join('\n');

    try {
      const response = await callLLM(prompt, {
        temperature: 0.1,
        maxTokens: 1024,
      });

      const paths = this.extractPaths(response);
      return { paths };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Let rate-limit errors propagate so the retry loop can handle them
      if (isRateLimitError(msg)) {
        throw err;
      }
      // Other errors: gracefully return with error flag (falls back to keyword scanning)
      return { paths: [], llmError: msg };
    }
  }

  /**
   * Extract an array of file paths from the LLM response.
   */
  private extractPaths(response: string): string[] {
    const trimmed = response.trim();

    const fromJson = this.tryParseJson(trimmed);
    if (fromJson.length > 0) return fromJson;

    const jsonBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (jsonBlockMatch) {
      const fromBlock = this.tryParseJson(jsonBlockMatch[1].trim());
      if (fromBlock.length > 0) return fromBlock;
    }

    const arrayMatch = trimmed.match(/\[[\s\S]*?\]/);
    if (arrayMatch) {
      const fromArray = this.tryParseJson(arrayMatch[0]);
      if (fromArray.length > 0) return fromArray;
    }

    const lines = trimmed.split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('`') && !l.startsWith('#'))
      .map((l) => l.replace(/^[-*\d.\s]+/, '').trim())
      .filter((l) => l.includes('.') || l.includes('/'))
      .filter((l) => l.length < 200);

    if (lines.length > 0) {
      const validPaths = lines.filter((l) => !l.includes(' ') && !l.includes('```'));
      if (validPaths.length > 0) return validPaths;
    }

    return [];
  }

  private tryParseJson(text: string): string[] {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return parsed.filter((p): p is string => typeof p === 'string');
      }
    } catch {
      // Not valid JSON
    }
    return [];
  }

  /** Fallback keyword-based file scanning when LLM is unavailable */
  private scanByKeywords(goal: string, workingDir: string): string[] {
    const stopWords = new Set([
      'the', 'a', 'an', 'in', 'to', 'for', 'of', 'and', 'or', 'is',
      'add', 'fix', 'update', 'change', 'remove', 'create', 'implement',
      'with', 'on', 'at', 'by', 'from', 'as', 'be', 'this', 'that',
    ]);
    const keywords = goal
      .toLowerCase()
      .split(/[\s,.-]+/)
      .filter((w) => w.length > 2 && !stopWords.has(w));

    if (keywords.length === 0) return [];

    const scored = this.walkAndScore(workingDir, keywords, 0);
    return scored
      .sort((a, b) => b.score - a.score)
      .filter((s) => s.score > 0)
      .slice(0, 5)
      .map((s) => s.path);
  }

  private walkAndScore(
    dir: string,
    keywords: string[],
    depth: number,
    baseDir?: string,
  ): Array<{ path: string; score: number }> {
    const root = baseDir ?? dir;
    if (depth > 5) return [];

    const results: Array<{ path: string; score: number }> = [];
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry.name)) continue;

      const entryPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        const subResults = this.walkAndScore(entryPath, keywords, depth + 1, root);
        results.push(...subResults);
      } else if (entry.isFile()) {
        const ext = entry.name.slice(entry.name.lastIndexOf('.'));
        if (!SOURCE_EXTENSIONS.has(ext)) continue;

        let score = 0;
        const lowerName = entry.name.toLowerCase();
        const lowerPath = entryPath.toLowerCase();

        for (const kw of keywords) {
          if (lowerName.includes(kw)) score += 3;
          else if (lowerPath.includes(kw)) score += 1;
        }

        if (score > 0) {
          const relPath = relative(root, entryPath);
          results.push({ path: relPath, score });
        }
      }
    }

    return results;
  }

  private formatSize(bytes: number): string {
    if (bytes < 1024) return String(bytes);
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}k`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
  }
}
