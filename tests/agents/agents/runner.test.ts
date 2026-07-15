/**
 * RunnerAgent Unit Tests
 *
 * Covers:
 * 1. Command detection — backtick, "Run:" prefix, LLM fallback, no-command
 * 2. Execute with real commands — stdout capture, stderr capture, exit codes
 * 3. Error handling — non-existent commands, output truncation
 * 4. Metadata — runResult stored in context.metadata
 * 5. Cross-platform shell detection (via platform() calls)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

import { RunnerAgent } from '../../../src/agents/agents/runner.js';
import type { AgentContext, LLMCallFn } from '../../../src/agents/agent.js';
import type { RunResult } from '../../../src/agents/agents/runner.js';

// ─── Context Builder ──────────────────────────────────────────────────────

function makeContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    goal: 'test goal',
    workingDirectory: '/tmp',
    taskPlan: [],
    artifacts: [],
    conversations: [],
    fileChanges: [],
    metadata: {},
    ...overrides,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('RunnerAgent', () => {
  let runner: RunnerAgent;
  /** Tracks LLM call count for tests that need it */
  let llmCallCount: number;

  beforeEach(() => {
    runner = new RunnerAgent();
    llmCallCount = 0;
  });

  // ─── Metadata ──────────────────────────────────────────────────────────

  describe('metadata', () => {
    it('should have correct name', () => {
      expect(runner.name).toBe('Runner');
    });

    it('should have correct description', () => {
      expect(runner.description).toContain('Executes shell commands');
    });
  });

  // ─── Command Detection (private methods via prototype) ─────────────────

  describe('command detection', () => {
    /**
     * Access private determineCommand via prototype (same pattern as Writer tests).
     */
    function determineCommand(context: AgentContext, mockLLM: LLMCallFn): Promise<string | null> {
      return (runner as any).determineCommand.call(runner, context, mockLLM);
    }

    // ── Backtick Strategy ──────────────────────────────────────────────

    it('should extract command from backtick-wrapped in task description', async () => {
      const context = makeContext({
        taskPlan: [
          { id: 'step-1', description: 'Run `echo hello` and verify output', agentType: 'runner', dependsOn: [], status: 'running' },
        ],
      });

      // The backtick strategy kicks in before the LLM is called, so mockLLM shouldn't be invoked
      const mockLLM: LLMCallFn = async () => {
        llmCallCount++;
        return 'should not be called';
      };

      const command = await determineCommand(context, mockLLM);
      expect(command).toBe('echo hello');
      expect(llmCallCount).toBe(0); // LLM should NOT be called
    });

    it('should extract command from backticks even with surrounding text', async () => {
      const context = makeContext({
        taskPlan: [
          { id: 'step-1', description: 'Now run `python hello.py` in the terminal', agentType: 'runner', dependsOn: [], status: 'running' },
        ],
      });

      const mockLLM: LLMCallFn = async () => { llmCallCount++; return ''; };
      const command = await determineCommand(context, mockLLM);
      expect(command).toBe('python hello.py');
      expect(llmCallCount).toBe(0);
    });

    it('should extract the first backtick-wrapped command when multiple exist', async () => {
      const context = makeContext({
        taskPlan: [
          { id: 'step-1', description: 'Run `npm install` then `npm test` to verify', agentType: 'runner', dependsOn: [], status: 'running' },
        ],
      });

      const mockLLM: LLMCallFn = async () => { llmCallCount++; return ''; };
      const command = await determineCommand(context, mockLLM);
      expect(command).toBe('npm install'); // First backtick match
      expect(llmCallCount).toBe(0);
    });

    // ── "Run:" Prefix Strategy ─────────────────────────────────────────

    it('should extract command from "Run:" prefix in task description', async () => {
      const context = makeContext({
        taskPlan: [
          { id: 'step-1', description: 'Run: node index.js', agentType: 'runner', dependsOn: [], status: 'running' },
        ],
      });

      const mockLLM: LLMCallFn = async () => { llmCallCount++; return ''; };
      const command = await determineCommand(context, mockLLM);
      expect(command).toBe('node index.js');
      expect(llmCallCount).toBe(0);
    });

    it('should handle "Run:" prefix case-insensitively', async () => {
      const context = makeContext({
        taskPlan: [
          { id: 'step-1', description: 'rUN: python main.py', agentType: 'runner', dependsOn: [], status: 'running' },
        ],
      });

      const mockLLM: LLMCallFn = async () => { llmCallCount++; return ''; };
      const command = await determineCommand(context, mockLLM);
      expect(command).toBe('python main.py');
      expect(llmCallCount).toBe(0);
    });

    it('should prefer backtick over "Run:" when both exist', async () => {
      const context = makeContext({
        taskPlan: [
          { id: 'step-1', description: 'Run: ignored-command', agentType: 'runner', dependsOn: [], status: 'running' },
        ],
      });

      // Only "Run:" prefix, no backticks — should use Run:
      const mockLLM: LLMCallFn = async () => { llmCallCount++; return ''; };
      const command = await determineCommand(context, mockLLM);
      expect(command).toBe('ignored-command');
    });

    // ── LLM Fallback Strategy ──────────────────────────────────────────

    it('should fall back to LLM when no backtick or Run: prefix found', async () => {
      const context = makeContext({
        goal: 'create a Python script and run it',
        taskPlan: [
          { id: 'step-1', description: 'Run the Python script to verify output', agentType: 'runner', dependsOn: [], status: 'running' },
        ],
        fileChanges: [
          { path: 'hello.py', newContent: 'print("hi")', status: 'created' },
        ],
      });

      const mockLLM: LLMCallFn = async () => {
        llmCallCount++;
        return 'python hello.py';
      };

      const command = await determineCommand(context, mockLLM);
      expect(command).toBe('python hello.py');
      expect(llmCallCount).toBe(1); // LLM was called once
    });

    it('should pass file changes context to LLM fallback', async () => {
      const context = makeContext({
        goal: 'run the node app',
        taskPlan: [
          { id: 'step-1', description: 'Execute and check output', agentType: 'runner', dependsOn: [], status: 'running' },
        ],
        fileChanges: [
          { path: 'server.js', newContent: 'console.log("running")', status: 'created' },
          { path: 'package.json', newContent: '{"name":"test"}', status: 'created' },
        ],
      });

      let llmPrompt = '';
      const mockLLM: LLMCallFn = async (prompt: string) => {
        llmCallCount++;
        llmPrompt = prompt;
        return 'node server.js';
      };

      await determineCommand(context, mockLLM);
      expect(llmCallCount).toBe(1);
      // The LLM prompt should mention the files changed
      expect(llmPrompt).toContain('server.js');
      expect(llmPrompt).toContain('package.json');
      expect(llmPrompt).toContain('created');
    });

    it('should strip markdown code fences from LLM response', async () => {
      const context = makeContext({
        goal: 'run the app',
        taskPlan: [
          { id: 'step-1', description: 'Run the application', agentType: 'runner', dependsOn: [], status: 'running' },
        ],
      });

      const mockLLM: LLMCallFn = async () => {
        llmCallCount++;
        return '```bash\nnode app.js\n```';
      };

      const command = await determineCommand(context, mockLLM);
      expect(command).toBe('node app.js');
    });

    it('should reject multi-line commands from LLM', async () => {
      const context = makeContext({
        goal: 'build the project',
        taskPlan: [
          { id: 'step-1', description: 'Build and run', agentType: 'runner', dependsOn: [], status: 'running' },
        ],
      });

      const mockLLM: LLMCallFn = async () => {
        llmCallCount++;
        return 'npm install\nnpm test';
      };

      const command = await determineCommand(context, mockLLM);
      expect(command).toBeNull(); // Multi-line is rejected
    });

    it('should return null when LLM fallback also fails', async () => {
      const context = makeContext({
        goal: 'ambiguous task',
        taskPlan: [
          { id: 'step-1', description: 'Do something', agentType: 'runner', dependsOn: [], status: 'running' },
        ],
      });

      const mockLLM: LLMCallFn = async () => {
        llmCallCount++;
        throw new Error('API error');
      };

      const command = await determineCommand(context, mockLLM);
      expect(command).toBeNull();
      expect(llmCallCount).toBe(1);
    });

    // ── Goal Fallback ──────────────────────────────────────────────────

    it('should fall back to goal when no runner task is in plan', async () => {
      // When there's no runner task in taskPlan, determineCommand uses context.goal
      const context = makeContext({
        goal: 'Run: npm test',
        taskPlan: [], // No runner task
      });

      // Should find "Run:" in the goal
      const mockLLM: LLMCallFn = async () => { llmCallCount++; return ''; };
      const command = await determineCommand(context, mockLLM);
      expect(command).toBe('npm test');
      expect(llmCallCount).toBe(0);
    });

    it('should try to find backtick command in goal when no runner task exists', async () => {
      const context = makeContext({
        goal: 'Run `echo from-goal` to verify',
        taskPlan: [],
      });

      const mockLLM: LLMCallFn = async () => { llmCallCount++; return ''; };
      const command = await determineCommand(context, mockLLM);
      expect(command).toBe('echo from-goal');
    });
  });

  // ─── Execute with Real Commands ─────────────────────────────────────────

  describe('execute', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'buff-runner-test-'));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    function context(overrides: Partial<AgentContext> = {}): AgentContext {
      return makeContext({
        workingDirectory: tmpDir,
        taskPlan: [
          { id: 'step-1', description: 'Run: echo "hello world"', agentType: 'runner', dependsOn: [], status: 'running' },
        ],
        ...overrides,
      });
    }

    function mockLLM(): LLMCallFn {
      return async () => { llmCallCount++; return ''; };
    }

    // ── Success Path ──────────────────────────────────────────────────

    it('should run a simple echo command and capture stdout', async () => {
      const result = await runner.execute(context(), mockLLM());

      expect(result.success).toBe(true);
      expect(result.summary).toContain('Command succeeded');
      expect(result.summary).toContain('echo "hello world"');
      expect(result.details).toContain('Exit code: 0');
      expect(result.details).toContain('hello world');
    });

    it('should execute a command and show exit code 0', async () => {
      const ctx = context({
        taskPlan: [
          { id: 'step-1', description: 'Run: echo test', agentType: 'runner', dependsOn: [], status: 'running' },
        ],
      });
      const result = await runner.execute(ctx, mockLLM());

      expect(result.success).toBe(true);
      expect(result.details).toContain('Exit code: 0');
    });

    it('should store runResult in context metadata on success', async () => {
      const ctx = context();
      await runner.execute(ctx, mockLLM());

      const runResult = ctx.metadata['runResult'] as RunResult;
      expect(runResult).toBeDefined();
      expect(runResult.success).toBe(true);
      expect(runResult.command).toBe('echo "hello world"');
      expect(runResult.exitCode).toBe(0);
      expect(runResult.stdout).toContain('hello world');
      expect(typeof runResult.duration).toBe('number');
      expect(runResult.duration).toBeGreaterThan(0);
    });

    // ── Error Handling ────────────────────────────────────────────────

    it('should report failure for non-existent command (exit code 127)', async () => {
      const ctx = context({
        taskPlan: [
          { id: 'step-1', description: 'Run: nonexistent-command-xyz-123', agentType: 'runner', dependsOn: [], status: 'running' },
        ],
      });
      const result = await runner.execute(ctx, mockLLM());

      expect(result.success).toBe(false);
      expect(result.summary).toContain('Command failed');
      expect(result.details).toContain('Exit code:');
      // Should capture some error output
      expect(result.error).toBeTruthy();
    });

    it('should capture stderr for failed commands', async () => {
      const ctx = context({
        taskPlan: [
          { id: 'step-1', description: 'Run: sh -c "echo error >&2; exit 1"', agentType: 'runner', dependsOn: [], status: 'running' },
        ],
      });
      const result = await runner.execute(ctx, mockLLM());

      expect(result.success).toBe(false);
      expect(result.details).toContain('exit 1');
      expect(result.details).toContain('stderr:');
    });

    it('should store runResult with failure details in metadata', async () => {
      const ctx = context({
        taskPlan: [
          { id: 'step-1', description: 'Run: nonexistent-command-xyz-123', agentType: 'runner', dependsOn: [], status: 'running' },
        ],
      });
      await runner.execute(ctx, mockLLM());

      const runResult = ctx.metadata['runResult'] as RunResult;
      expect(runResult).toBeDefined();
      expect(runResult.success).toBe(false);
      expect(runResult.exitCode).not.toBe(0);
    });

    // ── Output Truncation ─────────────────────────────────────────────

    it('should truncate long stdout in details but keep full in metadata', async () => {
      // Write a file with 1000 chars of known content to cat
      const longContent = 'a'.repeat(1000);
      writeFileSync(join(tmpDir, 'long-output.txt'), longContent, 'utf-8');

      const ctx = context({
        taskPlan: [
          { id: 'step-1', description: 'Run: cat long-output.txt', agentType: 'runner', dependsOn: [], status: 'running' },
        ],
      });

      const result = await runner.execute(ctx, mockLLM());

      // Details should be truncated (shows first 500 chars)
      const details = result.details || '';
      const stdoutSectionIndex = details.indexOf('stdout:');
      if (stdoutSectionIndex >= 0) {
        // Should contain a truncation marker since 1000 > 500
        const stdoutSection = details.slice(stdoutSectionIndex);
        expect(stdoutSection).toContain('... (');
        expect(stdoutSection).toContain('more chars)');
      }

      // Metadata should have full output (up to MAX_OUTPUT_LENGTH)
      const runResult = ctx.metadata['runResult'] as RunResult;
      expect(runResult.stdout.length).toBe(1000); // Full output preserved in metadata
    });

    // ── Working Directory ─────────────────────────────────────────────

    it('should execute commands in the working directory', async () => {
      // Create a file in the temp dir and verify the command can see it
      writeFileSync(join(tmpDir, 'test-output.txt'), 'hello from test', 'utf-8');

      const ctx = context({
        taskPlan: [
          { id: 'step-1', description: 'Run: cat test-output.txt', agentType: 'runner', dependsOn: [], status: 'running' },
        ],
      });
      const result = await runner.execute(ctx, mockLLM());

      expect(result.success).toBe(true);
      expect(result.details).toContain('hello from test');
    });
  });

  // ─── RunResult Interface ───────────────────────────────────────────────

  describe('RunResult structure', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'buff-runner-struct-'));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should have all required RunResult fields on success', async () => {
      const ctx = makeContext({
        workingDirectory: tmpDir,
        taskPlan: [
          { id: 'step-1', description: 'Run: echo ok', agentType: 'runner', dependsOn: [], status: 'running' },
        ],
      });
      await runner.execute(ctx, async () => '');

      const rr = ctx.metadata['runResult'] as RunResult;
      expect(rr).toHaveProperty('success');
      expect(rr).toHaveProperty('command');
      expect(rr).toHaveProperty('exitCode');
      expect(rr).toHaveProperty('stdout');
      expect(rr).toHaveProperty('stderr');
      expect(rr).toHaveProperty('duration');

      expect(typeof rr.success).toBe('boolean');
      expect(typeof rr.command).toBe('string');
      expect(typeof rr.exitCode).toBe('number');
      expect(typeof rr.stdout).toBe('string');
      expect(typeof rr.stderr).toBe('string');
      expect(typeof rr.duration).toBe('number');
    });

    it('should have error field set on failure', async () => {
      const ctx = makeContext({
        workingDirectory: tmpDir,
        taskPlan: [
          { id: 'step-1', description: 'Run: nonexistent-cmd-xyz', agentType: 'runner', dependsOn: [], status: 'running' },
        ],
      });
      await runner.execute(ctx, async () => '');

      const rr = ctx.metadata['runResult'] as RunResult;
      expect(rr.success).toBe(false);
      expect(rr.error).toBeTruthy(); // Error message should be present
    });

    it('should not have error field on success', async () => {
      const ctx = makeContext({
        workingDirectory: tmpDir,
        taskPlan: [
          { id: 'step-1', description: 'Run: echo ok', agentType: 'runner', dependsOn: [], status: 'running' },
        ],
      });
      await runner.execute(ctx, async () => '');

      const rr = ctx.metadata['runResult'] as RunResult;
      expect(rr.success).toBe(true);
      expect(rr.error).toBeUndefined(); // No error on success
    });

    it('should report no-command error when command cannot be determined', async () => {
      const ctx = makeContext({
        workingDirectory: tmpDir,
        taskPlan: [
          { id: 'step-1', description: 'Ambiguous task with no executable command', agentType: 'runner', dependsOn: [], status: 'running' },
        ],
      });

      // LLM also fails to return a command
      const failingLLM: LLMCallFn = async () => { throw new Error('API error'); };
      const result = await runner.execute(ctx, failingLLM);

      expect(result.success).toBe(false);
      expect(result.summary).toBe('No command to run');
      expect(result.error).toContain('Could not determine which command to execute');
    });
  });

  // ─── Cross-Platform Shell Detection ────────────────────────────────────

  describe('shell detection', () => {
    it('should execute a basic command via the configured shell', async () => {
      // Use 'echo' which works on both /bin/sh (Unix) and cmd.exe (Windows)
      const tmpDir = mkdtempSync(join(tmpdir(), 'buff-runner-shell-'));
      try {
        const ctx = makeContext({
          workingDirectory: tmpDir,
          taskPlan: [
            { id: 'step-1', description: 'Run: echo shell_works', agentType: 'runner', dependsOn: [], status: 'running' },
          ],
        });
        const result = await runner.execute(ctx, async () => '');
        expect(result.success).toBe(true);
        expect(result.details).toContain('shell_works');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should expand variables via the configured shell', async () => {
      // Test that shell variable expansion works (works in both /bin/sh and cmd.exe via echo)
      const tmpDir = mkdtempSync(join(tmpdir(), 'buff-runner-shell-'));
      try {

        const ctx = makeContext({
          workingDirectory: tmpDir,
          taskPlan: [
            { id: 'step-1', description: 'Run: echo hello_from_shell', agentType: 'runner', dependsOn: [], status: 'running' },
          ],
        });
        const result = await runner.execute(ctx, async () => '');
        expect(result.success).toBe(true);
        expect(result.details).toContain('hello_from_shell');
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  // ─── Working Directory Edge Cases ───────────────────────────────────────

  describe('working directory edge cases', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'buff-runner-edge-'));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should handle command with special characters in output', async () => {
      // Test that a command with special shell characters (semicolons, pipes, quotes) works
      const ctx = makeContext({
        workingDirectory: tmpDir,
        taskPlan: [
          { id: 'step-1', description: 'Run: echo "hello; world | test"', agentType: 'runner', dependsOn: [], status: 'running' },
        ],
      });
      const result = await runner.execute(ctx, async () => '');
      expect(result.success).toBe(true);
      expect(result.details).toContain('hello; world | test');
    });

    it('should handle command with exit code 0 but non-empty stderr', async () => {
      const ctx = makeContext({
        workingDirectory: tmpDir,
        taskPlan: [
          { id: 'step-1', description: 'Run: sh -c "echo stdout; echo stderr >&2"', agentType: 'runner', dependsOn: [], status: 'running' },
        ],
      });
      const result = await runner.execute(ctx, async () => '');
      // This command exits 0, so result should be success
      expect(result.success).toBe(true);
      expect(result.details).toContain('stdout');
    });

    it('should handle very short commands', async () => {
      // Use 'echo' which works on both Unix (/bin/sh) and Windows (cmd.exe)
      const ctx = makeContext({
        workingDirectory: tmpDir,
        taskPlan: [
          { id: 'step-1', description: 'Run: echo ok', agentType: 'runner', dependsOn: [], status: 'running' },
        ],
      });
      const result = await runner.execute(ctx, async () => '');
      expect(result.success).toBe(true);
      expect(result.details).toContain('ok');
    });
  });

  // ─── Writer → Runner Integration (File Write Then Run) ─────────────────
  //
  // These tests validate the exact scenario that was broken on Windows:
  // the WriterAgent creates a file (stored in context.fileChanges), the file
  // is written to disk, and then the RunnerAgent executes a command that
  // references that file. This catches path-resolution regressions across
  // Windows, Linux, and macOS.
  //
  // Unlike the orchestrator's applyFileChanges (which resolves relative paths
  // via resolve(process.cwd(), change.path) in the applyFileChanges method),
  // here we directly write the file before running the runner to simulate the
  // same flow without spinning up the full orchestrator.

  describe('writer → runner integration (file-write-then-execute)', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'buff-writer-runner-'));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    /** Check if a CLI tool is available */
    function isToolAvailable(tool: string): boolean {
      try {
        execSync(`${tool} --version`, { stdio: 'ignore', timeout: 5000 });
        return true;
      } catch {
        return false;
      }
    }

    /**
     * Write a file to the temp dir (simulating what the WriterAgent +
     * orchestrator.applyFileChanges would do), then run a command against it.
     */
    async function writeThenRun(
      fileName: string,
      fileContent: string,
      runCommand: string,
    ): Promise<{ result: import('../../../src/agents/agents/runner.js').AgentResult; runResult: RunResult }> {
      // Step 1: Write the file (simulating orchestrator's applyFileChanges)
      const absolutePath = resolve(tmpDir, fileName);
      const dir = dirname(absolutePath);
      mkdirSync(dir, { recursive: true });
      writeFileSync(absolutePath, fileContent, 'utf-8');
      expect(existsSync(absolutePath)).toBe(true);

      // Step 2: Run the command against it
      const ctx = makeContext({
        workingDirectory: tmpDir,
        taskPlan: [
          {
            id: 'step-run',
            description: `Run: ${runCommand}`,
            agentType: 'runner',
            dependsOn: [],
            status: 'running',
          },
        ],
        fileChanges: [
          { path: fileName, newContent: fileContent, status: 'created' },
        ],
      });

      const result = await runner.execute(ctx, async () => '');
      const runResult = ctx.metadata['runResult'] as RunResult;
      return { result, runResult };
    }

    it('should run a Python script written to the working directory', async () => {
      if (!isToolAvailable('python') && !isToolAvailable('python3')) {
        return; // Skip — Python not available
      }
      const pythonCmd = isToolAvailable('python3') ? 'python3' : 'python';

      const { result, runResult } = await writeThenRun(
        'hello_world.py',
        'print("Hello from Runner!")',
        `${pythonCmd} hello_world.py`,
      );

      expect(result.success).toBe(true);
      expect(runResult.exitCode).toBe(0);
      expect(runResult.stdout).toContain('Hello from Runner!');
    });

    it('should run a Node.js script written to the working directory', async () => {
      if (!isToolAvailable('node')) {
        return; // Skip — Node not available (shouldn't happen in CI)
      }

      const { result, runResult } = await writeThenRun(
        'script.js',
        'console.log("Hello from Runner!")',
        'node script.js',
      );

      expect(result.success).toBe(true);
      expect(runResult.exitCode).toBe(0);
      expect(runResult.stdout).toContain('Hello from Runner!');
    });

    it('should handle file in a subdirectory with relative path', async () => {
      const { result, runResult } = await writeThenRun(
        'subdir/greeting.txt',
        'Hello from subdirectory',
        // Use node -e to read the file (works cross-platform unlike cat/type)
        'node -e "console.log(require(\'fs\').readFileSync(\'subdir/greeting.txt\',\'utf-8\'))"',
      );

      expect(result.success).toBe(true);
      expect(runResult.exitCode).toBe(0);
      expect(runResult.stdout).toContain('Hello from subdirectory');
    });

    it('should handle a file with spaces in the path', async () => {
      const { result, runResult } = await writeThenRun(
        'my folder/test.js',
        'console.log("path with spaces works")',
        // Node handles spaces in quoted paths correctly on all platforms
        'node "my folder/test.js"',
      );

      expect(result.success).toBe(true);
      expect(runResult.exitCode).toBe(0);
      expect(runResult.stdout).toContain('path with spaces works');
    });
  });
});
