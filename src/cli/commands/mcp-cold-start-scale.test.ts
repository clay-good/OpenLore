import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

describe('MCP cold-start scale boundary', () => {
  it('uses the child-process builder and never awaits watcher startup on a tool call', () => {
    const source = readFileSync(fileURLToPath(new URL('./mcp.ts', import.meta.url)), 'utf8');
    expect(source).toContain('buildIndexInChildProcess(dir, { repair: true })');
    expect(source).toContain('analyze: buildIndexInChildProcess');
    expect(source).not.toContain('await autoWatcher.start()');
    expect(source).not.toMatch(/import\(['"]\.\.\/install\/index\.js['"]\)/);
  });
});
