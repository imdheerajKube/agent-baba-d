/**
 * GitHubReleaseAgent — Creates GitHub releases with auto-generated changelogs.
 *
 * Capabilities:
 * - Create git tags (with optional signing)
 * - Generate release notes from git log between tags (via LLM)
 * - Create GitHub releases via `gh` CLI
 * - List existing releases and tags
 * - Detect version from package.json
 *
 * Requires: `gh` CLI installed and authenticated, or uses `github_api_key` env var.
 *
 * Usage in task plans:
 * ```json
 * { "id": "step-release", "description": "Create GitHub release for v1.2.0", "agentType": "github-release", "dependsOn": ["step-test"] }
 * ```
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

import { Agent, type AgentContext, type AgentResult } from '../agent.js';
import type { LLMCallFn } from '../agent.js';
import { logger } from '../../utils/logger.js';

interface GitHubReleaseOptions {
  tag: string;
  title: string;
  notes: string;
  prerelease?: boolean;
  draft?: boolean;
  targetCommitish?: string;
}

const RELEASE_NOTES_PROMPT = `You are generating GitHub release notes.

Given the following git log and tags, write professional release notes in markdown.

Format:
## [version] - YYYY-MM-DD

### 🚀 Features
- New features and user-facing improvements

### 🐛 Bug Fixes
- Bug fixes

### 🔧 Maintenance
- Refactoring, dependency updates, tooling

### 📚 Documentation
- Documentation changes

Group commits by type. For each entry, write a clear 1-line description.
Include PR/issue numbers if present in commit messages.
Return ONLY the release notes, nothing else.`;

/**
 * GitHubReleaseAgent — Creates GitHub releases with changelogs.
 */
export class GitHubReleaseAgent extends Agent {
  readonly name = 'GitHub Release';
  readonly description = 'Creates GitHub releases with auto-generated changelogs';

  async execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult> {
    try {
      const taskDesc = context.taskPlan.find(
        (s) => s.agentType === 'github-release' && s.status === 'running',
      )?.description || context.goal;

      const operation = this.detectOperation(taskDesc);

      switch (operation) {
        case 'tag':
          return this.createTag(context, taskDesc);
        case 'release':
          return this.createRelease(context, callLLM);
        case 'list':
          return this.listReleases();
        case 'notes':
          return this.generateReleaseNotes(context, callLLM);
        default:
          return this.createRelease(context, callLLM);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, summary: 'GitHub release operation failed', error: msg };
    }
  }

  private detectOperation(description: string): string {
    const lower = description.toLowerCase();
    if (lower.includes('tag') && !lower.includes('release')) return 'tag';
    if (lower.includes('release') || lower.includes('publish') || lower.includes('create release')) return 'release';
    if (lower.includes('list') || lower.includes('show')) return 'list';
    if (lower.includes('note') || lower.includes('changelog') || lower.includes('release note')) return 'notes';
    // Default: create a full release (tag + release)
    return 'release';
  }

  /**
   * Detect the version to use for the release.
   * Checks: task description → package.json → latest tag + 1
   */
  private detectVersion(description: string, context: AgentContext): string {
    // Check if the description contains a version
    const versionMatch = description.match(/v?\d+\.\d+\.\d+/);
    if (versionMatch) return versionMatch[0].replace(/^v/, '');

    // Check package.json
    const pkgPath = join(context.workingDirectory, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        if (pkg.version) return pkg.version;
      } catch {
        // Fall through
      }
    }

    // Try to read from git tags
    try {
      let lastTag = '0.0.0';
      try {
        lastTag = this.exec('git describe --tags --abbrev=0');
      } catch {
        // No tags yet — use default
      }
      const parts = lastTag.trim().replace(/^v/, '').split('.').map(Number);
      // Suggest next patch version
      return `${parts[0] || 0}.${parts[1] || 0}.${(parts[2] || 0) + 1}`;
    } catch {
      return '0.1.0';
    }
  }

  /**
   * Create a git tag for the release.
   */
  private async createTag(context: AgentContext, description: string): Promise<AgentResult> {
    const version = this.detectVersion(description, context);
    const tagName = `v${version}`;

    // Check if tag already exists
    try {
      const existing = this.exec(`git tag -l "${tagName}"`);
      if (existing.trim() === tagName) {
        return { success: true, summary: `Tag '${tagName}' already exists` };
      }
    } catch {
      // Continue
    }

    // Create the tag (annotated)
    this.exec(`git tag -a "${tagName}" -m "Release ${tagName}"`);

    return {
      success: true,
      summary: `Created tag '${tagName}'`,
      details: tagName,
    };
  }

  /**
   * Create a full GitHub release (tag + release notes + publish).
   */
  private async createRelease(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult> {
    const version = this.detectVersion(context.goal, context);
    const tagName = `v${version}`;

    // Step 1: Ensure the tag exists
    try {
      const existing = this.exec(`git tag -l "${tagName}"`);
      if (existing.trim() !== tagName) {
        this.exec(`git tag -a "${tagName}" -m "Release ${tagName}"`);
      }
    } catch {
      this.exec(`git tag -a "${tagName}" -m "Release ${tagName}"`);
    }

    // Step 2: Push tag to remote (optional, best-effort)
    try {
      this.exec(`git push origin "${tagName}"`);
    } catch {
      logger.debug('Could not push tag to remote (no remote configured or offline)');
    }

    // Step 3: Generate release notes
    let notes: string;
    try {
      notes = await this.generateNotesFromLog(tagName, callLLM);
    } catch {
      notes = this.generateNotesFallback(tagName);
    }

    // Step 4: Create the GitHub release
    const releaseOptions: GitHubReleaseOptions = {
      tag: tagName,
      title: `Release ${tagName}`,
      notes,
      prerelease: context.goal.toLowerCase().includes('prerelease') ||
                  context.goal.toLowerCase().includes('beta') ||
                  context.goal.toLowerCase().includes('alpha'),
      draft: context.goal.toLowerCase().includes('draft'),
    };

    // Try `gh` CLI first, then API fallback
    const result = await this.createViaCLI(releaseOptions);

    if (!result.success) {
      // Try API fallback with GITHUB_API_KEY env var
      return await this.createViaAPI(releaseOptions, context);
    }

    return result;
  }

  /**
   * Generate release notes from git log using the LLM.
   */
  private async generateReleaseNotes(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult> {
    const version = this.detectVersion(context.goal, context);
    const tagName = `v${version}`;

    try {
      const notes = await this.generateNotesFromLog(tagName, callLLM);

      // Store in a file for review
      const notesPath = join(context.workingDirectory, 'RELEASE_NOTES.md');
      const existingContent = existsSync(notesPath) ? readFileSync(notesPath, 'utf-8') + '\n\n---\n\n' : '';
      writeFileSync(notesPath, existingContent + notes, 'utf-8');

      return {
        success: true,
        summary: `Generated release notes for ${tagName}`,
        details: notes,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, summary: 'Release notes generation failed', error: msg };
    }
  }

  /**
   * List existing releases.
   */
  private async listReleases(): Promise<AgentResult> {
    try {
      const output = this.exec('gh release list --limit 10 2>&1');
      const lines = output.trim().split('\n').filter(Boolean);
      return {
        success: true,
        summary: `${lines.length} release(s) found`,
        details: output,
      };
    } catch {
      try {
        // Fallback: list tags
        const tags = this.exec('git tag --sort=-version:refname');
        const lines = tags.trim().split('\n').filter(Boolean).slice(0, 10);
        return {
          success: true,
          summary: `${lines.length} tag(s) found (gh CLI not available)`,
          details: lines.join('\n'),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, summary: 'Failed to list releases', error: msg };
      }
    }
  }

  // ─── Private Helpers ──────────────────────────────────────────────────

  private async generateNotesFromLog(tagName: string, callLLM: LLMCallFn): Promise<string> {
    // Get git log since previous tag (or since the beginning)
    let log: string;
    try {
      let prevTag: string;
      try {
        prevTag = this.exec('git describe --tags --abbrev=0 HEAD~1');
      } catch {
        // No previous tag — get first commit instead
        prevTag = this.exec('git rev-list --max-parents=0 HEAD');
      }
      log = this.exec(`git log ${prevTag.trim()}..HEAD --oneline --no-decorate 2>&1`);
    } catch {
      log = this.exec('git log --oneline --no-decorate -20 2>&1');
    }

    const logLines = log.trim().split('\n').filter(Boolean);

    if (logLines.length === 0) {
      return this.generateNotesFallback(tagName);
    }

    const prompt = `${RELEASE_NOTES_PROMPT}\n\n## Git Log (${logLines.length} commits)\n${log}`;

    try {
      let notes = await callLLM(prompt, { temperature: 0.3, maxTokens: 1500 });
      notes = notes.trim().replace(/^```[\s\S]*?\n|```$/g, '').trim();
      return notes;
    } catch {
      return this.generateNotesFallback(tagName);
    }
  }

  private generateNotesFallback(tagName: string): string {
    const date = new Date().toISOString().split('T')[0];
    try {
      const log = this.exec('git log --oneline --no-decorate -15 2>&1');
      const commits = log.trim().split('\n').filter(Boolean);
      return [
        `## ${tagName} - ${date}`,
        '',
        '### Changes',
        ...commits.map((c) => `- ${c}`),
        '',
        '---',
        'Auto-generated by agent-baba-d.',
      ].join('\n');
    } catch {
      return `## ${tagName} - ${date}\n\nRelease ${tagName}.`;
    }
  }

  /**
   * Create a GitHub release via the `gh` CLI.
   */
  private async createViaCLI(options: GitHubReleaseOptions): Promise<AgentResult> {
    try {
      const notesDir = mkdtempSync(join(tmpdir(), 'gh-notes-'));
      const notesFile = join(notesDir, 'release-notes.md');
      writeFileSync(notesFile, options.notes, 'utf-8');

      const targetBranch = options.targetCommitish || this.detectCurrentBranch();

      const args = [
        'gh release create',
        options.tag,
        '--title', options.title,
        '--notes-file', notesFile,
        '--target', targetBranch,
        options.prerelease ? '--prerelease' : '',
        options.draft ? '--draft' : '',
      ].filter(Boolean).join(' ');

      const output = this.exec(`${args} 2>&1`);

      // Clean up temp file
      try {
        unlinkSync(notesFile);
      } catch {
        // Best-effort cleanup
      }

      return {
        success: true,
        summary: `Created release '${options.tag}' on GitHub`,
        details: output,
      };
    } catch (err) {
      const error = err as { stdout?: string; stderr?: string; message?: string };
      const msg = error.stderr || error.message || '';
      // Return the failure so the caller can try the API fallback
      throw new Error(`gh CLI failed: ${msg.slice(0, 200)}`);
    }
  }

  /**
   * Create a GitHub release via the API (fallback when gh CLI is not available).
   */
  private async createViaAPI(options: GitHubReleaseOptions, context: AgentContext): Promise<AgentResult> {
    // Try to get token from env or metadata
    const token = process.env.GITHUB_API_KEY ||
                  process.env.GH_TOKEN ||
                  context.metadata?.githubApiKey as string | undefined;

    if (!token) {
      return {
        success: false,
        summary: 'Cannot create release: no GitHub token or gh CLI available',
        error: 'Set GITHUB_API_KEY or GH_TOKEN env var, or install gh CLI',
      };
    }

    // Get repo info from git remote
    let repo: string;
    try {
      const remote = this.exec('git remote get-url origin 2>&1');
      // Parse owner/repo from git URL
      const match = remote.match(/github\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?$/);
      if (match) {
        repo = match[1];
      } else {
        return { success: false, summary: 'Could not detect GitHub repo from git remote', error: remote };
      }
    } catch (err) {
      return { success: false, summary: 'No git remote configured', error: String(err) };
    }

    try {
      const response = await fetch(
        `https://api.github.com/repos/${repo}/releases`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Accept': 'application/vnd.github.v3+json',
          },
          body: JSON.stringify({
            tag_name: options.tag,
            target_commitish: options.targetCommitish || this.detectCurrentBranch(),
            name: options.title,
            body: options.notes,
            draft: options.draft || false,
            prerelease: options.prerelease || false,
          }),
        },
      );

      if (!response.ok) {
        const errorBody = await response.text();
        return {
          success: false,
          summary: 'GitHub API request failed',
          error: `HTTP ${response.status}: ${errorBody.slice(0, 300)}`,
        };
      }

      const data = await response.json() as { html_url?: string };
      return {
        success: true,
        summary: `Created release '${options.tag}' on GitHub`,
        details: data.html_url,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, summary: 'GitHub API call failed', error: msg };
    }
  }

  /**
   * Detect the current git branch name.
   */
  private detectCurrentBranch(): string {
    try {
      return this.exec('git rev-parse --abbrev-ref HEAD').trim();
    } catch {
      return 'main';
    }
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
      const msg = error.stderr || error.message || '';
      if (msg.includes('Command failed') || msg.includes('not found') || msg.includes('not a git repository')) {
        throw new Error(msg.slice(0, 200));
      }
      return error.stdout || msg;
    }
  }
}
