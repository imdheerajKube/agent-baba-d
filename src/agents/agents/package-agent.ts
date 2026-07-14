/**
 * PackageAgent — Manages npm package operations for the publishing pipeline.
 *
 * Capabilities:
 * - Bump version (patch, minor, major)
 * - Build project
 * - Generate changelog from git log
 * - Publish to npm
 *
 * Usage in task plans:
 * ```json
 * { "id": "step-publish", "description": "Bump version and publish to npm", "agentType": "package", "dependsOn": ["step-test"] }
 * ```
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

import { Agent, type AgentContext, type AgentResult } from '../agent.js';
import type { LLMCallFn } from '../agent.js';

const CHANGELOG_PROMPT = `You are generating a changelog entry.

Given the following git log between two tags/revisions, write a concise changelog entry.

Format:
## [version] - YYYY-MM-DD

### Added
- new features

### Changed
- changes in existing functionality

### Fixed
- bug fixes

### Removed
- removed features

Group commits by type. Use present tense, be specific. Return ONLY the changelog entry.`;

/**
 * PackageAgent — Manages npm package versioning, building, and publishing.
 */
export class PackageAgent extends Agent {
  readonly name = 'Package';
  readonly description = 'Manages package version, build, and npm publish';

  async execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult> {
    try {
      const taskDesc = context.taskPlan.find(
        (s) => s.agentType === 'package' && s.status === 'running',
      )?.description || context.goal;

      const operation = this.detectOperation(taskDesc);

      switch (operation) {
        case 'version':
          return this.bumpVersion(context, taskDesc);
        case 'build':
          return this.build();
        case 'publish':
          return this.publish();
        case 'changelog':
          return this.generateChangelog(callLLM);
        default:
          return this.bumpVersion(context, taskDesc);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, summary: 'Package operation failed', error: msg };
    }
  }

  private detectOperation(description: string): string {
    const lower = description.toLowerCase();
    if (lower.includes('version') || lower.includes('bump') || lower.includes('patch') || lower.includes('minor') || lower.includes('major')) return 'version';
    if (lower.includes('build') || lower.includes('compile') || lower.includes('dist')) return 'build';
    if (lower.includes('publish') || lower.includes('release') || lower.includes('deploy')) return 'publish';
    if (lower.includes('changelog') || lower.includes('change log') || lower.includes('log')) return 'changelog';
    return 'version';
  }

  private detectBumpType(description: string): 'patch' | 'minor' | 'major' {
    const lower = description.toLowerCase();
    if (lower.includes('major')) return 'major';
    if (lower.includes('minor')) return 'minor';
    return 'patch';
  }

  private async bumpVersion(context: AgentContext, description: string): Promise<AgentResult> {
    const pkgPath = join(context.workingDirectory, 'package.json');

    if (!existsSync(pkgPath)) {
      return { success: false, summary: 'No package.json found', error: 'Cannot bump version without package.json' };
    }

    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const currentVersion = pkg.version || '0.0.0';
    const parts = currentVersion.split('.').map(Number);
    const bumpType = this.detectBumpType(description);

    // Bump version
    switch (bumpType) {
      case 'major':
        parts[0] = (parts[0] || 0) + 1;
        parts[1] = 0;
        parts[2] = 0;
        break;
      case 'minor':
        parts[1] = (parts[1] || 0) + 1;
        parts[2] = 0;
        break;
      case 'patch':
        parts[2] = (parts[2] || 0) + 1;
        break;
    }

    const newVersion = parts.join('.');
    pkg.version = newVersion;

    // Write updated package.json
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');

    return {
      success: true,
      summary: `Bumped version: ${currentVersion} → ${newVersion} (${bumpType})`,
    };
  }

  private async build(): Promise<AgentResult> {
    try {
      const output = execSync('npm run build 2>&1', {
        cwd: process.cwd(),
        timeout: 120_000,
        encoding: 'utf-8',
        stdio: 'pipe',
      });

      return {
        success: true,
        summary: 'Build completed successfully',
        details: output.slice(0, 1000),
      };
    } catch (err) {
      const error = err as { stdout?: string; stderr?: string; message?: string };
      return {
        success: false,
        summary: 'Build failed',
        error: error.stderr || error.message || 'Unknown build error',
      };
    }
  }

  private async publish(): Promise<AgentResult> {
    try {
      const output = execSync('npm publish 2>&1', {
        cwd: process.cwd(),
        timeout: 120_000,
        encoding: 'utf-8',
        stdio: 'pipe',
      });

      return {
        success: true,
        summary: 'Published to npm successfully',
        details: output,
      };
    } catch (err) {
      const error = err as { stdout?: string; stderr?: string; message?: string };
      return {
        success: false,
        summary: 'npm publish failed',
        error: this.parseNpmError(error),
      };
    }
  }

  private async generateChangelog(callLLM: LLMCallFn): Promise<AgentResult> {
    try {
      // Get git log since last tag
      const log = this.exec('git log --oneline --no-decorate $(git describe --tags --abbrev=0 2>/dev/null || git rev-list --max-parents=0 HEAD)..HEAD 2>&1');
      const logLines = log.trim().split('\n').filter(Boolean);

      if (logLines.length === 0) {
        return { success: true, summary: 'No new commits since last tag', details: 'Changelog is empty' };
      }

      const prompt = `${CHANGELOG_PROMPT}\n\n## Git Log\n${log}`;

      let changelogEntry: string;
      try {
        changelogEntry = await callLLM(prompt, { temperature: 0.3, maxTokens: 1000 });
        changelogEntry = changelogEntry.trim().replace(/^```[\s\S]*?\n|```$/g, '').trim();
      } catch {
        changelogEntry = `## [Unreleased]\n${logLines.map((l) => `- ${l}`).join('\n')}`;
      }

      // Try to prepend to CHANGELOG.md
      const changelogPath = join(process.cwd(), 'CHANGELOG.md');
      let existingContent = '';
      if (existsSync(changelogPath)) {
        existingContent = readFileSync(changelogPath, 'utf-8');
      }

      const newContent = changelogEntry + '\n\n' + existingContent;
      writeFileSync(changelogPath, newContent, 'utf-8');

      return {
        success: true,
        summary: `Generated changelog with ${logLines.length} commit(s)`,
        details: changelogEntry,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, summary: 'Changelog generation failed', error: msg };
    }
  }

  private parseNpmError(error: { stdout?: string; stderr?: string; message?: string }): string {
    const msg = error.stderr || error.message || '';
    if (msg.includes('E403')) return 'Not authorized — check npm login and token';
    if (msg.includes('E404')) return 'Package not found — check package name';
    if (msg.includes('E402')) return 'Payment required — check npm account';
    if (msg.includes('unpaid')) return 'Unpaid account — complete npm payment setup';
    return msg.slice(0, 300);
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
      if (msg.includes('Command failed') || msg.includes('not found')) {
        throw new Error(msg.slice(0, 200));
      }
      return error.stdout || msg;
    }
  }
}
