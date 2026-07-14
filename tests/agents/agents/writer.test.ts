import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WriterAgent } from '../../../src/agents/agents/writer.js';

describe('WriterAgent', () => {
  let writer: WriterAgent;
  let tmpDir: string;
  let workingDir: string;

  beforeEach(() => {
    writer = new WriterAgent();
    tmpDir = mkdtempSync(join(tmpdir(), 'buff-writer-test-'));
    workingDir = tmpDir;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('parseFileChanges (private method access via prototype)', () => {
    const parse = (response: string, wd?: string) =>
      (writer as any).parseFileChanges.call(writer, response, wd || workingDir);

    // ─── Standard Formats ───────────────────────────────────────────────

    it('should parse ```filepath:path format', () => {
      const response = '```filepath:src/new-file.ts\nconst x = 1;\n```';

      const changes = parse(response);
      expect(changes).toHaveLength(1);
      expect(changes[0].path).toBe('src/new-file.ts');
      expect(changes[0].newContent).toBe('const x = 1;');
      expect(changes[0].status).toBe('created');
    });

    it('should parse ```language filepath:path format', () => {
      const response = '```typescript filepath:src/hello.ts\nconst msg = "hello";\n```';

      const changes = parse(response);
      expect(changes).toHaveLength(1);
      expect(changes[0].path).toBe('src/hello.ts');
      expect(changes[0].newContent).toBe('const msg = "hello";');
    });

    it('should parse path directly after opening fence', () => {
      const response = '```src/app.ts\nconsole.log("app");\n```';

      const changes = parse(response);
      expect(changes).toHaveLength(1);
      expect(changes[0].path).toBe('src/app.ts');
      expect(changes[0].newContent).toBe('console.log("app");');
    });

    it('should parse path with extension only (no directory)', () => {
      const response = '```filepath:helpers.ts\nconst help = true;\n```';

      const changes = parse(response);
      expect(changes).toHaveLength(1);
      expect(changes[0].path).toBe('helpers.ts');
    });

    // ─── Multiple Files ─────────────────────────────────────────────────

    it('should parse multiple code blocks in one response', () => {
      const response = [
        '```filepath:src/a.ts\nconst a = 1;\n```',
        'Some explanation text',
        '```filepath:src/b.ts\nconst b = 2;\n```',
      ].join('\n\n');

      const changes = parse(response);
      expect(changes).toHaveLength(2);
      expect(changes[0].path).toBe('src/a.ts');
      expect(changes[1].path).toBe('src/b.ts');
    });

    // ─── Edge Cases ─────────────────────────────────────────────────────

    it('should skip bare language tag blocks (no file path)', () => {
      const response = '```typescript\nconst x = 1;\n```';

      const changes = parse(response);
      expect(changes).toHaveLength(0);
    });

    it('should skip code blocks without any path', () => {
      const response = '```\ncode here\n```';

      const changes = parse(response);
      expect(changes).toHaveLength(0);
    });

    it('should return empty array for plain text with no code blocks', () => {
      const response = 'I think you should modify src/index.ts to add the help command.';

      const changes = parse(response);
      expect(changes).toHaveLength(0);
    });

    it('should return empty array for empty response', () => {
      expect(parse('')).toEqual([]);
    });

    it('should handle mixed content with valid and invalid blocks', () => {
      const response = [
        '```typescript\nconst x = 1;\n```', // No path — should skip
        '```filepath:src/valid.ts\nconst y = 2;\n```', // Valid
        '```\nplain block\n```', // No language, no path — should skip
      ].join('\n\n');

      const changes = parse(response);
      expect(changes).toHaveLength(1);
      expect(changes[0].path).toBe('src/valid.ts');
    });

    it('should handle file paths with quotes', () => {
      const response = '```filepath:"src/with-quotes.ts"\nconst q = "quoted";\n```';

      const changes = parse(response);
      expect(changes).toHaveLength(1);
      // Quotes should be stripped
      expect(changes[0].path).toBe('src/with-quotes.ts');
    });

    // ─── Detecting Modified vs Created ──────────────────────────────────

    it('should detect modified files when content differs', () => {
      const filePath = join(tmpDir, 'existing.ts');
      writeFileSync(filePath, 'const original = "old";', 'utf-8');

      const absPath = tmpDir; // This is the workingDir
      const response = '```filepath:existing.ts\nconst updated = "new";\n```';

      const changes = parse(response, tmpDir);
      expect(changes).toHaveLength(1);
      expect(changes[0].path).toBe('existing.ts');
      expect(changes[0].status).toBe('modified');
      expect(changes[0].originalContent).toBe('const original = "old";');
      expect(changes[0].newContent).toBe('const updated = "new";');
    });

    it('should NOT report change when content is identical', () => {
      const filePath = join(tmpDir, 'same.ts');
      writeFileSync(filePath, 'const x = 1;', 'utf-8');

      const response = '```filepath:same.ts\nconst x = 1;\n```';

      const changes = parse(response, tmpDir);
      expect(changes).toHaveLength(0);
    });

    it('should detect created files when file does not exist', () => {
      const response = '```filepath:brand-new.ts\nconst fresh = "new";\n```';

      const changes = parse(response, tmpDir);
      expect(changes).toHaveLength(1);
      expect(changes[0].status).toBe('created');
      expect(changes[0].originalContent).toBeUndefined();
    });

    // ─── File Path Normalization ────────────────────────────────────────

    it('should handle paths with ./ prefix', () => {
      const response = '```filepath:./src/relative.ts\nconst r = "relative";\n```';

      const changes = parse(response);
      expect(changes).toHaveLength(1);
      expect(changes[0].path).toBe('./src/relative.ts');
    });

    it('should handle absolute paths', () => {
      const absPath = join(tmpDir, 'absolute.ts');
      writeFileSync(absPath, 'const a = "abs";', 'utf-8');

      const response = `\`\`\`filepath:${absPath}\nconst a = "modified";\n\`\`\``;

      const changes = parse(response, tmpDir);
      expect(changes).toHaveLength(1);
      expect(changes[0].status).toBe('modified');
    });

    // ─── Realistic LLM Output ───────────────────────────────────────────

    it('should handle realistic multi-file LLM response', () => {
      const response = [
        'Here are the changes I made:',
        '',
        '```filepath:src/cli/help.ts',
        'import { Command } from "commander";',
        '',
        'export function createHelpCommand(): Command {',
        '  const cmd = new Command("help");',
        '  cmd.description("Show help information");',
        '  return cmd;',
        '}',
        '```',
        '',
        'And I also updated the router:',
        '',
        '```typescript filepath:src/cli/router.ts',
        'import { createHelpCommand } from "./help.js";',
        '// ... rest of file',
        'program.addCommand(createHelpCommand());',
        '```',
      ].join('\n');

      const changes = parse(response);
      expect(changes).toHaveLength(2);
      expect(changes.map((c: any) => c.path)).toContain('src/cli/help.ts');
      expect(changes.map((c: any) => c.path)).toContain('src/cli/router.ts');
    });
  });

  describe('metadata', () => {
    it('should have correct name and description', () => {
      expect(writer.name).toBe('Writer');
      expect(writer.description).toContain('Generates code changes');
    });
  });
});
