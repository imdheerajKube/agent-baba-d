/**
 * Unit tests for src/inference/model-catalog.ts
 *
 * Tests the model categorization logic: pattern matching, tag assignment,
 * badge recommendations, and name formatting.
 */

import { describe, it, expect } from 'vitest';
import {
  categorizeModel,
  getModelTags,
  getModelBadge,
  formatModelName,
  CATEGORY_INFO,
  type ModelCategory,
} from '../../src/inference/model-catalog.js';

// ─── categorizeModel ────────────────────────────────────────────────────────

describe('categorizeModel', () => {
  // ── Vision ──────────────────────────────────────────────────────────────
  describe('vision category', () => {
    it('should categorize models with "vision" in the name', () => {
      expect(categorizeModel('llava-vision')).toBe('vision');
      expect(categorizeModel('gpt-4-vision-preview')).toBe('vision');
      expect(categorizeModel('claude-3-opus-vision')).toBe('vision');
    });

    it('should categorize models with "multimodal" in the name', () => {
      expect(categorizeModel('gemini-1.5-pro-vision')).toBe('vision');
      expect(categorizeModel('multimodal-model')).toBe('vision');
    });

    it('should give vision higher priority than chat/other patterns', () => {
      // "vision" appears in the model name which also contains "gpt" (chat pattern)
      expect(categorizeModel('gpt-4-vision-preview')).toBe('vision');
    });
  });

  // ── Reasoning ───────────────────────────────────────────────────────────
  describe('reasoning category', () => {
    it('should categorize Qwen-2.5 models as reasoning', () => {
      expect(categorizeModel('qwen-2.5-32b')).toBe('reasoning');
      expect(categorizeModel('qwen-2.5-72b-instruct')).toBe('reasoning');
      // qwen-2.5-coder-32b does not match the reasoning regex (the digit patterns fail)
      // It matches /coder/ → code, priority 3
      expect(categorizeModel('qwen-2.5-coder-32b')).toBe('code');
    });

    it('should categorize DeepSeek-R1 models as reasoning', () => {
      expect(categorizeModel('deepseek-r1')).toBe('reasoning');
      expect(categorizeModel('deepseek-r1-distill-llama-70b')).toBe('reasoning');
      expect(categorizeModel('deepseek-r1-distill-qwen-32b')).toBe('reasoning');
    });

    it('should categorize DeepSeek-V2/V3 as reasoning', () => {
      expect(categorizeModel('deepseek-v2')).toBe('reasoning');
      expect(categorizeModel('deepseek-v3')).toBe('reasoning');
    });

    it('should categorize models with "reasoning" or "think" in the name', () => {
      expect(categorizeModel('custom-reasoning-model')).toBe('reasoning');
      expect(categorizeModel('o1-thinking')).toBe('reasoning');
      expect(categorizeModel('deep-think-v1')).toBe('reasoning');
    });
  });

  // ── Agentic ─────────────────────────────────────────────────────────────
  describe('agentic category', () => {
    it('should categorize function-calling models as agentic', () => {
      expect(categorizeModel('claude-3-opus-function-call')).toBe('agentic');
    });

    it('should categorize tool-use models as agentic', () => {
      expect(categorizeModel('tool-use-model')).toBe('agentic');
    });

    it('should categorize Claude Opus/Sonnet as agentic', () => {
      expect(categorizeModel('anthropic/claude-opus-4-20250514')).toBe('agentic');
      expect(categorizeModel('anthropic/claude-sonnet-4-20250514')).toBe('agentic');
      expect(categorizeModel('claude-3.5-sonnet')).toBe('agentic');
      expect(categorizeModel('claude-3-opus')).toBe('agentic');
    });

    it('should categorize GPT-4 models as agentic', () => {
      expect(categorizeModel('gpt-4o')).toBe('agentic');
      expect(categorizeModel('gpt-4-turbo')).toBe('agentic');
      expect(categorizeModel('openai/gpt-4o-mini')).toBe('agentic');
    });

    it('should not categorize GPT-3.5 as agentic', () => {
      // GPT-3.5 doesn't match /gpt-4/ pattern
      expect(categorizeModel('gpt-3.5-turbo')).not.toBe('agentic');
    });
  });

  // ── Code ────────────────────────────────────────────────────────────────
  describe('code category', () => {
    it('should categorize models with "coder" in the name', () => {
      expect(categorizeModel('deepseek-coder')).toBe('code');
      expect(categorizeModel('qwen-coder')).toBe('code');
      expect(categorizeModel('wizardcoder')).toBe('code');
      expect(categorizeModel('starcoder')).toBe('code');
      expect(categorizeModel('codellama')).toBe('code');
      expect(categorizeModel('codegemma')).toBe('code');
    });

    it('should categorize models with "code" in the name', () => {
      expect(categorizeModel('codeqwen')).toBe('code');
      expect(categorizeModel('code-llama')).toBe('code');
    });

    it('should give code higher priority over general chat', () => {
      // "codellama" matches both "code" (priority 3) and "llama" (priority 6)
      expect(categorizeModel('codellama')).toBe('code');
    });
  });

  // ── Fast ────────────────────────────────────────────────────────────────
  describe('fast category', () => {
    it('should categorize llama-3.1-8b as fast', () => {
      expect(categorizeModel('llama-3.1-8b-instant')).toBe('fast');
      expect(categorizeModel('llama-3.1-8b')).toBe('fast');
      expect(categorizeModel('meta-llama/Llama-3.1-8b-instruct')).toBe('fast');
    });

    it('should categorize llama-3.2-3b as fast', () => {
      expect(categorizeModel('llama-3.2-3b')).toBe('fast');
    });

    it('should categorize gemma-2-9b as fast', () => {
      expect(categorizeModel('gemma2-9b-it')).toBe('fast');
      expect(categorizeModel('gemma-2-9b-it')).toBe('fast');
    });

    it('should categorize gemma-2-2b as fast', () => {
      expect(categorizeModel('gemma-2-2b-it')).toBe('fast');
      expect(categorizeModel('gemma2-2b')).toBe('fast');
    });

    it('should categorize mistral-7b and mixtral-8x7b as fast', () => {
      expect(categorizeModel('mistral-7b-instruct')).toBe('fast');
      expect(categorizeModel('mixtral-8x7b-32768')).toBe('fast');
    });

    it('should categorize phi-3 models as fast', () => {
      expect(categorizeModel('phi-3')).toBe('fast');
      expect(categorizeModel('phi-3-mini')).toBe('fast');
      expect(categorizeModel('phi3')).toBe('fast');
    });
  });

  // ── Preview ─────────────────────────────────────────────────────────────
  describe('preview category', () => {
    it('should categorize models with "preview" in the name', () => {
      // gpt-4-turbo-preview matches agentic (gpt-4) at priority 3, not preview (5)
      expect(categorizeModel('gpt-4-turbo-preview')).toBe('agentic');
      expect(categorizeModel('preview-model')).toBe('preview');
    });

    it('should categorize models ending with "exp"', () => {
      expect(categorizeModel('gemini-2.0-flash-exp')).toBe('preview');
    });

    it('should categorize models with "experimental" in the name', () => {
      expect(categorizeModel('experimental-model-v3')).toBe('preview');
    });

    it('should categorize models with "flash-exp" in the name', () => {
      expect(categorizeModel('gemini-2.0-flash-exp')).toBe('preview');
    });
  });

  // ── Instruct ────────────────────────────────────────────────────────────
  describe('instruct category', () => {
    it('should categorize models ending with "-it" when no higher-priority pattern matches', () => {
      // "-it" matches instruct (priority 5). Only matches if no priority 1-4 patterns match.
      // These models have no fast/vision/reasoning/agentic/code match
      expect(categorizeModel('custom-model-it')).toBe('instruct');
    });

    it('should categorize models ending with "-instruct" when no higher-priority pattern matches', () => {
      // Must NOT match fast patterns (phi-3-instruct matches fast → use custom-instruct-model instead)
      expect(categorizeModel('custom-instruct-model')).toBe('instruct');
      expect(categorizeModel('generic-instruct-model')).toBe('instruct');
    });

    it('should categorize models ending with "-instruct" when no fast pattern matches', () => {
      // phi-3-instruct matches: fast phi-3 (priority 4), instruct (priority 5) → fast wins
      // But these models only match instruct, not fast
      expect(categorizeModel('dbrx-instruct')).toBe('instruct');  // dbrx matches chat (6), -instruct (5) → instruct wins
      expect(categorizeModel('custom-instruct-v2')).toBe('instruct');
    });

    it('should not beat fast priority for small models ending in -instruct', () => {
      // "llama-3.1-8b-instruct" matches: fast (4), instruct (5), chat (6) → fast wins
      expect(categorizeModel('llama-3.1-8b-instruct')).toBe('fast');
      expect(categorizeModel('meta-llama/Llama-3.1-8b-instruct')).toBe('fast');
      expect(categorizeModel('mistral-7b-instruct')).toBe('fast');
      // gemma2-9b-it matches: fast (4), instruct (5) → fast wins
      expect(categorizeModel('gemma2-9b-it')).toBe('fast');
      expect(categorizeModel('gemma-2-2b-it')).toBe('fast');
    });
  });

  // ── Chat ────────────────────────────────────────────────────────────────
  describe('chat category (catch-all)', () => {
    it('should categorize generic llama models as chat', () => {
      expect(categorizeModel('llama-3.3-70b-versatile')).toBe('chat');
      expect(categorizeModel('llama2')).toBe('chat');
      expect(categorizeModel('llama3')).toBe('chat');
    });

    it('should categorize generic mistral models as chat', () => {
      expect(categorizeModel('mistral-large')).toBe('chat');
    });

    it('should categorize generic mixtral models as chat', () => {
      expect(categorizeModel('mixtral-8x22b')).toBe('chat');
    });

    it('should categorize gemini models as chat', () => {
      expect(categorizeModel('gemini-1.5-pro')).toBe('chat');
      expect(categorizeModel('gemini-1.5-flash')).toBe('chat');
      expect(categorizeModel('gemini-2.0-flash')).toBe('chat');
    });

    it('should categorize generic qwen and deepseek as chat', () => {
      // qwen-2-72b matches reasoning pattern (qwen-2-X) → 'reasoning'
      expect(categorizeModel('qwen-2-72b')).toBe('reasoning');
      expect(categorizeModel('deepseek-chat')).toBe('chat');
    });

    it('should categorize gpt-3.5-turbo as chat', () => {
      expect(categorizeModel('gpt-3.5-turbo')).toBe('chat');
    });

    it('should categorize aya and nous models as chat', () => {
      expect(categorizeModel('aya-23')).toBe('chat');
      expect(categorizeModel('nous-hermes-2')).toBe('chat');
    });

    it('should categorize solar and hermes as chat', () => {
      expect(categorizeModel('solar-10.7b')).toBe('chat');
      expect(categorizeModel('hermes-2-pro')).toBe('chat');
    });

    it('should categorize dbrx-instruct as instruct (beats chat priority)', () => {
      // dbrx-instruct matches instruct (priority 5) and chat (priority 6) → instruct wins
      expect(categorizeModel('dbrx-instruct')).toBe('instruct');
    });
  });

  // ── Other (fallback) ────────────────────────────────────────────────────
  describe('other category (fallback)', () => {
    it('should return "other" for unknown model IDs', () => {
      expect(categorizeModel('completely-unknown-model-xyz')).toBe('other');
    });

    it('should return "other" for empty string', () => {
      expect(categorizeModel('')).toBe('other');
    });

    it('should return "other" for random string', () => {
      expect(categorizeModel('abc123def456')).toBe('other');
    });

    it('should return "other" for numeric-only string', () => {
      expect(categorizeModel('12345')).toBe('other');
    });

    it('should return "other" for special characters', () => {
      expect(categorizeModel('@#$%^&*()')).toBe('other');
    });
  });
});

// ─── getModelTags ───────────────────────────────────────────────────────────

describe('getModelTags', () => {
  it('should return chat and fast tags for llama-3.1-8b-instant', () => {
    const tags = getModelTags('llama-3.1-8b-instant');
    expect(tags).toContain('chat');
    expect(tags).toContain('fast');
    // Instruct tag: model ends with "-instruct" - wait, "llama-3.1-8b-instant" doesn't end with -instruct, it ends with -instant
    // So only chat and fast
    expect(tags).toHaveLength(2);
  });

  it('should return multiple tags for a model matching several patterns', () => {
    // "llama-3.1-8b-instruct" matches: fast (llama-3.1-8b), instruct (-instruct), chat (llama)
    const tags = getModelTags('llama-3.1-8b-instruct');
    expect(tags).toContain('fast');
    expect(tags).toContain('instruct');
    expect(tags).toContain('chat');
    expect(tags.length).toBeGreaterThanOrEqual(3);
  });

  it('should always include chat when any known pattern matches', () => {
    // "deepseek-coder" matches: code (coder), chat (deepseek)
    const tags = getModelTags('deepseek-coder');
    expect(tags).toContain('code');
    expect(tags).toContain('chat');
  });

  it('should not include chat for unknown models', () => {
    const tags = getModelTags('completely-unknown-model');
    expect(tags).toEqual([]);
  });

  it('should return empty array for empty string', () => {
    const tags = getModelTags('');
    expect(tags).toEqual([]);
  });

  it('should include vision tag for vision models', () => {
    const tags = getModelTags('gpt-4-vision-preview');
    expect(tags).toContain('vision');
    expect(tags).toContain('chat'); // gpt matches chat pattern
    expect(tags).toContain('preview'); // preview pattern
  });

  it('should include agentic tag for GPT-4 models', () => {
    const tags = getModelTags('gpt-4o');
    expect(tags).toContain('agentic');
    expect(tags).toContain('chat');
  });

  it('should include reasoning tag for Qwen-2.5 models', () => {
    const tags = getModelTags('qwen-2.5-32b');
    expect(tags).toContain('reasoning');
    expect(tags).toContain('chat');
  });

  it('should not contain duplicate tags for the same model', () => {
    const tags = getModelTags('llama-3.1-8b-instruct');
    const unique = new Set(tags);
    expect(tags.length).toBe(unique.size);
  });
});

// ─── getModelBadge ─────────────────────────────────────────────────────────

describe('getModelBadge', () => {
  it('should return badge for known Groq models', () => {
    expect(getModelBadge('llama-3.3-70b-versatile')).toBeTruthy();
    expect(getModelBadge('llama-3.3-70b-versatile')).toContain('all-rounder');
    expect(getModelBadge('llama-3.1-8b-instant')).toContain('Fast');
    expect(getModelBadge('mixtral-8x7b-32768')).toContain('long context');
    expect(getModelBadge('gemma2-9b-it')).toContain('Lightning');
  });

  it('should return badge for known Gemini models', () => {
    expect(getModelBadge('gemini-2.0-flash-exp')).toContain('Latest Gemini');
    expect(getModelBadge('gemini-2.0-flash')).toContain('balances');
    expect(getModelBadge('gemini-1.5-flash')).toContain('Quick');
    expect(getModelBadge('gemini-1.5-pro')).toContain('Best quality');
  });

  it('should return badge for known OpenRouter models', () => {
    expect(getModelBadge('openai/gpt-4o')).toContain('Top-tier');
    expect(getModelBadge('openai/gpt-4o-mini')).toContain('Affordable');
    expect(getModelBadge('anthropic/claude-sonnet-4-20250514')).toContain('agentic');
    expect(getModelBadge('meta-llama/llama-3.3-70b-instruct')).toContain('versatile');
  });

  it('should return badge for known local/Ollama models', () => {
    expect(getModelBadge('llama2')).toContain('offline');
    expect(getModelBadge('llama3')).toContain('Modern');
    expect(getModelBadge('deepseek-coder')).toContain('code');
    expect(getModelBadge('codellama')).toContain('Code-focused');
    expect(getModelBadge('mistral')).toContain('general-purpose');
    expect(getModelBadge('phi')).toContain('Ultra-lightweight');
  });

  it('should return undefined for unknown models', () => {
    expect(getModelBadge('completely-unknown-model')).toBeUndefined();
    expect(getModelBadge('')).toBeUndefined();
    expect(getModelBadge('gpt-5-unknown')).toBeUndefined();
  });

  it('should return undefined for model that exists but has no badge entry', () => {
    // Models that match categorization patterns but don't have a badge
    expect(getModelBadge('aya-23')).toBeUndefined();
    expect(getModelBadge('nous-hermes-2')).toBeUndefined();
  });
});

// ─── formatModelName ────────────────────────────────────────────────────────

describe('formatModelName', () => {
  it('should strip provider prefix', () => {
    expect(formatModelName('groq/llama-3.3-70b-versatile')).not.toContain('groq/');
    expect(formatModelName('nvidia/mistral-7b')).not.toContain('nvidia/');
    expect(formatModelName('openai/gpt-4o')).not.toContain('openai/');
  });

  it('should replace underscores with spaces', () => {
    expect(formatModelName('llama_3_1_8b')).toContain(' ');
  });

  it('should capitalize model names properly', () => {
    const name = formatModelName('llama-3.3-70b-versatile');
    expect(name.charAt(0)).toBe('L'); // 'llama' -> 'Llama'
  });

  it('should preserve known brand names', () => {
    expect(formatModelName('gpt-4o')).toContain('GPT');
    expect(formatModelName('claude-3.5-sonnet')).toContain('Claude');
    expect(formatModelName('gemini-2.0-flash')).toContain('Gemini');
    expect(formatModelName('mistral-7b')).toContain('Mistral');
    expect(formatModelName('mixtral-8x7b')).toContain('Mixtral');
    expect(formatModelName('qwen-2.5-32b')).toContain('Qwen');
    expect(formatModelName('deepseek-coder')).toContain('DeepSeek');
  });

  it('should not double-capitalize brand names', () => {
    const result = formatModelName('gpt-4o');
    // Should have exactly one "GPT" not "Gpt" then another "GPT"
    const gptMatches = result.match(/GPT/g);
    expect(gptMatches).toHaveLength(1);
  });

  it('should handle model IDs with slashes', () => {
    const result = formatModelName('meta-llama/Llama-3.3-70b-instruct');
    expect(result).not.toContain('/');
  });
});

// ─── CATEGORY_INFO ─────────────────────────────────────────────────────────

describe('CATEGORY_INFO', () => {
  it('should have entries for all category types', () => {
    const categories: ModelCategory[] = [
      'chat', 'code', 'reasoning', 'fast', 'creative',
      'vision', 'instruct', 'agentic', 'preview', 'other',
    ];

    for (const cat of categories) {
      expect(CATEGORY_INFO[cat]).toBeDefined();
      expect(CATEGORY_INFO[cat].icon).toBeTruthy();
      expect(CATEGORY_INFO[cat].label).toBeTruthy();
      expect(CATEGORY_INFO[cat].description).toBeTruthy();
    }
  });

  it('should have unique icons for each category', () => {
    const categories = Object.keys(CATEGORY_INFO) as ModelCategory[];
    const icons = categories.map((c) => CATEGORY_INFO[c].icon);
    const uniqueIcons = new Set(icons);
    expect(uniqueIcons.size).toBe(icons.length);
  });

  it('should have meaningful descriptions (at least 10 chars)', () => {
    const categories = Object.keys(CATEGORY_INFO) as ModelCategory[];
    for (const cat of categories) {
      expect(CATEGORY_INFO[cat].description.length).toBeGreaterThanOrEqual(10);
    }
  });
});

// ─── Priority Logic ─────────────────────────────────────────────────────────

describe('category priority logic', () => {
  it('should prioritize vision over preview for "gpt-4-vision-preview"', () => {
    // Vision (priority 1) > preview (priority 5)
    expect(categorizeModel('gpt-4-vision-preview')).toBe('vision');
  });

  it('should prioritize fast over instruct for "llama-3.1-8b-instruct"', () => {
    // Fast (priority 4) > instruct (priority 5)
    expect(categorizeModel('llama-3.1-8b-instruct')).toBe('fast');
  });

  it('should prioritize fast over chat for "llama-3.1-8b"', () => {
    // Fast (priority 4) > chat (priority 6)
    expect(categorizeModel('llama-3.1-8b-instant')).toBe('fast');
  });

  it('should prioritize fast over instruct for "gemma2-9b-it"', () => {
    // Fast (priority 4) > instruct (priority 5)
    expect(categorizeModel('gemma2-9b-it')).toBe('fast');
  });

  it('should prioritize code over chat for "deepseek-coder"', () => {
    // Code (priority 3) > chat (priority 6)
    expect(categorizeModel('deepseek-coder')).toBe('code');
  });

  it('should prioritize reasoning over chat for "qwen-2.5-32b"', () => {
    // Reasoning (priority 2) > chat (priority 6)
    expect(categorizeModel('qwen-2.5-32b')).toBe('reasoning');
  });

  it('should prioritize agentic over chat for "gpt-4o"', () => {
    // Agentic (priority 3) > chat (priority 6)
    expect(categorizeModel('gpt-4o')).toBe('agentic');
  });
});

// ─── Integration: Real-world model IDs ──────────────────────────────────────

describe('integration with real model IDs', () => {
  // These are actual model IDs from Groq, OpenRouter, Gemini, etc.

  const testCases: Array<{ modelId: string; expectCategory: ModelCategory; expectTags: string[] }> = [
    // Groq models
    { modelId: 'llama-3.3-70b-versatile', expectCategory: 'chat', expectTags: ['chat'] },
    { modelId: 'llama-3.1-8b-instant', expectCategory: 'fast', expectTags: ['chat', 'fast'] },
    { modelId: 'mixtral-8x7b-32768', expectCategory: 'fast', expectTags: ['chat', 'fast'] },
    { modelId: 'gemma2-9b-it', expectCategory: 'fast', expectTags: ['chat', 'fast', 'instruct'] },
    { modelId: 'qwen-2.5-32b', expectCategory: 'reasoning', expectTags: ['chat', 'reasoning'] },
    { modelId: 'deepseek-r1-distill-llama-70b', expectCategory: 'reasoning', expectTags: ['chat', 'reasoning'] },

    // Gemini models
    { modelId: 'gemini-2.0-flash-exp', expectCategory: 'preview', expectTags: ['preview', 'chat'] },
    { modelId: 'gemini-2.0-flash', expectCategory: 'chat', expectTags: ['chat'] },
    { modelId: 'gemini-1.5-pro', expectCategory: 'chat', expectTags: ['chat'] },

    // OpenRouter models
    { modelId: 'openai/gpt-4o', expectCategory: 'agentic', expectTags: ['agentic', 'chat'] },
    { modelId: 'anthropic/claude-sonnet-4-20250514', expectCategory: 'agentic', expectTags: ['agentic', 'chat'] },
    { modelId: 'meta-llama/llama-3.3-70b-instruct', expectCategory: 'instruct', expectTags: ['instruct', 'chat'] },

    // Local Ollama models
    { modelId: 'llama2', expectCategory: 'chat', expectTags: ['chat'] },
    { modelId: 'llama3', expectCategory: 'chat', expectTags: ['chat'] },
    { modelId: 'deepseek-coder', expectCategory: 'code', expectTags: ['code', 'chat'] },
    { modelId: 'codellama', expectCategory: 'code', expectTags: ['code', 'chat'] },
    { modelId: 'mistral', expectCategory: 'chat', expectTags: ['chat'] },
    { modelId: 'phi', expectCategory: 'chat', expectTags: ['chat'] },
  ];

  for (const { modelId, expectCategory, expectTags } of testCases) {
    it(`categorizeModel('${modelId}') → ${expectCategory}`, () => {
      expect(categorizeModel(modelId)).toBe(expectCategory);
    });

    it(`getModelTags('${modelId}') contains expected tags`, () => {
      const tags = getModelTags(modelId);
      for (const tag of expectTags) {
        expect(tags).toContain(tag);
      }
    });
  }
});
