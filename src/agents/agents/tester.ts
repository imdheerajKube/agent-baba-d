/**
 * TesterAgent — Creates a sandboxed test environment, copies the project,
 * installs dependencies, runs tests, and reports pass/fail results.
 *
 * The sandbox is created in a temp directory to avoid modifying the original project.
 * Tests are run via `npm test` (or a custom command), and full stdout/stderr + exit
 * code are captured and returned.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { execSync } from 'node:child_process';

import { Agent, type AgentContext, type AgentResult } from '../agent.js';
import type { LLMCallFn } from '../agent.js';

/** Common directories to exclude when copying to the sandbox */
const EXCLUDE_DIRS = ['node_modules', '.git', 'dist', '.next', 'coverage', '.cache'];

/** Default test command */
const DEFAULT_TEST_COMMAND = 'npm test 2>&1';

/** Maximum sandbox age before cleanup (30 minutes) */
const SANDBOX_MAX_AGE_MS = 30 * 60 * 1000;

/** Track sandbox directories for cleanup */
const activeSandboxes: string[] = [];

/**
 * Clean up any sandbox directories on process exit.
 * This prevents temp directory accumulation.
 */
function registerCleanup(): void {
  const cleanup = () => {
    for (const dir of activeSandboxes) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
    }
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(1); });
  process.on('SIGTERM', cleanup);
}

// Register cleanup once
let cleanupRegistered = false;
function ensureCleanupRegistered(): void {
  if (!cleanupRegistered) {
    registerCleanup();
    cleanupRegistered = true;
  }
}

/**
 * Result of running tests in the sandbox.
 */
export interface TestResult {
  /** Whether all tests passed */
  success: boolean;
  /** Full test output (stdout + stderr) */
  output: string;
  /** Test exit code */
  exitCode: number;
  /** Path to the sandbox directory */
  sandboxPath: string;
  /** How many tests passed (parsed from output) */
  passed?: number;
  /** How many tests failed (parsed from output) */
  failed?: number;
  /** How many tests total (parsed from output) */
  total?: number;
}

/**
 * TesterAgent — Sandboxed test runner.
 *
 * Usage in task plans:
 * ```json
 * { "id": "step-05-test", "description": "Run tests to verify the changes", "agentType": "tester", "dependsOn": ["step-04-write"] }
 * ```
 */
export class TesterAgent extends Agent {
  readonly name = 'Tester';
  readonly description = 'Runs tests in a sandboxed environment';

  /**
   * Execute tests in a sandboxed copy of the project.
   *
   * Steps:
   * 1. Create a temp directory
   * 2. Copy project files (excluding node_modules, .git, etc.)
   * 3. Run `npm install` in the sandbox
   * 4. Run `npm test` in the sandbox
   * 5. Parse and return the results
   */
  async execute(context: AgentContext, _callLLM: LLMCallFn): Promise<AgentResult> {
    ensureCleanupRegistered();
    let sandboxPath = '';

    try {
      // 1. Detect test command from package.json
      const testCommand = this.detectTestCommand(context.workingDirectory);

      // 2. Create sandbox
      sandboxPath = mkdtempSync(join(tmpdir(), 'buff-sandbox-'));
      activeSandboxes.push(sandboxPath);

      if (context.metadata.verboseLogging) {
        // verbose logging enabled
      }

      // 3. Copy project files to sandbox
      this.copyProject(context.workingDirectory, sandboxPath);

      // 4. Apply file changes from context to the sandbox
      this.applyChangesToSandbox(sandboxPath, context.fileChanges);

      // 5. Install dependencies
      const installOutput = this.runInstall(sandboxPath);

      // 6. Run tests
      const testResult = this.runTests(sandboxPath, testCommand);

      // 7. Parse test results
      const parsed = this.parseTestOutput(testResult.output);

      // 8. Store test result in context metadata for other agents
      context.metadata['testResult'] = {
        success: testResult.success,
        output: testResult.output,
        exitCode: testResult.exitCode,
        sandboxPath,
        ...parsed,
      } as TestResult;

      // 9. Build summary
      const summaryLines: string[] = [];
      if (parsed.total !== undefined) {
        summaryLines.push(`${parsed.passed}/${parsed.total} tests passed`);
      }
      summaryLines.push(testResult.success ? '✅ All tests passed' : `❌ Tests failed (exit code ${testResult.exitCode})`);

      const details = testResult.success
        ? undefined
        : `Test output:\n${this.truncateOutput(testResult.output, 2000)}`;

      return {
        success: testResult.success,
        summary: summaryLines.join(' — '),
        details,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        summary: 'Test execution failed',
        error: msg,
      };
    }
  }

  /**
   * Detect the test command from package.json scripts.
   * Falls back to the default if not found.
   */
  private detectTestCommand(workingDir: string): string {
    try {
      const pkgPath = join(workingDir, 'package.json');
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { scripts?: Record<string, string> };
        if (pkg.scripts?.test) {
          return `npm run test 2>&1`;
        }
      }
    } catch {
      // Fall through
    }
    return DEFAULT_TEST_COMMAND;
  }

  /**
   * Copy project files to the sandbox directory, excluding large/generated dirs.
   */
  private copyProject(sourceDir: string, targetDir: string): void {
    const entries = this.getDirectoryEntries(sourceDir);

    for (const entry of entries) {
      const srcPath = join(sourceDir, entry);
      const tgtPath = join(targetDir, entry);

      try {
        if (entry.startsWith('.')) continue; // Skip hidden files
        if (EXCLUDE_DIRS.includes(entry)) continue; // Skip excluded dirs

        if (existsSync(srcPath)) {
          cpSync(srcPath, tgtPath, { recursive: true, force: true });
        }
      } catch {
        // Skip files we can't copy
      }
    }
  }

  /**
   * Get sorted directory entries to ensure deterministic copy order.
   */
  private getDirectoryEntries(dir: string): string[] {
    try {
      return readdirSync(dir).sort();
    } catch {
      return [];
    }
  }

  /**
   * Apply the file changes from the execution context to the sandbox.
   */
  private applyChangesToSandbox(sandboxPath: string, changes: import('../agent.js').FileChange[]): void {
    for (const change of changes) {
      if (change.status === 'deleted') continue;
      if (!change.newContent) continue;

      const filePath = join(sandboxPath, change.path);
      const dir = dirname(filePath);

      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      writeFileSync(filePath, change.newContent, 'utf-8');
    }
  }

  /**
   * Run npm install in the sandbox.
   */
  private runInstall(sandboxPath: string): string {
    try {
      return execSync('npm install --prefer-offline --no-audit --no-fund 2>&1', {
        cwd: sandboxPath,
        timeout: 120_000, // 2 minutes
        stdio: 'pipe',
        encoding: 'utf-8',
      });
    } catch (err) {
      const output = err instanceof Error ? err.message : String(err);
      // npm install warnings are normal — only throw on critical errors
      return output;
    }
  }

  /**
   * Run the test command and capture output.
   */
  private runTests(sandboxPath: string, command: string): TestResult {
    try {
      const output = execSync(command, {
        cwd: sandboxPath,
        timeout: 180_000, // 3 minutes
        stdio: 'pipe',
        encoding: 'utf-8',
      });

      return {
        success: true,
        output,
        exitCode: 0,
        sandboxPath,
      };
    } catch (err) {
      const error = err as {
        status?: number;
        stdout?: string;
        stderr?: string;
        message?: string;
      };

      const output = [
        error.stdout || '',
        error.stderr || '',
        error.message || '',
      ].filter(Boolean).join('\n');

      return {
        success: false,
        output,
        exitCode: error.status ?? 1,
        sandboxPath,
      };
    }
  }

  /**
   * Parse test output to extract pass/fail/total counts.
   * Supports common test runners: vitest, jest, mocha, etc.
   */
  private parseTestOutput(output: string): { passed?: number; failed?: number; total?: number } {
    // Try vitest format: "Tests  1 failed | 3 passed (4)"
    const vitestMatch = output.match(/Tests\s+(?:(?:(\d+)\s+failed)\s*)?(?:\|?\s*)?(?:(\d+)\s+passed)?\s*\((\d+)\)/);
    if (vitestMatch) {
      return {
        failed: vitestMatch[1] ? parseInt(vitestMatch[1], 10) : 0,
        passed: vitestMatch[2] ? parseInt(vitestMatch[2], 10) : 0,
        total: parseInt(vitestMatch[3], 10),
      };
    }

    // Try jest format: "Tests: 1 failed, 3 passed, 4 total"
    const jestMatch = output.match(/Tests:\s*(?:(\d+)\s+failed,?\s*)?(?:(\d+)\s+passed,?\s*)?(\d+)\s+total/);
    if (jestMatch) {
      return {
        failed: jestMatch[1] ? parseInt(jestMatch[1], 10) : 0,
        passed: jestMatch[2] ? parseInt(jestMatch[2], 10) : 0,
        total: parseInt(jestMatch[3], 10),
      };
    }

    // Try generic: "X passing, Y failing"
    const genericMatch = output.match(/(\d+)\s+passing,?\s*(?:(\d+)\s+failing)?/);
    if (genericMatch) {
      return {
        passed: parseInt(genericMatch[1], 10),
        failed: genericMatch[2] ? parseInt(genericMatch[2], 10) : 0,
        total: (genericMatch[2] ? parseInt(genericMatch[1], 10) + parseInt(genericMatch[2], 10) : parseInt(genericMatch[1], 10)),
      };
    }

    // Count lines with ✗, ✓, PASS, FAIL markers as a rough estimate
    const failLines = (output.match(/[✗❌]|FAIL|failed/g) || []).length;
    const passLines = (output.match(/[✓✅]|PASS|passed/g) || []).length;
    if (passLines > 0 || failLines > 0) {
      return {
        passed: passLines,
        failed: failLines,
        total: passLines + failLines,
      };
    }

    return {};
  }

  /**
   * Truncate long output to avoid huge result strings.
   */
  private truncateOutput(output: string, maxLength: number): string {
    if (output.length <= maxLength) return output;
    return output.slice(0, maxLength) + '\n... (output truncated)';
  }
}

/**
 * Clean up a specific sandbox directory.
 */
export function cleanupSandbox(sandboxPath: string): void {
  try {
    rmSync(sandboxPath, { recursive: true, force: true });
    const idx = activeSandboxes.indexOf(sandboxPath);
    if (idx >= 0) activeSandboxes.splice(idx, 1);
  } catch {
    // Best-effort
  }
}
