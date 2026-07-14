/**
 * DebuggerAgent — Takes test failure output, uses the LLM to diagnose and fix
 * the issues, re-runs tests, and iterates until all tests pass or max attempts
 * are exhausted.
 *
 * This agent depends on the TesterAgent having run first and stored its results
 * in the context metadata under `testResult`.
 *
 * The debug cycle:
 * 1. Read test failure output from `context.metadata.testResult`
 * 2. Call LLM with failure output + source files → get proposed fixes
 * 3. Apply fixes to the sandbox (the TesterAgent's sandbox path is in testResult)
 * 4. Re-run tests in the sandbox
 * 5. If tests pass → done. If not, repeat up to MAX_DEBUG_ITERATIONS.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';

import { Agent, type AgentContext, type AgentResult } from '../agent.js';
import type { LLMCallFn } from '../agent.js';
import type { TestResult } from './tester.js';

/** Maximum number of debug-fix-test iterations */
const MAX_DEBUG_ITERATIONS = 3;

const DEBUGGER_SYSTEM_PROMPT = `You are a senior debugging engineer. Given test failure output and the relevant source files, identify the bugs and provide fixes.

Rules:
1. Analyze the test error messages carefully
2. Identify the root cause, not just the symptoms
3. Provide the COMPLETE updated file content for each file you fix
4. Return each file wrapped in a markdown code block with the file path as the header

Format your response as:
\`\`\`filepath:path/to/file.ts
// complete fixed file content here
\`\`\`
`;

/**
 * DebuggerAgent — Diagnoses and fixes test failures iteratively.
 *
 * Usage in task plans:
 * ```json
 * { "id": "step-06-debug", "description": "Fix failing tests", "agentType": "debugger", "dependsOn": ["step-05-test"] }
 * ```
 */
export class DebuggerAgent extends Agent {
  readonly name = 'Debugger';
  readonly description = 'Diagnoses test failures and iteratively applies fixes';

  async execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult> {
    try {
      // 1. Get test result from context metadata
      const testResult = context.metadata['testResult'] as TestResult | undefined;
      if (!testResult) {
        return {
          success: false,
          summary: 'No test results found',
          error: 'TesterAgent must run before DebuggerAgent. No testResult found in context metadata.',
        };
      }

      // If tests already passed, nothing to debug
      if (testResult.success) {
        return {
          success: true,
          summary: 'No debugging needed — all tests already pass',
        };
      }

      const sandboxPath = testResult.sandboxPath;
      if (!existsSync(sandboxPath)) {
        return {
          success: false,
          summary: 'Sandbox not found',
          error: `Test sandbox at ${sandboxPath} no longer exists. The TesterAgent may have been cleaned up.`,
        };
      }

      // 2. Iterative debug cycle
      const allAttempts: Array<{ iteration: number; output: string; filesChanged: string[] }> = [];
      let currentOutput = testResult.output;
      let currentSuccess = false;

      for (let iteration = 0; iteration < MAX_DEBUG_ITERATIONS; iteration++) {
        // 3. Call LLM to diagnose and fix
        const prompt = this.buildPrompt(currentOutput, context, sandboxPath);
        const response = await callLLM(prompt, {
          temperature: 0.3,
          maxTokens: 8192,
        });

        // 4. Parse the fix and apply to sandbox
        const changedFiles = this.applyFixes(response, sandboxPath);

        // 5. Re-run tests
        const testCommand = this.detectTestCommand(sandboxPath);
        const reTestResult = this.runTest(sandboxPath, testCommand);

        // Track this attempt
        allAttempts.push({
          iteration: iteration + 1,
          output: reTestResult.output,
          filesChanged: changedFiles,
        });

        // 6. Check if tests pass now
        if (reTestResult.success) {
          currentSuccess = true;

          // 7. Update the context's fileChanges with the successful fixes
          this.syncChangesToContext(context, sandboxPath, context.workingDirectory, changedFiles);

          // Store final test result
          context.metadata['testResult'] = {
            ...testResult,
            success: true,
            output: reTestResult.output,
            exitCode: 0,
          } as TestResult;

          return {
            success: true,
            summary: `All tests pass after ${iteration + 1} debug iteration${iteration > 0 ? 's' : ''}`,
            details: `Files modified: ${changedFiles.join(', ')}`,
          };
        }

        currentOutput = reTestResult.output;
      }

      // 8. Max iterations reached — report failure
      return {
        success: false,
        summary: `Tests still failing after ${MAX_DEBUG_ITERATIONS} debug iterations`,
        details: `Latest test output:\n${this.truncateOutput(currentOutput, 2000)}`,
        error: `Debugger exhausted ${MAX_DEBUG_ITERATIONS} iterations without resolving all test failures.`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        summary: 'Debugger failed',
        error: msg,
      };
    }
  }

  /**
   * Build the debug prompt with failure output and source files.
   */
  private buildPrompt(testOutput: string, context: AgentContext, sandboxPath: string): string {
    // Get the files that were changed (most likely to contain bugs)
    const changedFiles = context.fileChanges.slice(0, 5);
    const fileContents = changedFiles
      .map((change) => {
        const filePath = join(sandboxPath, change.path);
        if (existsSync(filePath)) {
          const content = readFileSync(filePath, 'utf-8');
          return `--- ${change.path} ---\n${content}`;
        }
        return null;
      })
      .filter(Boolean)
      .join('\n\n');

    return `${DEBUGGER_SYSTEM_PROMPT}\n\n## Test Failure Output\n${this.truncateOutput(testOutput, 3000)}\n\n## Source Files\n${fileContents || '(No source files found)'}\n\n## Instructions\nAnalyze the test failures and fix the bugs in the source files. Return the complete updated file content for each file you modify.`;
  }

  /**
   * Parse the LLM response and apply the fixes to files in the sandbox.
   * Returns a list of file paths that were changed.
   */
  private applyFixes(response: string, sandboxPath: string): string[] {
    const changedFiles: string[] = [];
    const blockRegex = /```(?:[a-zA-Z0-9+#]*\s+)?(?:filepath:)?([^\n`]+(?:\.[a-zA-Z0-9]+|\/[^\n`]+))\n([\s\S]*?)```/g;

    let match: RegExpExecArray | null;
    while ((match = blockRegex.exec(response)) !== null) {
      let filePath = match[1].trim();
      const content = match[2].trim();

      filePath = filePath.replace(/^['"]|['"]$/g, '').trim();
      if (!filePath || !content) continue;

      const absolutePath = join(sandboxPath, filePath);
      const dir = dirname(absolutePath);

      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      writeFileSync(absolutePath, content, 'utf-8');
      changedFiles.push(filePath);
    }

    return changedFiles;
  }

  /**
   * Read fixed files from the sandbox and update the context's fileChanges.
   * Handles both files already in context.fileChanges AND new files the LLM
   * may have modified that weren't in the original change set.
   */
  private syncChangesToContext(
    context: AgentContext,
    sandboxPath: string,
    workingDir: string,
    changedFiles: string[],
  ): void {
    for (const filePath of changedFiles) {
      const sandboxFile = join(sandboxPath, filePath);
      if (!existsSync(sandboxFile)) continue;

      const newContent = readFileSync(sandboxFile, 'utf-8');
      const originalPath = join(workingDir, filePath);
      const originalContent = existsSync(originalPath) ? readFileSync(originalPath, 'utf-8') : undefined;

      // Update if already in context, or add as new entry
      const existing = context.fileChanges.findIndex((c) => c.path === filePath);
      if (existing >= 0) {
        context.fileChanges[existing] = {
          path: filePath,
          originalContent,
          newContent,
          status: originalContent ? 'modified' : 'created',
        };
      } else {
        context.fileChanges.push({
          path: filePath,
          originalContent,
          newContent,
          status: originalContent ? 'modified' : 'created',
        });
      }
    }
  }

  /**
   * Run the test command in the sandbox.
   */
  private runTest(sandboxPath: string, command: string): { success: boolean; output: string } {
    try {
      const output = execSync(command, {
        cwd: sandboxPath,
        timeout: 180_000,
        stdio: 'pipe',
        encoding: 'utf-8',
      });
      return { success: true, output };
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
      return { success: false, output };
    }
  }

  /**
   * Detect the test command from package.json.
   */
  private detectTestCommand(sandboxPath: string): string {
    try {
      const pkgPath = join(sandboxPath, 'package.json');
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { scripts?: Record<string, string> };
        if (pkg.scripts?.test) {
          return 'npm run test 2>&1';
        }
      }
    } catch {
      // Fall through
    }
    return 'npm test 2>&1';
  }

  /**
   * Truncate long output to avoid huge strings.
   */
  private truncateOutput(output: string, maxLength: number): string {
    if (output.length <= maxLength) return output;
    return output.slice(0, maxLength) + '\n... (output truncated)';
  }
}
