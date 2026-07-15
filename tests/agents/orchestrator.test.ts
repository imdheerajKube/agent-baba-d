/**
 * Orchestrator — Rate-limit handler tests.
 *
 * Tests for the private `createRateLimitHandler` method, which returns
 * an `onRateLimit` callback that prompts the user with 4 choices when
 * a rate-limit error is detected.
 *
 * Tested scenarios:
 * 1. Returns undefined when dryRun is true
 * 2. Returns undefined when not a TTY (non-interactive mode)
 * 3. Returns a valid callback function when interactive
 * 4. Routes 'retry' action correctly
 * 5. Routes 'skip' action correctly
 * 6. Routes 'abort' action correctly
 * 7. Routes 'switch-model' action correctly (creates new LLM provider)
 * 8. Fallback to 'retry' for unrecognized actions
 * 9. Shows model name from RateLimitInfo
 * 10. Shows model name from options when info doesn't have one
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import inquirer from 'inquirer';

import { Orchestrator } from '../../src/agents/orchestrator.js';
import type { OrchestratorOptions } from '../../src/agents/orchestrator.js';
import type { OnRateLimit, RateLimitInfo } from '../../src/agents/agent.js';
import { logger } from '../../src/utils/logger.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Create a sample rate-limit error info object */
function makeRateLimitInfo(overrides: Partial<RateLimitInfo> = {}): RateLimitInfo {
  return {
    retryAfterMs: 5000,
    modelName: 'qwen/qwen3-32b',
    agentName: 'Writer',
    errorMessage: 'Rate limit reached for model `qwen/qwen3-32b`. Please try again in 5s.',
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Orchestrator — createRateLimitHandler', () => {
  let orchestrator: Orchestrator;
  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    orchestrator = new Orchestrator();
    originalIsTTY = process.stdout.isTTY;
  });

  afterEach(() => {
    // Restore original isTTY
    Object.defineProperty(process.stdout, 'isTTY', {
      value: originalIsTTY,
      configurable: true,
    });
    vi.restoreAllMocks();
  });

  /** Access private createRateLimitHandler method */
  function getHandler(
    options: OrchestratorOptions = {},
    model?: string,
  ): OnRateLimit | undefined {
    return (orchestrator as any).createRateLimitHandler.call(orchestrator, options, model);
  }

  // ── Gating: dryRun and TTY ──────────────────────────────────────────────

  it('should return undefined when dryRun is true (non-interactive)', () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });

    const handler = getHandler({ dryRun: true });

    expect(handler).toBeUndefined();
  });

  it('should return undefined when not a TTY (e.g., piped output)', () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: false,
      configurable: true,
    });

    const handler = getHandler({});

    expect(handler).toBeUndefined();
  });

  it('should return undefined when both dryRun and non-TTY', () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: false,
      configurable: true,
    });

    const handler = getHandler({ dryRun: true });

    expect(handler).toBeUndefined();
  });

  it('should return a function when TTY and not dryRun', () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });

    const handler = getHandler({});

    expect(handler).toBeDefined();
    expect(typeof handler).toBe('function');
  });

  // ── Action: retry ───────────────────────────────────────────────────────

  it('should return retry action when user selects retry', async () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });

    vi.spyOn(inquirer, 'prompt').mockResolvedValue({ action: 'retry' });

    const handler = getHandler({})!;
    const result = await handler(makeRateLimitInfo());

    expect(result).toEqual({ action: 'retry' });
  });

  // ── Action: skip ────────────────────────────────────────────────────────

  it('should return skip action when user selects skip', async () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });

    vi.spyOn(inquirer, 'prompt').mockResolvedValue({ action: 'skip' });

    const handler = getHandler({})!;
    const result = await handler(makeRateLimitInfo());

    expect(result).toEqual({ action: 'skip' });
  });

  // ── Action: abort ───────────────────────────────────────────────────────

  it('should return abort action when user selects abort', async () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });

    vi.spyOn(inquirer, 'prompt').mockResolvedValue({ action: 'abort' });

    const handler = getHandler({})!;
    const result = await handler(makeRateLimitInfo());

    expect(result).toEqual({ action: 'abort' });
  });

  // ── Action: switch-model ────────────────────────────────────────────────

  it('should return switch-model action with a new callLLM when user selects switch-model', async () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });

    // Mock inquirer to return 'switch-model' first, then 'new-model-name'
    vi.spyOn(inquirer, 'prompt')
      .mockResolvedValueOnce({ action: 'switch-model' })
      .mockResolvedValueOnce({ model: 'llama-3.1-8b-instant' });

    // Mock createLLMProvider to return a dummy callLLM
    const mockCallLLM = vi.fn().mockResolvedValue('mock response');
    vi.spyOn(orchestrator as any, 'createLLMProvider').mockReturnValue(mockCallLLM);

    const handler = getHandler({ provider: 'groq' })!;
    const result = await handler(makeRateLimitInfo());

    expect(result.action).toBe('switch-model');
    expect(typeof (result as any).callLLM).toBe('function');
    // Verify createLLMProvider was called with the new model
    expect((orchestrator as any).createLLMProvider).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'llama-3.1-8b-instant', provider: 'groq' }),
    );
  });

  it('should call createLLMProvider with original options plus new model', async () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });

    vi.spyOn(inquirer, 'prompt')
      .mockResolvedValueOnce({ action: 'switch-model' })
      .mockResolvedValueOnce({ model: 'gemini-2.0-flash' });

    const mockCallLLM = vi.fn().mockResolvedValue('response');
    vi.spyOn(orchestrator as any, 'createLLMProvider').mockReturnValue(mockCallLLM);

    const handler = getHandler({ provider: 'gemini', verbose: true })!;
    await handler(makeRateLimitInfo({ modelName: 'old-model' }));

    // Should preserve provider and verbose from original options
    expect((orchestrator as any).createLLMProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'gemini',
        model: 'gemini-2.0-flash',
        verbose: true,
      }),
    );
  });

  // ── Model name display ─────────────────────────────────────────────────

  it('should use modelName from RateLimitInfo when available', async () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });

    vi.spyOn(inquirer, 'prompt').mockResolvedValue({ action: 'retry' });
    const infoSpy = vi.spyOn(logger, 'info');

    const handler = getHandler({}, 'fallback-model')!;
    await handler(makeRateLimitInfo({ modelName: 'qwen/qwen3-32b' }));

    // Model name is displayed via logger.info, not logger.warn
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('qwen/qwen3-32b'),
    );
  });

  it('should fall back to currentModel option when info has no modelName', async () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });

    vi.spyOn(inquirer, 'prompt').mockResolvedValue({ action: 'retry' });
    const infoSpy = vi.spyOn(logger, 'info');

    const handler = getHandler({}, 'llama-3.1-8b-instant')!;
    await handler(makeRateLimitInfo({ modelName: undefined }));

    // Should fall back to the currentModel from options
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('llama-3.1-8b-instant'),
    );
  });

  // ── Fallback ────────────────────────────────────────────────────────────

  it('should fall back to retry action for unrecognized user input', async () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });

    // Return an unknown action
    vi.spyOn(inquirer, 'prompt').mockResolvedValue({ action: 'unknown-option' });

    const handler = getHandler({})!;
    const result = await handler(makeRateLimitInfo());

    // Fallback should be retry
    expect(result).toEqual({ action: 'retry' });
  });
});
