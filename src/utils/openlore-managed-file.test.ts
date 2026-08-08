import { describe, expect, it } from 'vitest';
import {
  isEntirelyOpenLoreManaged,
} from './openlore-managed-file.js';
import { renderBlock } from '../cli/install/block.js';
import { mergeEntries } from '../cli/install/json-managed.js';
import { createHash } from 'node:crypto';

describe('isEntirelyOpenLoreManaged', () => {
  it('recognizes an installer-owned markdown file but not a user file with the same block', () => {
    const block = `${renderBlock('managed')}\n`;
    expect(isEntirelyOpenLoreManaged('AGENTS.md', block)).toBe(true);
    expect(isEntirelyOpenLoreManaged('AGENTS.md', `# User instructions\n\n${block}`)).toBe(false);
    expect(isEntirelyOpenLoreManaged('AGENTS.md', block.replace('managed', 'tampered'))).toBe(false);
  });

  it('recognizes JSON containing only declared managed paths', () => {
    const entry = { path: 'mcpServers.openlore', value: { command: 'openlore' } };
    const managed = JSON.stringify(mergeEntries({}, [entry]).next);
    const mixed = JSON.stringify(mergeEntries({ mcpServers: { user: { command: 'user' } } }, [entry]).next);
    expect(isEntirelyOpenLoreManaged('.mcp.json', managed)).toBe(true);
    expect(isEntirelyOpenLoreManaged('.mcp.json', mixed)).toBe(false);
    expect(isEntirelyOpenLoreManaged('.mcp.json', managed.replace('openlore', 'tampered'))).toBe(false);
  });

  it('recognizes Cursor whole-file MDC content only when its body matches the fingerprint', () => {
    const body = 'managed cursor instructions';
    const hash = createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 16);
    const mdc = `---\ndescription: OpenLore orient() workflow\nalwaysApply: true\nopenlore-fingerprint: ${hash}\n---\n\n${body}\n`;
    expect(isEntirelyOpenLoreManaged('.cursor/rules/openlore.mdc', mdc)).toBe(true);
    expect(isEntirelyOpenLoreManaged('.cursor/rules/openlore.mdc', mdc.replace(body, 'tampered'))).toBe(false);
    expect(isEntirelyOpenLoreManaged('.cursor/rules/openlore.mdc', mdc.replace('alwaysApply: true', 'alwaysApply: false'))).toBe(false);
    expect(isEntirelyOpenLoreManaged('.cursor/rules/openlore.mdc', mdc.replace('---\n\n', 'globs: src/**\n---\n\n'))).toBe(false);
  });
});
