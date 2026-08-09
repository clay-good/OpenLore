/**
 * `recall` surfaces the stale-decision-reference signal on an authoritative memory
 * whose content references a superseded decision (change: add-finding-enforcement-policy).
 * Guards mcp-handlers/StaleDecisionReferenceSurfacedThroughExistingTools.
 *
 * Runs end-to-end over a real edge store + memory store + decision store so the
 * freshness verdict (fresh anchor) and the retirement graph are both real. Plain
 * .test.ts so CI runs it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EdgeStore } from '../edge-store.js';
import {
  OPENLORE_DIR,
  OPENLORE_ANALYSIS_SUBDIR,
  OPENLORE_DECISIONS_SUBDIR,
  DECISIONS_PENDING_FILE,
} from '../../../constants.js';
import { handleRemember, handleRecall } from './memory.js';
import type { FunctionNode } from '../../analyzer/call-graph.js';
import type { DecisionStore, PendingDecision } from '../../../types/index.js';

let root: string;
const FOO_SRC = 'export function foo() {\n  return 1;\n}\n';

function node(filePath: string, name: string, src: string): FunctionNode {
  return {
    id: `${filePath}::${name}`, name, filePath, isAsync: false, language: 'typescript',
    startIndex: 0, endIndex: Buffer.byteLength(src, 'utf-8'),
    startLine: 1, endLine: src.split('\n').length, fanIn: 0, fanOut: 0,
  };
}

async function buildStore(nodes: FunctionNode[]): Promise<void> {
  const dir = join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
  await mkdir(dir, { recursive: true });
  const store = EdgeStore.open(EdgeStore.dbPath(dir));
  store.clearAll();
  store.insertNodes(nodes);
  store.close();
}

function decision(p: Partial<PendingDecision> & { id: string }): PendingDecision {
  return {
    id: p.id, status: p.status ?? 'approved', title: p.title ?? `d ${p.id}`,
    rationale: p.rationale ?? '', consequences: '', proposedRequirement: null,
    affectedDomains: [], affectedFiles: [], supersedes: p.supersedes,
    sessionId: 's1', recordedAt: '2026-06-23T00:00:00Z', contentOrigin: 'agent-recorded', confidence: 'high', syncedToSpecs: [],
  };
}

async function writeDecisions(decisions: PendingDecision[]): Promise<void> {
  const dir = join(root, OPENLORE_DIR, OPENLORE_DECISIONS_SUBDIR);
  await mkdir(dir, { recursive: true });
  const store: DecisionStore = { version: '1', sessionId: 's1', updatedAt: '2026-06-23T00:00:00Z', decisions };
  await writeFile(join(dir, DECISIONS_PENDING_FILE), JSON.stringify(store, null, 2) + '\n', 'utf-8');
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'openlore-staleref-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'foo.ts'), FOO_SRC, 'utf-8');
  await buildStore([node('src/foo.ts', 'foo', FOO_SRC)]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

type RecallItem = { id: string; freshness: string; verify?: boolean; verifiedCurrent?: boolean; staleDecisionRef?: Array<{ retired: string; supersededBy: string }> };
type RecallResult = { authoritative: RecallItem[]; note?: string };

const fooAnchor = [{ symbol: 'foo', file: 'src/foo.ts' }];

it('flags an authoritative memory resting on a retired decision', async () => {
  await writeDecisions([
    decision({ id: 'bbbbbbbb', title: 'use bcrypt' }),
    decision({ id: 'cccccccc', title: 'use argon2', supersedes: 'bbbbbbbb' }),
  ]);
  const { id } = (await handleRemember(root, 'password hashing follows bbbbbbbb', fooAnchor)) as { id: string };

  const rec = (await handleRecall(root)) as RecallResult;
  const item = rec.authoritative.find((i) => i.id === id)!;
  expect(item).toBeDefined();
  expect(item.freshness).toBe('fresh');
  // The signal is present, names the retired target + superseder, and the memory is
  // NOT presented as cleanly fresh (no verifiedCurrent; verify prompted).
  expect(item.staleDecisionRef).toEqual([{ retired: 'bbbbbbbb', supersededBy: 'cccccccc' }]);
  expect(item.verifiedCurrent).toBeUndefined();
  expect(item.verify).toBe(true);
  expect(rec.note).toContain('superseded decision');
});

it('a memory citing a LIVE decision is clean (no signal)', async () => {
  await writeDecisions([
    decision({ id: 'bbbbbbbb', title: 'use bcrypt' }),
    decision({ id: 'cccccccc', title: 'use argon2', supersedes: 'bbbbbbbb' }),
  ]);
  const { id } = (await handleRemember(root, 'password hashing follows cccccccc', fooAnchor)) as { id: string };

  const rec = (await handleRecall(root)) as RecallResult;
  const item = rec.authoritative.find((i) => i.id === id)!;
  expect(item.staleDecisionRef).toBeUndefined();
});

describe('placeholder for grouping', () => {
  it('no decisions ⇒ no signal', async () => {
    const { id } = (await handleRemember(root, 'cites bbbbbbbb but nothing retired', fooAnchor)) as { id: string };
    const rec = (await handleRecall(root)) as RecallResult;
    expect(rec.authoritative.find((i) => i.id === id)!.staleDecisionRef).toBeUndefined();
  });
});
