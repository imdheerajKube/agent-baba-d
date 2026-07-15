/**
 * RunnerAgent — Executes shell commands in the project directory and captures output.
 *
 * This is the agent that makes agent-baba-d capable of *running* the programs
 * it creates. Without this, the system can write files but can never execute
 * them or show the user what happened.
 *
 * Usage in task plans:
 * ```json
 * { "id": "step-03-run", "description": "Run: python hello.py", "agentType": "runner", "dependsOn": ["step-02-write"] }
 * ```
 *
 * The command to run is determined by:
 * 1. The task description — if it contains a command wrapped in backticks
 *    (e.g., "Run `python hello.py`"), that command is extracted and executed.
 * 2. The "Run:" prefix — if the description starts with "Run:", the rest is
 *    treated as the command (e.g., "Run: python hello.py").
 * 3. The LLM fallback — if no explicit command is found, the LLM is asked
 *    what command to run based on the current context (files created, project type).
 *
 * Output is stored in context metadata as `runResult` and returned in the summary.
 */

import { execSync } from 'node:child_process';
import { platform } from 'node:os';

import { Agent, type AgentContext, type AgentResult } from '../agent.js';
import type { LLMCallFn } from '../agent.js';
import { logger } from '../../utils/logger.js';

/** Maximum stdout/stderr length to store in context metadata */
const MAX_OUTPUT_LENGTH = 10_000;

/** Timeout per command in milliseconds (default: 2 minutes) */
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Result of running a command, stored in context.metadata.runResult.
 */
export interface RunResult {
  /** Whether the command exited with code 0 */
  success: boolean;
  /** The exact command that was executed */
  command: string;
  /** Process exit code */
  exitCode: number;
  /** Standard output */
  stdout: string;
  /** Standard error */
  stderr: string;
  /** Duration in milliseconds */
  duration: number;
  /** Error message if execSync threw */
  error?: string;
}

/**
 * RunnerAgent — Executes shell commands and captures output.
 */
export class RunnerAgent extends Agent {
  readonly name = 'Runner';
  readonly description = 'Executes shell commands and captures output';

  async execute(context: AgentContext, callLLM: LLMCallFn): Promise<AgentResult> {
    try {
      // 1. Determine which command to run
      const command = await this.determineCommand(context, callLLM);
      if (!command) {
        return {
          success: false,
          summary: 'No command to run',
          error: 'Could not determine which command to execute from the task description or context.',
        };
      }

      // 2. Execute the command
      if (context.metadata.verboseLogging) {
        logger.info(`     Running: ${command}`);
      }

      // Allow timeout override via context.metadata.runnerTimeout
      const timeoutMs = (typeof context.metadata.runnerTimeout === 'number')
        ? context.metadata.runnerTimeout
        : DEFAULT_TIMEOUT_MS;

      const startTime = Date.now();
      let exitCode = 0;
      let stdout = '';
      let stderr = '';
      let execError: string | undefined;

      try {
        const output = execSync(command, {
          cwd: context.workingDirectory,
          timeout: timeoutMs,
          stdio: 'pipe',
          encoding: 'utf-8',
          // Use shell so we can run python, node, bash scripts etc.
          shell: platform() === 'win32' ? (process.env.COMSPEC || 'cmd.exe') : '/bin/sh',
          // Max buffer size: 1 MB
          maxBuffer: 1024 * 1024,
        });
        stdout = output.trim();
      } catch (err) {
        const error = err as {
          status?: number;
          stdout?: string | Buffer;
          stderr?: string | Buffer;
          message?: string;
        };
        exitCode = error.status ?? 1;
        stdout = (typeof error.stdout === 'string' ? error.stdout : String(error.stdout || '')).trim();
        stderr = (typeof error.stderr === 'string' ? error.stderr : String(error.stderr || '')).trim();
        execError = error.message;
      }

      const duration = Date.now() - startTime;

      // 3. Build the run result
      const runResult: RunResult = {
        success: exitCode === 0,
        command,
        exitCode,
        stdout: stdout.slice(0, MAX_OUTPUT_LENGTH),
        stderr: stderr.slice(0, MAX_OUTPUT_LENGTH),
        duration,
        error: execError,
      };

      // 4. Store in context metadata for downstream agents or display
      context.metadata['runResult'] = runResult;

      // 5. Build summary
      const lines: string[] = [];
      lines.push(`Command: ${command}`);
      lines.push(`Exit code: ${exitCode}`);
      lines.push(`Duration: ${duration}ms`);

      if (stdout) {
        const truncated = stdout.length > 500;
        lines.push(`stdout:${truncated ? ' (first 500 chars)' : ''}`);
        lines.push(stdout.slice(0, 500));
        if (truncated) lines.push(`... (${stdout.length - 500} more chars)`);
      }

      if (stderr && exitCode !== 0) {
        const truncated = stderr.length > 500;
        lines.push(`stderr:${truncated ? ' (first 500 chars)' : ''}`);
        lines.push(stderr.slice(0, 500));
        if (truncated) lines.push(`... (${stderr.length - 500} more chars)`);
      }

      return {
        success: exitCode === 0,
        summary: exitCode === 0
          ? `✅ Command succeeded: ${command}`
          : `❌ Command failed (exit ${exitCode}): ${command}`,
        details: lines.join('\n'),
        error: execError && exitCode !== 0 ? execError : undefined,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        summary: 'Runner failed',
        error: msg,
      };
    }
  }

  /**
   * Determine the command to run.
   *
   * Priority order:
   * 1. Parse from task description (backtick-wrapped command or "Run:" prefix)
   * 2. Ask the LLM what command to run based on the files that were created
   */
  private async determineCommand(context: AgentContext, callLLM: LLMCallFn): Promise<string | null> {
    // Find the current 'runner' task in the plan
    const runnerTask = context.taskPlan.find(
      (s) => s.agentType === 'runner' && s.status === 'running',
    );
    const description = runnerTask?.description || context.goal;

    // Strategy 1: Extract command from backticks in the description
    // e.g., "Run `python hello.py` and verify output"
    const backtickMatch = description.match(/`([^`]+)`/);
    if (backtickMatch) {
      return backtickMatch[1].trim();
    }

    // Strategy 2: Extract from "Run:" prefix
    // e.g., "Run: python hello.py"
    const runPrefixMatch = description.match(/^Run:\s*(.+)/i);
    if (runPrefixMatch) {
      return runPrefixMatch[1].trim();
    }

    // Strategy 3: Ask the LLM what command to run
    return await this.askLLMForCommand(context, callLLM);
  }

  /**
   * Fallback: ask the LLM what command to run based on the project context.
   */
  private async askLLMForCommand(context: AgentContext, callLLM: LLMCallFn): Promise<string | null> {
    const fileList = context.fileChanges
      .map((c) => `  - ${c.path} (${c.status})`)
      .join('\n');

    const artifactList = context.artifacts
      .slice(0, 5)
      .map((a) => `  - ${a.path}`)
      .join('\n');

    const prompt = [
      'You are a build-and-run expert. Given the context below, what single shell command should be executed',
      'to verify the work that was done? Return ONLY the command, no explanation, no markdown.',
      '',
      `Goal: ${context.goal}`,
      '',
      'Files changed:',
      fileList || '  (no files changed)',
      '',
      'Relevant project files:',
      artifactList || '  (empty project)',
      '',
      'Return ONLY the command to run. Example: "python hello.py" or "node index.js" or "npm test" or "go run main.go".',
      'Rules:',
      '- Return a single line command only',
      '- No backticks, no explanation, no $ prefix',
      '- Use absolute or working-directory-relative paths',
      '- If unsure, suggest the most appropriate verification command',
    ].join('\n');

    try {
      const response = await callLLM(prompt, {
        temperature: 0.1,
        maxTokens: 256,
      });

      const command = response.trim().replace(/^```(?:bash|sh)?\s*|\s*```$/g, '').trim();
      if (command && !command.includes('\n') && command.length < 500) {
        return command;
      }
    } catch {
      // LLM fallback failed — return null
    }

    return null;
  }
}
