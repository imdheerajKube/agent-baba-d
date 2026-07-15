/**
 * Model Catalog — Categorizes AI models by capability so users can pick
 * the right model for their task.
 *
 * Each model is tagged with one or more categories based on its ID pattern.
 * The model picker uses these categories to group models with icons,
 * descriptions, and recommendation badges.
 */

// ─── Category Types ─────────────────────────────────────────────────────────

/** Category identifier used internally */
export type ModelCategory =
  | 'chat'        // General conversation
  | 'code'        // Code generation / programming
  | 'reasoning'   // Complex reasoning / logic / math
  | 'fast'        // Low-latency / lightweight
  | 'creative'    // Creative writing / storytelling
  | 'vision'      // Multimodal / image understanding
  | 'instruct'    // Instruction-following fine-tunes
  | 'agentic'     // Tool-use / function-calling
  | 'preview'     // Latest preview / experimental
  | 'other';      // Fallback

/** Display metadata for each category */
export interface CategoryInfo {
  /** Icon shown next to the category header */
  icon: string;
  /** Short human-readable label */
  label: string;
  /** Explanation of what this category is good for */
  description: string;
}

/**
 * Display info for every category.
 * Ordered roughly by popularity / usefulness.
 */
export const CATEGORY_INFO: Record<ModelCategory, CategoryInfo> = {
  chat: {
    icon: '💬',
    label: 'Chat',
    description: 'General conversation, Q&A, and everyday tasks',
  },
  code: {
    icon: '💻',
    label: 'Code',
    description: 'Code generation, debugging, and programming tasks',
  },
  reasoning: {
    icon: '🧠',
    label: 'Reasoning',
    description: 'Complex problem-solving, math, and logic',
  },
  fast: {
    icon: '⚡',
    label: 'Fast',
    description: 'Low-latency responses — best for quick iterations',
  },
  creative: {
    icon: '🎨',
    label: 'Creative',
    description: 'Creative writing, storytelling, and brainstorming',
  },
  vision: {
    icon: '👁️',
    label: 'Vision',
    description: 'Image understanding and multimodal tasks',
  },
  instruct: {
    icon: '🎯',
    label: 'Instruct',
    description: 'Instruction-tuned models for structured output',
  },
  agentic: {
    icon: '🤖',
    label: 'Agentic',
    description: 'Tool-use, function-calling, and autonomous agents',
  },
  preview: {
    icon: '🧪',
    label: 'Preview',
    description: 'Experimental / preview — may not be production-ready',
  },
  other: {
    icon: '🔹',
    label: 'Other',
    description: 'Uncategorized models',
  },
};

// ─── Pattern Scanner ────────────────────────────────────────────────────────

interface CategoryMatch {
  category: ModelCategory;
  /** Priority: lower = higher priority when multiple patterns match */
  priority: number;
}

/**
 * Ordered list of pattern matchers.
 * Each entry has a list of regex patterns to test against the model ID,
 * and the category to assign when any pattern matches.
 *
 * Only the LOWEST-priority match is kept (i.e., the most specific pattern wins).
 */
const CATEGORY_PATTERNS: Array<{
  patterns: RegExp[];
  category: ModelCategory;
  priority: number;
}> = [
  // ── Vision / Multimodal (most specific first) ──────────────────────────
  { patterns: [/vision/i, /multimodal/i], category: 'vision', priority: 1 },
  // ── Reasoning / Thinking ───────────────────────────────────────────────
  {
    patterns: [
      /qwen-2(?:\.5)?-(?:\d+)?b?(?:\d+)?-?(?:instruct|reasoning)?$/i,
      /deepseek-r1/i,
      /deepseek-(?:v2|v3)/i,
      /reasoning/i,
      /think/i,
    ],
    category: 'reasoning',
    priority: 2,
  },
  // ── Agentic / Tool-use ─────────────────────────────────────────────────
  {
    patterns: [
      /function-call/i,
      /tool-use/i,
      /agent/i,
      /claude.*(?:opus|sonnet)/i,
      /gpt-4/i,
    ],
    category: 'agentic',
    priority: 3,
  },
  // ── Code ───────────────────────────────────────────────────────────────
  {
    patterns: [
      /coder/i,
      /code-/i,
      /code\b/i,
      /deepseek-coder/i,
      /codellama/i,
      /codegemma/i,
      /starcoder/i,
      /qwen-coder/i,
      /wizardcoder/i,
      /codeqwen/i,
    ],
    category: 'code',
    priority: 3,
  },
  // ── Fast / Lightweight ─────────────────────────────────────────────────
  {
    patterns: [
      /llama-3[._-]1-8b/i,
      /llama-3[._-]2-3b/i,
      /llama-?-3b/i,
      /gemma-?2-?9b/i,
      /gemma-?2-?2b/i,
      /mistral-7b/i,
      /mixtral-8x7b/i,
      /phi-?3/i,
      /phi-?3?-?mini/i,
    ],
    category: 'fast',
    priority: 4,
  },
  // ── Preview / Experimental ─────────────────────────────────────────────
  {
    patterns: [
      /preview/i,
      /exp$/i,
      /experimental/i,
      /flash-exp/i,
    ],
    category: 'preview',
    priority: 5,
  },
  // ── Instruct / Structured ──────────────────────────────────────────────
  {
    patterns: [
      /-it$/i,
      /-instruct/i,
      /instruct$/i,
    ],
    category: 'instruct',
    priority: 5,
  },
  // ── Chat / General (most broad — catch-all for known chat models) ──────
  {
    patterns: [
      /llama/i,
      /mistral/i,
      /mixtral/i,
      /gemma/i,
      /gemini/i,
      /qwen/i,
      /deepseek/i,
      /claude/i,
      /gpt/i,
      /phi/i,
      /command\b/i,
      /aya/i,
      /nous/i,
      /hermes/i,
      /dbrx/i,
      /solar/i,
      /wizard/i,
    ],
    category: 'chat',
    priority: 6,
  },
];

/**
 * Determine the category for a given model ID.
 * Uses pattern matching against known model naming conventions.
 *
 * @param modelId The model identifier (e.g., "llama-3.3-70b-versatile")
 * @param owner   Optional owner/organization hint (e.g., "meta", "google")
 * @returns The best-matching category, defaulting to 'other'
 */
export function categorizeModel(modelId: string, _owner?: string): ModelCategory {
  let bestCategory: ModelCategory = 'other';
  let bestPriority = Infinity;
  let bestIndex = -1;

  for (let i = 0; i < CATEGORY_PATTERNS.length; i++) {
    const entry = CATEGORY_PATTERNS[i];
    for (const pattern of entry.patterns) {
      if (pattern.test(modelId)) {
        if (entry.priority < bestPriority) {
          bestCategory = entry.category;
          bestPriority = entry.priority;
          bestIndex = i;
        }
        break; // Only first matching pattern per entry
      }
    }
  }

  // If the model matched "fast" or "preview" but also has a broader category,
  // use the broader category for display but keep the tag
  // (tags will be handled separately)
  return bestCategory;
}

/**
 * Get ALL applicable category tags for a model.
 * This returns multiple categories so a model can be shown in multiple groups.
 *
 * Example: "llama-3.1-8b-instant" → ['chat', 'fast', 'instruct']
 */
export function getModelTags(modelId: string, _owner?: string): string[] {
  const tags: string[] = [];

  for (const entry of CATEGORY_PATTERNS) {
    for (const pattern of entry.patterns) {
      if (pattern.test(modelId)) {
        tags.push(entry.category);
        break;
      }
    }
  }

  // Always include 'chat' for any model that has recognizable patterns
  // (even code models can do chat)
  const hasKnownPattern = tags.length > 0;
  if (hasKnownPattern && !tags.includes('chat')) {
    tags.push('chat');
  }

  return tags;
}

/**
 * Returns a human-friendly label for a model ID, stripping provider prefixes
 * and formatting nicely.
 *
 * Example: "meta-llama/llama-3.3-70b-instruct" → "Llama 3.3 70B Instruct"
 */
export function formatModelName(modelId: string): string {
  // Strip provider prefix (e.g., "groq/", "nvidia/")
  let name = modelId.replace(/^[^/]+\//, '');

  // Replace separators
  name = name.replace(/[/_]/g, ' ');

  // Capitalize first letter of each segment
  name = name.replace(/\b\w/g, (c) => c.toUpperCase());

  // Fix common renames
  name = name.replace(/\bLlama\b/g, 'Llama');
  name = name.replace(/\bGpt\b/g, 'GPT');
  name = name.replace(/\bClaude\b/g, 'Claude');
  name = name.replace(/\bGemma\b/g, 'Gemma');
  name = name.replace(/\bGemini\b/g, 'Gemini');
  name = name.replace(/\bMistral\b/g, 'Mistral');
  name = name.replace(/\bMixtral\b/g, 'Mixtral');
  name = name.replace(/\bQwen\b/g, 'Qwen');
  name = name.replace(/\bDeepseek\b/g, 'DeepSeek');

  return name;
}

/**
 * Get a recommendation badge / description for a model.
 * Some well-known models get a short blurb about what they excel at.
 */
export function getModelBadge(modelId: string): string | undefined {
  const badges: Record<string, string> = {
    // Groq
    'llama-3.3-70b-versatile': 'Best all-rounder — strong at chat, code, and reasoning',
    'llama-3.1-8b-instant': 'Fast & capable — great for quick iterations',
    'mixtral-8x7b-32768': 'Excellent for long context (32K tokens)',
    'gemma2-9b-it': 'Lightning fast — ideal for simple tasks',
    'qwen-2.5-32b': 'Excellent reasoning and multilingual support',
    'qwen-qwen-2.5-32b': 'Excellent reasoning and multilingual support',
    'deepseek-r1-distill-llama-70b': 'Strong reasoning with distilled efficiency',
    'deepseek-r1-distill-qwen-32b': 'Excellent reasoning in a compact package',

    // Gemini
    'gemini-2.0-flash-exp': 'Latest Gemini — fast, multimodal, strong all-around',
    'gemini-2.0-flash': 'Fast & capable — balances speed and quality',
    'gemini-1.5-flash': 'Quick responses with good quality',
    'gemini-1.5-pro': 'Best quality — slower but more accurate',

    // OpenRouter common
    'mistralai/mistral-7b-instruct': 'Lightweight instruct model — good for simple tasks',
    'openai/gpt-4o': 'Top-tier — best for complex tasks',
    'openai/gpt-4o-mini': 'Affordable & fast — great for everyday use',
    'anthropic/claude-sonnet-4-20250514': 'Excellent for agentic tasks and long context',
    'anthropic/claude-3.5-sonnet': 'Balanced quality and speed',
    'meta-llama/llama-3.3-70b-instruct': 'Strong open-weight model — versatile and capable',

    // Local / Ollama
    'llama2': 'Original Llama — works offline',
    'llama3': 'Modern open-weight chat model',
    'deepseek-coder': 'Specialized for code — great for programming',
    'codellama': 'Code-focused Llama variant',
    'mistral': 'Solid general-purpose model',
    'phi': 'Ultra-lightweight — runs on any hardware',
  };

  return badges[modelId];
}
