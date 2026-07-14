/**
 * GitAgent — Manages git operations for the publishing pipeline.
 *
 * Capabilities:
 * - Create branches
 * - Commit changes with auto-generated commit messages (via LLM)
 * - Generate PR descriptions from git diff
 * - Check git status
 *
 * This agent does NOT require an LLM for basic operations (status, branch, commit),
 * but uses the LLM for generating commit messages and PR descriptions.
 *
 * Usage in task plans:
 * ```json
 * { "id": "step-commit", "description": "Commit changes to git", "agentType": "git", "dependsOn": ["step-write"] }
 * ```
 */

import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Agent, type AgentContext, type AgentResult } from '../agent.js';
import type { LLMCallFn } from '../agent.js';
import { logger } from '../../utils/logger.js';

const COMMIT_MESSAGE_PROMPT = `You are an expert at writing clear, conventional git commit messages.

Given the following git diff, write a concise commit message following conventional commits format:

<type>(<scope>): <description>

Types: feat, fix, refactor, docs, style, test, chore, perf, ci
Scope: the module/area affected (optional)

Rules:
- First line: max 72 characters
- Body: wrap at 72 characters, explain what and why, not how
- Use imperative mood ("add" not "added" / "adds")
- Be specific but concise

Return ONLY the commit message, nothing else.`;

/**
 * GitAgent — Handles git operations for the multi-agent pipeline.
 */
export class GitAgent extends Agent {
  readonly name = 'Git';
  readonly description = 'Manages git operations (branch, commit, PR)';

  async execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult> {
    try {
      const taskDesc = context.taskPlan.find(
        (s) => s.agentType === 'git' && s.status === 'running',
      )?.description || context.goal;

      // Parse the task to determine the git operation
      const operation = this.detectOperation(taskDesc);

      switch (operation) {
        case 'status':
          return this.gitStatus();
        case 'branch':
          return this.createBranch(context, taskDesc);
        case 'commit':
          return this.commit(context, callLLM);
        case 'pr-description':
          return this.generatePRDescription(context, callLLM);
        default:
          return this.commit(context, callLLM);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, summary: 'Git operation failed', error: msg };
    }
  }

  private detectOperation(description: string): string {
    const lower = description.toLowerCase();
    if (lower.includes('status') || lower.includes('check')) return 'status';
    if (lower.includes('branch') || lower.includes('checkout') || lower.includes('switch')) return 'branch';
    if (lower.includes('pr') || lower.includes('pull request') || lower.includes('description')) return 'pr-description';
    return 'commit';
  }

  private async gitStatus(): Promise<AgentResult> {
    const output = this.exec('git status --short');
    const lines = output.trim().split('\n').filter(Boolean);
    return {
      success: true,
      summary: `${lines.length} file(s) changed`,
      details: output,
    };
  }

  private async createBranch(context: AgentContext, description: string): Promise<AgentResult> {
    // Generate branch name from goal
    const sanitized = context.goal
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);
    const branchName = `feat/${sanitized}`;

    // Check if branch already exists
    const existing = this.exec(`git branch --list "${branchName}"`);
    if (existing.trim()) {
      return { success: true, summary: `Branch '${branchName}' already exists`, details: branchName };
    }

    this.exec(`git checkout -b "${branchName}"`);
    return { success: true, summary: `Created branch '${branchName}'`, details: branchName };
  }

  private async commit(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult> {
    // Stage all changes
    this.exec('git add -A');

    // Check if there's anything to commit
    const status = this.exec('git status --short');
    if (!status.trim()) {
      return { success: true, summary: 'No changes to commit' };
    }

    // Get the diff for the LLM to summarize
    const diff = this.exec('git diff --cached --stat');
    const fullDiff = this.exec('git diff --cached');

    // Generate commit message via LLM
    let commitMessage = '';
    try {
      const prompt = `${COMMIT_MESSAGE_PROMPT}\n\n## Diff Summary\n${diff}\n\n## Full Diff (truncated)\n${fullDiff.slice(0, 4000)}`;
      commitMessage = await callLLM(prompt, { temperature: 0.3, maxTokens: 500 });
      commitMessage = commitMessage.trim().replace(/^```[\s\S]*?\n|```$/g, '').trim();
    } catch {
      // Fallback: generate a simple commit message from the goal
      commitMessage = `feat: ${context.goal.slice(0, 60)}`;
    }

    // Ensure the commit message is valid
    if (!commitMessage || commitMessage.length < 5) {
      commitMessage = `feat: ${context.goal.slice(0, 60)}`;
    }

    // Write commit message to temp file to avoid shell quoting issues (cross-platform)
    const msgDir = mkdtempSync(join(tmpdir(), 'git-msg-'));
    const msgFile = join(msgDir, 'commit-msg.txt');
    writeFileSync(msgFile, commitMessage, 'utf-8');
    this.exec(`git commit -F "${msgFile}"`);
    try { unlinkSync(msgFile); } catch { /* best-effort */ }

    return {
      success: true,
      summary: `Committed with message: ${commitMessage.split('\n')[0].slice(0, 72)}`,
      details: commitMessage,
    };
  }

  private async generatePRDescription(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult> {
    const diff = this.exec('git diff main...HEAD --stat');
    const fullDiff = this.exec('git diff main...HEAD');

    const prompt = `Generate a GitHub pull request description from the following diff.

## Diff (truncated)
${fullDiff.slice(0, 4000)}

## Format
### Summary
[1-2 sentences describing the change]

### Changes
- [list of files changed and why]

### Testing
- [how to test this change]

### Related Issues
- [if applicable]`;

    let description: string;
    try {
      description = await callLLM(prompt, { temperature: 0.3, maxTokens: 1500 });
      description = description.trim();
    } catch {
      description = `## Changes\n${diff || 'No diff available'}\n\nAuto-generated by agent-baba-d.`;
    }

    return {
      success: true,
      summary: 'Generated PR description',
      details: description,
    };
  }

  private exec(command: string, cwd?: string): string {
    try {
      return execSync(command, {
        cwd: cwd || process.cwd(),
        timeout: 30_000,
        encoding: 'utf-8',
        stdio: 'pipe',
      });
    } catch (err) {
      const error = err as { stdout?: string; stderr?: string; message?: string };
      // Only swallow stderr for known non-fatal cases (e.g., no commits yet)
      // Re-throw for genuine command failures
      const msg = error.stderr || error.message || '';
      if (msg.includes('Command failed') || msg.includes('not found') || msg.includes('not a git repository')) {
        throw new Error(msg.slice(0, 200));
      }
      // Return available output (maybe partial git log worked)
      return error.stdout || msg;
    }
  }
}
