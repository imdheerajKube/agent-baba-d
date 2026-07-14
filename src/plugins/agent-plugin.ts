/**
 * AgentPlugin — Interface for third-party agent plugins and auto-discovery.
 *
 * Users can place agent plugin files in ~/.buff/agents/ and they will be
 * automatically discovered and registered with the orchestrator at startup.
 *
 * Plugin file format:
 * - Any .js file in ~/.buff/agents/
 * - Must export a default object matching the AgentPlugin interface
 * - The plugin's execute() method receives the standard AgentContext + callLLM
 *
 * Workflow plugins:
 * - Any .yaml, .yml, or .json file in ~/.buff/workflows/
 * - Defines a sequence of agent steps as a reusable workflow template
 */

import { readdirSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import type { AgentContext, AgentResult } from '../agents/agent.js';
import type { WorkflowTemplate } from '../workflow/templates.js';
import { logger } from '../utils/logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AgentPluginMetadata {
  name: string;
  version: string;
  description: string;
  author?: string;
  /** Which agent types this plugin can act as (e.g., ['writer', 'reviewer']) */
  agentTypes: string[];
}

export interface AgentPlugin {
  metadata: AgentPluginMetadata;
  execute(context: AgentContext, callLLM: (prompt: string) => Promise<string>): Promise<AgentResult>;
}

// ─── Paths ──────────────────────────────────────────────────────────────────

const BUFF_DIR = join(homedir(), '.buff');
const AGENTS_DIR = join(BUFF_DIR, 'agents');
const WORKFLOWS_DIR = join(BUFF_DIR, 'workflows');

function ensureDirectories(): void {
  for (const dir of [AGENTS_DIR, WORKFLOWS_DIR]) {
    if (!existsSync(dir)) {
      try { mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
    }
  }
}

// ─── Auto-Discovery ─────────────────────────────────────────────────────────

/**
 * Scan ~/.buff/agents/ for plugin .js files and load them.
 * Returns a map of agent type → AgentPlugin.
 */
export async function discoverAgentPlugins(): Promise<Map<string, AgentPlugin>> {
  const plugins = new Map<string, AgentPlugin>();

  ensureDirectories();

  try {
    const files = readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.js'));

    for (const file of files) {
      try {
        const pluginPath = join(AGENTS_DIR, file);
        // Dynamic import for ESM compatibility
        const plugin: { default?: AgentPlugin } = await import(pluginPath);
        if (!plugin.default || !plugin.default.metadata) {
          logger.debug(`Skipping ${file}: missing metadata or default export`);
          continue;
        }

        const agentPlugin = plugin.default;

        for (const agentType of agentPlugin.metadata.agentTypes) {
          plugins.set(agentType, agentPlugin);
          logger.success(`Discovered agent plugin: ${agentPlugin.metadata.name} v${agentPlugin.metadata.version} (${agentType})`);
        }
      } catch (err) {
        logger.debug(`Failed to load plugin ${file}: ${err}`);
      }
    }
  } catch (err) {
    logger.debug(`Failed to scan ${AGENTS_DIR}: ${err}`);
  }

  return plugins;
}

/**
 * Scan ~/.buff/workflows/ for custom workflow template files.
 * Supports .json, .yaml, and .yml files.
 */
export function discoverWorkflowPlugins(): WorkflowTemplate[] {
  const workflows: WorkflowTemplate[] = [];

  ensureDirectories();

  try {
    const files = readdirSync(WORKFLOWS_DIR).filter(
      (f) => f.endsWith('.json') || f.endsWith('.yaml') || f.endsWith('.yml'),
    );

    for (const file of files) {
      try {
        const filePath = join(WORKFLOWS_DIR, file);
        const content = readFileSync(filePath, 'utf-8');

        if (file.endsWith('.json')) {
          const parsed = JSON.parse(content);
          if (isValidWorkflowTemplate(parsed)) {
            workflows.push(parsed);
            logger.success(`Discovered workflow template: ${parsed.id} (${file})`);
          }
        } else {
          // YAML not available as dependency — skip, or use Node.js built-in
          logger.debug(`YAML workflow files not yet supported (${file}). Use .json format instead.`);
        }
      } catch (err) {
        logger.debug(`Failed to load workflow ${file}: ${err}`);
      }
    }
  } catch (err) {
    logger.debug(`Failed to scan ${WORKFLOWS_DIR}: ${err}`);
  }

  return workflows;
}

/**
 * Get plugin statistics.
 */
export function getPluginStats(): { agentPlugins: number; workflowPlugins: number } {
  let agentPlugins = 0;
  let workflowPlugins = 0;

  try {
    if (existsSync(AGENTS_DIR)) {
      agentPlugins = readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.js')).length;
    }
  } catch { /* */ }

  try {
    if (existsSync(WORKFLOWS_DIR)) {
      workflowPlugins = readdirSync(WORKFLOWS_DIR).filter(
        (f) => f.endsWith('.json') || f.endsWith('.yaml') || f.endsWith('.yml'),
      ).length;
    }
  } catch { /* */ }

  return { agentPlugins, workflowPlugins };
}

// ─── Validation ─────────────────────────────────────────────────────────────

function isValidWorkflowTemplate(obj: unknown): obj is WorkflowTemplate {
  if (typeof obj !== 'object' || obj === null) return false;
  const t = obj as Record<string, unknown>;
  return (
    typeof t.id === 'string' &&
    typeof t.name === 'string' &&
    Array.isArray(t.steps) &&
    t.steps.length > 0 &&
    t.steps.every(
      (s: unknown) =>
        typeof s === 'object' &&
        s !== null &&
        typeof (s as Record<string, unknown>).agentType === 'string' &&
        typeof (s as Record<string, unknown>).description === 'string',
    )
  );
}
