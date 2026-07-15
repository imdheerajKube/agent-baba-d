/**
 * File Tree Utility — Builds a text representation of a project directory tree.
 *
 * Extracted from ContextGathererAgent so both the Planner and Gatherer
 * can share the same file-tree logic.
 *
 * Usage:
 *   const tree = await buildProjectFileTree(process.cwd());
 *   // Returns something like:
 *   // 📂 src/
 *   //   📂 agents/
 *   //     📄 agent.ts
 *   //     📄 orchestrator.ts
 *   // 📄 package.json
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** File extensions considered as source code */
const SOURCE_EXTENSIONS = new Set([
  '.ts', '.js', '.tsx', '.jsx',
  '.go', '.py', '.rs', '.rb', '.java', '.kt',
  '.json', '.yaml', '.yml', '.md', '.toml', '.xml',
  '.css', '.scss', '.html', '.vue', '.svelte',
  '.sh', '.bash', '.zsh',
  '.c', '.cpp', '.h', '.hpp',
  '.swift', '.kt', '.kts',
]);

/** Directories to skip during traversal */
const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next',
  '.cache', 'coverage', '.nyc_output', '__pycache__',
  '.venv', 'venv', '.env', '.ruff_cache',
  'target', 'bin', 'obj',
]);

/**
 * Recursively build a text representation of the project file tree.
 *
 * @param dir   Absolute path to the directory to scan
 * @param prefix  Indentation prefix (used internally for recursion)
 * @returns       A formatted string showing the directory structure
 */
export async function buildProjectFileTree(dir: string, prefix = ''): Promise<string> {
  const lines: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return '';
  }

  // Sort: directories first, then alphabetical
  entries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      lines.push(`${prefix}📂 ${entry.name}/`);
      const subTree = await buildProjectFileTree(join(dir, entry.name), `${prefix}  `);
      if (subTree) lines.push(subTree);
    } else if (entry.isFile()) {
      const ext = entry.name.slice(entry.name.lastIndexOf('.'));
      if (SOURCE_EXTENSIONS.has(ext)) {
        lines.push(`${prefix}📄 ${entry.name}`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Truncate a file tree to a maximum number of lines to keep prompts manageable.
 */
export function truncateTree(tree: string, maxLines: number): string {
  const lines = tree.split('\n');
  if (lines.length <= maxLines) return tree;
  // Keep first 80% of lines from the top and last 20% from the bottom
  const keepTop = Math.floor(maxLines * 0.8);
  const keepBottom = maxLines - keepTop;
  return [
    ...lines.slice(0, keepTop),
    `  ... (${lines.length - maxLines} more files)`,
    ...lines.slice(lines.length - keepBottom),
  ].join('\n');
}
