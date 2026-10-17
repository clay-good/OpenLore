/** orient --inject suggests only tools the wired MCP surface exposes. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../core/services/mcp-handlers/orient.js', () => ({
  handleOrient: vi.fn(async () => ({
    task: 'add rate limiting to the API',
    relevantFiles: ['src/api/run.ts', 'src/api/limit.ts'],
    relevantFunctions: [
      { name: 'openloreRun', filePath: 'src/api/run.ts', score: 0.8, fanIn: 3 },
      { name: 'applyLimit', filePath: 'src/api/limit.ts', score: 0.7, fanIn: 1 },
    ],
    specDomains: ['api'],
    callPaths: [{ function: 'openloreRun', callers: [{ name: 'main', filePath: 'src/cli/index.ts' }], callees: [] }],
    suggestedTools: ['record_decision', 'get_subgraph', 'check_spec_drift'],
  })),
}));

const { buildInjection } = await import('./orient-inject.js');

describe('buildInjection suggested tools', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'openlore-inject-tools-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('drops tools outside the default substrate surface when unwired', async () => {
    const block = await buildInjection(dir, 'add rate limiting to the API');
    expect(block).toContain('Suggested tools: get_subgraph');
    expect(block).not.toContain('record_decision');
    expect(block).not.toContain('check_spec_drift');
  });

  it('keeps every tool when the full surface is wired', async () => {
    await writeFile(join(dir, '.mcp.json'), JSON.stringify({
      mcpServers: { openlore: { command: 'openlore', args: ['mcp', '--preset', 'full'] } },
    }));
    const block = await buildInjection(dir, 'add rate limiting to the API');
    expect(block).toContain('Suggested tools: record_decision, get_subgraph, check_spec_drift');
  });

  it('honors a user-scope full preset when the repository wires nothing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'openlore-inject-home-'));
    vi.stubEnv('OPENLORE_HOME', home);
    try {
      await writeFile(join(home, '.claude.json'), JSON.stringify({
        mcpServers: { openlore: { command: '/usr/bin/node', args: ['/x/cli.js', 'mcp', '--preset', 'full'] } },
      }));
      const block = await buildInjection(dir, 'add rate limiting to the API');
      expect(block).toContain('Suggested tools: record_decision, get_subgraph, check_spec_drift');
    } finally {
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  });
});
