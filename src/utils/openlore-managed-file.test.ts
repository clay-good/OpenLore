import { describe, expect, it } from 'vitest';
import {
  isEntirelyOpenLoreManaged,
  OPENLORE_BLOCK_BEGIN,
  OPENLORE_BLOCK_END,
} from './openlore-managed-file.js';

describe('isEntirelyOpenLoreManaged', () => {
  it('recognizes an installer-owned markdown file but not a user file with the same block', () => {
    const block = `${OPENLORE_BLOCK_BEGIN}\n<!-- openlore-fingerprint: abc -->\nmanaged\n${OPENLORE_BLOCK_END}\n`;
    expect(isEntirelyOpenLoreManaged('AGENTS.md', block)).toBe(true);
    expect(isEntirelyOpenLoreManaged('AGENTS.md', `# User instructions\n\n${block}`)).toBe(false);
  });

  it('recognizes JSON containing only declared managed paths', () => {
    const managed = JSON.stringify({
      mcpServers: { openlore: { command: 'openlore' } },
      _openlore: { managed: true, paths: ['mcpServers.openlore'] },
    });
    const mixed = JSON.stringify({
      mcpServers: { user: { command: 'user' }, openlore: { command: 'openlore' } },
      _openlore: { managed: true, paths: ['mcpServers.openlore'] },
    });
    expect(isEntirelyOpenLoreManaged('.mcp.json', managed)).toBe(true);
    expect(isEntirelyOpenLoreManaged('.mcp.json', mixed)).toBe(false);
  });
});
