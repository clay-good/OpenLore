import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FunctionNode } from '../../core/analyzer/call-graph.js';
import type { FileSignatureMap } from '../../core/analyzer/signature-extractor.js';
import { VectorIndex, _resetVectorIndexCachesForTesting } from '../../core/analyzer/vector-index.js';

const writes: string[] = [];
vi.mock('../output.js', () => ({
  writeStdout: vi.fn(async (value: string) => { writes.push(value); }),
}));

import { runSearchCli } from './search.js';
import { dispatchTool } from '../../core/services/tool-dispatch.js';

describe('search CLI and MCP conclusion parity', () => {
  beforeEach(() => {
    writes.length = 0;
    _resetVectorIndexCachesForTesting();
  });

  it('returns the identical target diagnosis from both public faces', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openlore-search-parity-'));
    const outputDir = join(root, '.openlore', 'analysis');
    await mkdir(outputDir, { recursive: true });
    const nodes: FunctionNode[] = [{
      id: 'src/auth.ts::authenticate',
      name: 'authenticate',
      filePath: 'src/auth.ts',
      language: 'TypeScript',
      isAsync: false,
      startIndex: 0,
      endIndex: 0,
      fanIn: 2,
      fanOut: 0,
    }];
    const signatures: FileSignatureMap[] = [{
      path: 'src/auth.ts',
      language: 'TypeScript',
      entries: [{ kind: 'function', name: 'authenticate', signature: 'function authenticate()', docstring: 'validates credentials' }],
    }];
    await VectorIndex.build(outputDir, nodes, signatures, new Set(), new Set(), null);

    expect(await runSearchCli('authenticate', {
      cwd: root,
      json: true,
      explain: 'authenticate',
      targetKind: 'symbol',
      file: 'src/auth.ts',
    })).toBe(0);
    const cli = JSON.parse(writes.join(''));
    const mcp = await dispatchTool('explain_retrieval_miss', {
      directory: root,
      query: 'authenticate',
      surface: 'code',
      target: { kind: 'symbol', value: 'authenticate', filePath: 'src/auth.ts' },
    }, root);

    expect(cli).toEqual(mcp);
    expect(cli).toMatchObject({ surfaced: true, rank: 1, matchEvidence: { field: 'symbol', tier: 1 } });
  });
});
