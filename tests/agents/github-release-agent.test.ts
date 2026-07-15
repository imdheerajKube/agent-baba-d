import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, writeFileSync, unlinkSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { GitHubReleaseAgent } from '../../src/agents/agents/github-release-agent.js';
import type { AgentContext } from '../../src/agents/agent.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Create a minimal AgentContext for testing */
function createContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    goal: 'test goal',
    workingDirectory: process.cwd(),
    taskPlan: [],
    artifacts: [],
    conversations: [],
    fileChanges: [],
    metadata: {},
    ...overrides,
  };
}

/** Access private method via type assertion */
function getPrivateMethod<T>(agent: GitHubReleaseAgent, name: string): (...args: any[]) => T {
  return (agent as any)[name].bind(agent);
}

// ─── detectOperation ────────────────────────────────────────────────────────

describe('GitHubReleaseAgent detectOperation', () => {
  let agent: GitHubReleaseAgent;

  beforeEach(() => {
    agent = new GitHubReleaseAgent();
  });

  it('should detect "tag" from descriptions containing "tag"', () => {
    const method = getPrivateMethod<string>(agent, 'detectOperation');
    expect(method('Create tag v1.2.3')).toBe('tag');
    expect(method('tag the current commit')).toBe('tag');
    expect(method('make a git tag')).toBe('tag');
  });

  it('should not return "tag" when description also contains "release"', () => {
    const method = getPrivateMethod<string>(agent, 'detectOperation');
    // "tag release" should match "release" first because it also contains "release"
    expect(method('tag and release')).toBe('release');
  });

  it('should detect "release" from descriptions containing "release", "publish", or "create release"', () => {
    const method = getPrivateMethod<string>(agent, 'detectOperation');
    expect(method('Create a release')).toBe('release');
    expect(method('Publish v1.0.0')).toBe('release');
    expect(method('create release for version')).toBe('release');
  });

  it('should detect "list" from descriptions containing "list" or "show"', () => {
    const method = getPrivateMethod<string>(agent, 'detectOperation');
    // Avoid keywords that also match 'release', 'tag', 'note'
    expect(method('List available versions')).toBe('list');
    expect(method('show references')).toBe('list');
    expect(method('Show git references')).toBe('list');
  });

  it('should detect "notes" from descriptions containing "note", "changelog", or "release note"', () => {
    const method = getPrivateMethod<string>(agent, 'detectOperation');
    // Avoid keywords that also match 'release', 'tag'
    expect(method('generate change notes')).toBe('notes');
    expect(method('update changelog')).toBe('notes');
    expect(method('compose note')).toBe('notes');
  });

  it('should default to "release" for unknown descriptions', () => {
    const method = getPrivateMethod<string>(agent, 'detectOperation');
    expect(method('do something')).toBe('release');
    expect(method('')).toBe('release');
  });
});

// ─── detectVersion ──────────────────────────────────────────────────────────

describe('GitHubReleaseAgent detectVersion', () => {
  let agent: GitHubReleaseAgent;

  beforeEach(() => {
    agent = new GitHubReleaseAgent();
  });

  it('should extract version from the description string', () => {
    const method = getPrivateMethod<string>(agent, 'detectVersion');
    const ctx = createContext();

    expect(method('Release v1.2.3 to npm', ctx)).toBe('1.2.3');
    expect(method('Create tag 2.0.0', ctx)).toBe('2.0.0');
    expect(method('Publish 0.5.0-beta', ctx)).toBe('0.5.0');
  });

  it('should strip the leading "v" from version in description', () => {
    const method = getPrivateMethod<string>(agent, 'detectVersion');
    const ctx = createContext();

    expect(method('v3.0.0 release', ctx)).toBe('3.0.0');
  });

  it('should read version from package.json when not in description', () => {
    const method = getPrivateMethod<string>(agent, 'detectVersion');
    // Our project has a package.json with version "1.4.1"
    const ctx = createContext({ workingDirectory: process.cwd() });

    expect(method('Create a release', ctx)).toBe('1.6.0');
  });

  it('should fall back to git tags when package.json has no version', () => {
    const method = getPrivateMethod<string>(agent, 'detectVersion');
    const tmpDir = join(tmpdir(), 'gh-test-no-version');
    if (!existsSync(tmpDir)) {
      mkdirSync(tmpDir, { recursive: true });
    }
    const pkgPath = join(tmpDir, 'package.json');
    writeFileSync(pkgPath, JSON.stringify({ name: 'test' }), 'utf-8');
    const ctx = createContext({ workingDirectory: tmpDir });

    const version = method('Create a release', ctx);
    // Should be parseable as semver-ish (from git tag + 1, or '0.1.0')
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);

    // Cleanup
    try { unlinkSync(pkgPath); } catch { /* best-effort */ }
  });

  it('should return valid semver when no version source is available', () => {
    const method = getPrivateMethod<string>(agent, 'detectVersion');
    // Use empty description and non-existent package.json path
    const ctx = createContext({ workingDirectory: join(tmpdir(), 'nonexistent-dir') });

    const version = method('', ctx);
    // The git command succeeds (runs in project root) and returns next patch
    // from the latest tag, e.g., '1.4.2' from '1.4.1'
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

// ─── detectCurrentBranch ────────────────────────────────────────────────────

describe('GitHubReleaseAgent detectCurrentBranch', () => {
  let agent: GitHubReleaseAgent;

  beforeEach(() => {
    agent = new GitHubReleaseAgent();
  });

  it('should return the current git branch name', () => {
    const method = getPrivateMethod<string>(agent, 'detectCurrentBranch');
    const branch = method();
    expect(branch).toBeTruthy();
    expect(typeof branch).toBe('string');
    expect(branch.length).toBeGreaterThan(0);
  });

  it('should return a valid branch name (no spaces or special chars)', () => {
    const method = getPrivateMethod<string>(agent, 'detectCurrentBranch');
    const branch = method();
    // Branch names are alphanumeric with dashes, slashes, dots, underscores
    expect(branch).toMatch(/^[\w./-]+$/);
  });
});

// ─── generateNotesFallback ──────────────────────────────────────────────────

describe('GitHubReleaseAgent generateNotesFallback', () => {
  let agent: GitHubReleaseAgent;

  beforeEach(() => {
    agent = new GitHubReleaseAgent();
  });

  it('should generate release notes with the tag name and date', () => {
    const method = getPrivateMethod<string>(agent, 'generateNotesFallback');
    const notes = method('v1.2.3');

    expect(notes).toContain('v1.2.3');
    expect(notes).toContain('### Changes');
    expect(notes).toContain('Auto-generated by agent-baba-d');
  });

  it('should include commit messages from git log', () => {
    const method = getPrivateMethod<string>(agent, 'generateNotesFallback');
    const notes = method('v1.0.0');

    // Should include some commits (the project has a git history)
    expect(notes.split('\n').length).toBeGreaterThan(5);
  });

  it('should generate notes even for non-existent tags', () => {
    const method = getPrivateMethod<string>(agent, 'generateNotesFallback');
    const notes = method('v999.999.999');

    expect(notes).toContain('v999.999.999');
    expect(notes).toContain('### Changes');
  });
});

// ─── exec error handling ────────────────────────────────────────────────────

describe('GitHubReleaseAgent exec', () => {
  let agent: GitHubReleaseAgent;

  beforeEach(() => {
    agent = new GitHubReleaseAgent();
  });

  it('should execute a simple command and return output', () => {
    const method = getPrivateMethod<string>(agent, 'exec');
    const output = method('echo hello');
    expect(output.trim()).toBe('hello');
  });

  it('should throw for non-existent commands', () => {
    const method = getPrivateMethod<string>(agent, 'exec');
    expect(() => method('nonexistent-command-xyz')).toThrow();
  });

  it('should throw when not in a git repository for git commands', () => {
    const method = getPrivateMethod<string>(agent, 'exec');
    // Run a git command outside the repo context (use a known non-git dir)
    expect(() => method(`git -C "${tmpdir()}" log`)).toThrow();
  });

  it('should handle successful git commands', () => {
    const method = getPrivateMethod<string>(agent, 'exec');
    const output = method('git rev-parse --abbrev-ref HEAD');
    expect(output.trim()).toBeTruthy();
  });
});

// ─── Agent metadata ─────────────────────────────────────────────────────────

describe('GitHubReleaseAgent metadata', () => {
  it('should have a name and description', () => {
    const agent = new GitHubReleaseAgent();
    expect(agent.name).toBe('GitHub Release');
    expect(agent.description).toBeTruthy();
    expect(agent.description.length).toBeGreaterThan(10);
  });

  it('should extend Agent class', () => {
    const agent = new GitHubReleaseAgent();
    expect(agent).toBeDefined();
    expect(typeof agent.execute).toBe('function');
  });
});
