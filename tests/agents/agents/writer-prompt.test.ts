/**
 * WriterAgent Prompt & Retry Logic Tests
 *
 * Covers:
 * 1. buildPrompt — file count limits, format instructions, truncation, retry vs normal prompts
 * 2. execute — API error retry with exponential backoff, format retry on empty parse, combined scenarios
 *
 * parseFileChanges is tested separately in writer.test.ts (16 existing tests).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { WriterAgent } from '../../../src/agents/agents/writer.js';
import type { AgentContext } from '../../../src/agents/agent.js';
import type { LLMCallFn } from '../../../src/agents/agent.js';

// ─── Context Builder ──────────────────────────────────────────────────────

function makeContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    goal: 'test goal',
    workingDirectory: '/fake/project',
    taskPlan: [],
    artifacts: [],
    conversations: [],
    fileChanges: [],
    metadata: {},
    ...overrides,
  };
}

function makeArtifact(path: string, content: string, description?: string) {
  return { path, content, description: description || `test artifact: ${path}` };
}

// ─── buildPrompt Tests ────────────────────────────────────────────────────

describe('WriterAgent — buildPrompt', () => {
  let writer: WriterAgent;

  beforeEach(() => {
    writer = new WriterAgent();
  });

  // Access private buildPrompt via prototype
  function buildPrompt(context: AgentContext, isRetry = false): string {
    return (writer as any).buildPrompt.call(writer, context, isRetry);
  }

  // ── File Count Limit ──────────────────────────────────────────────────

  it('should limit to 2 files (MAX_CONTEXT_FILES)', () => {
    const context = makeContext({
      artifacts: [
        makeArtifact('src/a.ts', 'content a'),
        makeArtifact('src/b.ts', 'content b'),
        makeArtifact('src/c.ts', 'content c'), // Third file — should be excluded
      ],
    });

    const prompt = buildPrompt(context);

    // Should include a.ts and b.ts
    expect(prompt).toContain('src/a.ts');
    expect(prompt).toContain('src/b.ts');
    // Should NOT include the third file's path or content
    expect(prompt).not.toContain('src/c.ts');
    // Should note that files were truncated
    expect(prompt).toContain('and 1 more files in the project');
  });

  it('should include up to 2 files and note multiple omitted', () => {
    const context = makeContext({
      artifacts: Array.from({ length: 5 }, (_, i) =>
        makeArtifact(`src/file${i}.ts`, `content ${i}`),
      ),
    });

    const prompt = buildPrompt(context);

    // First 2 files included
    expect(prompt).toContain('src/file0.ts');
    expect(prompt).toContain('src/file1.ts');
    // Last file excluded
    expect(prompt).not.toContain('content 4');
    // Shows count of omitted files
    expect(prompt).toContain('and 3 more files in the project');
  });

  // ── Single file ──────────────────────────────────────────────────────

  it('should include single file when only one exists', () => {
    const context = makeContext({
      artifacts: [makeArtifact('src/single.ts', 'just one file')],
    });

    const prompt = buildPrompt(context);
    expect(prompt).toContain('src/single.ts');
    expect(prompt).toContain('just one file');
    // No "more files" message
    expect(prompt).not.toContain('more files in the project');
  });

  // ── No files ─────────────────────────────────────────────────────────

  it('should show placeholder when no files in context', () => {
    const context = makeContext({ artifacts: [] });

    const prompt = buildPrompt(context);
    expect(prompt).toContain('No files found in context');
  });

  // ── Format Instructions ──────────────────────────────────────────────

  it('should include the WRITER_SYSTEM_PROMPT with filepath: format', () => {
    const context = makeContext({
      goal: 'update auth',
      artifacts: [makeArtifact('src/auth.ts', 'content')],
    });

    const prompt = buildPrompt(context);

    // System prompt with format instructions
    expect(prompt).toContain('filepath:');
    expect(prompt).toContain('CORRECT (use this format)');
    expect(prompt).toContain('INCORRECT (do NOT use these)');
    expect(prompt).toContain('Return the FULL file content');
  });

  // ── Task Description ─────────────────────────────────────────────────

  it('should use the running writer task description', () => {
    const context = makeContext({
      taskPlan: [
        { id: 's1', description: 'Gather context', agentType: 'context-gatherer', dependsOn: [], status: 'completed' },
        { id: 's2', description: 'Implement the feature', agentType: 'writer', dependsOn: ['s1'], status: 'running' },
      ],
    });

    const prompt = buildPrompt(context);
    expect(prompt).toContain('Implement the feature');
  });

  it('should fall back to goal when no writer task is running', () => {
    const context = makeContext({
      goal: 'fallback goal description',
      taskPlan: [
        { id: 's1', description: 'Gather context', agentType: 'context-gatherer', dependsOn: [], status: 'completed' },
      ],
    });

    const prompt = buildPrompt(context);
    expect(prompt).toContain('fallback goal description');
  });

  // ── Retry Prompt ─────────────────────────────────────────────────────

  it('should include CRITICAL header and format reminder in retry prompt', () => {
    const context = makeContext({
      artifacts: [makeArtifact('src/app.ts', 'content')],
    });

    const prompt = buildPrompt(context, true); // isRetry = true

    expect(prompt).toContain('CRITICAL');
    expect(prompt).toContain('previous response could not be parsed');
    expect(prompt).toContain('filepath: prefix is REQUIRED');
  });

  it('should NOT include CRITICAL header in normal prompt', () => {
    const context = makeContext({
      artifacts: [makeArtifact('src/app.ts', 'content')],
    });

    const prompt = buildPrompt(context, false); // isRetry = false

    expect(prompt).not.toContain('CRITICAL');
    expect(prompt).not.toContain('previous response could not be parsed');
  });

  // ── File Truncation ──────────────────────────────────────────────────

  it('should truncate files longer than 60 lines', () => {
    const longContent = Array.from({ length: 70 }, (_, i) => `line ${i}`).join('\n');
    const context = makeContext({
      artifacts: [makeArtifact('src/long.ts', longContent)],
    });

    const prompt = buildPrompt(context);

    // Should include first 60 lines
    expect(prompt).toContain('line 0');
    expect(prompt).toContain('line 59');
    // Should skip line 60+
    expect(prompt).not.toContain('line 60');
    // Should show truncation note
    expect(prompt).toContain('10 more lines truncated');
  });

  it('should NOT truncate files shorter than 60 lines', () => {
    const shortContent = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const context = makeContext({
      artifacts: [makeArtifact('src/short.ts', shortContent)],
    });

    const prompt = buildPrompt(context);

    expect(prompt).toContain('line 0');
    expect(prompt).toContain('line 29');
    expect(prompt).not.toContain('more lines truncated');
  });

  // ── File Content Format ──────────────────────────────────────────────

  it('should prefix each file with --- path --- header', () => {
    const context = makeContext({
      artifacts: [
        makeArtifact('src/a.ts', 'aaa'),
        makeArtifact('src/b.ts', 'bbb'),
      ],
    });

    const prompt = buildPrompt(context);

    expect(prompt).toContain('--- src/a.ts ---');
    expect(prompt).toContain('aaa');
    expect(prompt).toContain('--- src/b.ts ---');
    expect(prompt).toContain('bbb');
  });
});

// ─── execute Retry Logic Tests ────────────────────────────────────────────

describe('WriterAgent — execute retry logic', () => {
  let writer: WriterAgent;
  /** Count of LLM calls made during a test */
  let llmCallCount: number;

  beforeEach(() => {
    writer = new WriterAgent();
    llmCallCount = 0;
  });

  /**
   * Create a mock callLLM that returns an LLM response producing file changes.
   * The response wraps the content in the filepath: format expected by parseFileChanges.
   */
  function successLLM(content?: string): LLMCallFn {
    const fileContent = content ?? 'const x = 1;';
    return async () => {
      llmCallCount++;
      return `\`\`\`filepath:src/output.ts\n${fileContent}\n\`\`\``;
    };
  }

  /**
   * Create a mock callLLM that returns a response with NO parseable file changes.
   * This simulates the LLM responding with explanations but no code blocks.
   */
  function emptyLLM(): LLMCallFn {
    return async () => {
      llmCallCount++;
      return 'I think the file looks fine as-is. No changes needed.';
    };
  }

  /**
   * Create a mock callLLM that throws an API error.
   * Optionally succeeds after a given number of failures (for testing retry).
   */
  function errorLLM(failuresBeforeSuccess = Infinity): LLMCallFn {
    return async () => {
      llmCallCount++;
      if (llmCallCount <= failuresBeforeSuccess) {
        throw new Error('Rate limit exceeded');
      }
      return `\`\`\`filepath:src/output.ts\nconst x = 1;\n\`\`\``;
    };
  }

  /** Build a minimal context with a running writer task */
  function context(overrides: Partial<AgentContext> = {}): AgentContext {
    return makeContext({
      taskPlan: [
        { id: 'step-1', description: 'Test writer step', agentType: 'writer', dependsOn: [], status: 'running' },
      ],
      ...overrides,
    });
  }

  // ── Success Path ───────────────────────────────────────────────────

  it('should return success on first attempt when LLM works', async () => {
    const result = await writer.execute(context(), successLLM());

    expect(result.success).toBe(true);
    expect(result.summary).toContain('Proposed changes to 1 file');
    expect(llmCallCount).toBe(1);
  });

  // ── API Error Retry (exponential backoff) ────────────────────────────

  it('should retry when LLM throws an API error and succeed on retry', async () => {
    // Fail first call, succeed on second
    const result = await writer.execute(context(), errorLLM(1));

    expect(result.success).toBe(true);
    expect(result.summary).toContain('Proposed changes to 1 file');
    expect(llmCallCount).toBe(2); // 1 failure + 1 success
  });

  it('should retry multiple times when LLM keeps failing', async () => {
    // Fail first 2 calls, succeed on third
    const result = await writer.execute(context(), errorLLM(2));

    expect(result.success).toBe(true);
    expect(result.summary).toContain('Proposed changes to 1 file');
    expect(llmCallCount).toBe(3); // 2 failures + 1 success
  });

  it('should return failure after exhausting all retries', async () => {
    // Always throw
    const result = await writer.execute(context(), errorLLM(Infinity));

    expect(result.success).toBe(false);
    expect(result.summary).toBe('Writer failed to generate changes');
    expect(result.error).toContain('Rate limit exceeded');
    expect(llmCallCount).toBe(3); // Max 3 attempts (initial + 2 retries)
  });

  // ── Format Retry (empty parse) ──────────────────────────────────────

  it('should retry with stricter prompt when first response has no parseable files', async () => {
    // First response is empty (no code blocks), second has valid content
    const mockLLM: LLMCallFn = async () => {
      llmCallCount++;
      if (llmCallCount === 1) {
        return 'This file looks fine, no changes needed.';
      }
      return '```filepath:src/output.ts\nconst updated = true;\n```';
    };

    const result = await writer.execute(context(), mockLLM);

    expect(result.success).toBe(true);
    expect(result.summary).toContain('Proposed changes to 1 file');
    expect(llmCallCount).toBe(2); // 1 empty + 1 successful format retry
  });

  it('should return with note when both attempts produce no parseable files', async () => {
    const result = await writer.execute(context(), emptyLLM());

    expect(result.success).toBe(true);
    expect(result.summary).toBe('No files needed changes');
    expect(result.details).toContain('still no parseable output');
    expect(llmCallCount).toBe(2); // 1 initial + 1 format retry
  });

  // ── Combined: API Error + Format Retry ──────────────────────────────

  it('should retry API error AND apply format retry on the retried attempt', async () => {
    // Call 1: throws API error
    // Call 2: succeeds but produces empty parse (no code blocks)
    // Call 3: format retry produces valid content
    let call = 0;
    const mockLLM: LLMCallFn = async () => {
      call++;
      llmCallCount++;
      if (call === 1) throw new Error('API timeout');
      if (call === 2) return 'No changes needed, the code is fine.';
      return '```filepath:src/output.ts\nconst result = "fixed";\n```';
    };

    const result = await writer.execute(context(), mockLLM);

    expect(result.success).toBe(true);
    expect(result.summary).toContain('Proposed changes to 1 file');
    expect(llmCallCount).toBe(3); // 1 API error + 1 empty + 1 format retry success
  });

  it('should handle API error followed by failed format retry', async () => {
    // Call 1: throws API error
    // Call 2: produces empty parse
    // Call 3: format retry also produces empty parse
    let call = 0;
    const mockLLM: LLMCallFn = async () => {
      call++;
      llmCallCount++;
      if (call === 1) throw new Error('Rate limit hit');
      return 'I reviewed the code and no changes are needed.';
    };

    const result = await writer.execute(context(), mockLLM);

    expect(result.success).toBe(true);
    expect(result.summary).toBe('No files needed changes');
    expect(result.details).toContain('still no parseable output');
    expect(llmCallCount).toBe(3); // 1 API error + 1 empty + 1 format retry empty
  });

  // ── API Error on Format Retry ───────────────────────────────────────

  it('should retry when the format retry call itself throws an API error', async () => {
    // Call 1: produces empty parse → triggers format retry
    // Call 2: format retry throws API error → caught by outer retry loop
    // Call 3: retry attempt produces valid content
    let call = 0;
    const mockLLM: LLMCallFn = async () => {
      call++;
      llmCallCount++;
      if (call === 1) return 'This code is fine, no changes.';
      if (call === 2) throw new Error('API timeout on retry');
      return '```filepath:src/output.ts\nconst result = "fixed";\n```';
    };

    const result = await writer.execute(context(), mockLLM);

    expect(result.success).toBe(true);
    expect(result.summary).toContain('Proposed changes to 1 file');
    expect(llmCallCount).toBe(3); // 1 empty + 1 format retry API error + 1 success
  });
});
