/**
 * ContextGathererAgent — Scans the codebase to find files relevant to the user's
 * goal and execution plan. It reads file contents and stores them as artifacts
 * in the shared context bus for downstream agents (Writer, Reviewer) to use.
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

/**
 * ContextGathererAgent — Discovers and reads relevant files from the codebase.
 */
export class ContextGathererAgent extends Agent {
  readonly name = 'Context Gatherer';
  readonly description = 'Scans the codebase and identifies relevant files';

  async execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult> {
    try {
      // 1. Get a broad overview of the project structure (uses shared utility)
      const fileTree = await buildProjectFileTree(context.workingDirectory);

      // 2. Ask the LLM which files are relevant to the goal
      const { paths: relevantPaths, llmError } = await this.identifyRelevantFiles(
        context.goal,
        context.taskPlan,
        fileTree,
        callLLM,
      );

      // 3. Fallback: if LLM returned nothing or errored, log and try keyword scanning
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

      const summary = artifacts.length > 0
        ? `Gathered ${artifacts.length} file${artifacts.length !== 1 ? 's' : ''}`
        : 'No relevant files found';

      const details = artifacts.length > 0
        ? artifacts.map((a) => `  \u{1F4C4} ${a.path}`).join('\n')
        : undefined;

      const overallSuccess = artifacts.length > 0;
      return {
        success: overallSuccess,
        summary: overallSuccess ? summary : `Found no relevant files${errors.length > 0 ? ` (${errors.length} errors)` : ''}`,
        details: overallSuccess ? details : undefined,
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
   * Ask the LLM to identify which files are relevant to the goal.
   * Returns relative file paths and any LLM error that occurred.
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
      // Surface the LLM error so callers can log it and users can debug
      const msg = err instanceof Error ? err.message : String(err);
      return { paths: [], llmError: msg };
    }
  }

  /**
   * Extract an array of file paths from the LLM response.
   * Tries multiple parsing strategies in order.
   */
  private extractPaths(response: string): string[] {
    const trimmed = response.trim();

    // Strategy 1: Direct JSON parse
    const fromJson = this.tryParseJson(trimmed);
    if (fromJson.length > 0) return fromJson;

    // Strategy 2: Extract from ```json code block
    const jsonBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (jsonBlockMatch) {
      const fromBlock = this.tryParseJson(jsonBlockMatch[1].trim());
      if (fromBlock.length > 0) return fromBlock;
    }

    // Strategy 3: Find any JSON array in the response
    const arrayMatch = trimmed.match(/\[[\s\S]*?\]/);
    if (arrayMatch) {
      const fromArray = this.tryParseJson(arrayMatch[0]);
      if (fromArray.length > 0) return fromArray;
    }

    // Strategy 4: Newline-separated paths (one per line, no brackets/quotes)
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

  /**
   * Try to parse a string as a JSON array of strings.
   */
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

  /**
   * Fallback: scan the project for files whose names or paths match keywords
   * from the user's goal. This is used when the LLM call fails or returns
   * unparseable results.
   */
  private scanByKeywords(goal: string, workingDir: string): string[] {
    // Extract meaningful keywords from the goal (lowercased, filter stop words)
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

    // Walk the project and score files by keyword matches
    const scored = this.walkAndScore(workingDir, keywords, 0);
    // Sort by score descending, return paths
    return scored
      .sort((a, b) => b.score - a.score)
      .filter((s) => s.score > 0)
      .slice(0, 5)
      .map((s) => s.path);
  }

  /**
   * Recursively walk a directory and score files by keyword matches in their names and paths.
   */
  private walkAndScore(
    dir: string,
    keywords: string[],
    depth: number,
    baseDir?: string,
  ): Array<{ path: string; score: number }> {
    const root = baseDir ?? dir;
    if (depth > 5) return []; // Limit depth to avoid scanning too deep

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

  /** Format byte count into human-readable size */
  private formatSize(bytes: number): string {
    if (bytes < 1024) return String(bytes);
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}k`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
  }
}
