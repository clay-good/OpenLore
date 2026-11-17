/**
 * The commit gate never renames a torn decision store, and an incomplete check fails
 * the gate only under a blocking or frozen policy. Plain .test.ts so CI runs it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectGovernanceFindings } from './enforce.js';
import { loadDecisionStore } from '../../core/decisions/store.js';

const TORN = '{"decisions": [';

let root: string;
let pending: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'openlore-torn-decisions-'));
  await mkdir(join(root, '.openlore', 'decisions'), { recursive: true });
  pending = join(root, '.openlore', 'decisions', 'pending.json');
  await writeFile(pending, TORN, 'utf-8');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('loadDecisionStore readOnly', () => {
  it('throws on a torn store and leaves it in place', async () => {
    await expect(loadDecisionStore(root, { readOnly: true })).rejects.toThrow(/decision store is unreadable/);
    expect(await readFile(pending, 'utf-8')).toBe(TORN);
  });

  it('still quarantines by default', async () => {
    expect((await loadDecisionStore(root)).decisions).toEqual([]);
    const names = await readdir(join(root, '.openlore', 'decisions'));
    expect(names.some((n) => n.startsWith('pending.json.corrupt'))).toBe(true);
  });
});

describe('openlore enforce with a torn decision store', () => {
  const gated = {
    'stale-decision-reference': 'blocking',
    'decision-constraint-malformed': 'frozen',
    'decision-constraint-violation': 'blocking',
    'orphans-anchored-decision': 'blocking',
  };

  it('keeps the store in place and the gated checks failed on every run', async () => {
    for (let run = 0; run < 2; run++) {
      const collected = await collectGovernanceFindings(root, null, gated);
      expect(collected.failedCodes).toContain('stale-decision-reference');
      expect(collected.failedCodes).toContain('decision-constraint-malformed');
      expect(collected.failedCodes).toContain('decision-constraint-violation');
      expect(collected.caveats.join(' ')).toContain('decision store is unreadable');
    }
    expect(await readFile(pending, 'utf-8')).toBe(TORN);
  });

  it('keeps advisory checks fail-soft', async () => {
    const collected = await collectGovernanceFindings(root, null, {});
    for (const code of ['stale-decision-reference', 'decision-constraint-malformed', 'decision-constraint-violation']) {
      expect(collected.failedCodes.has(code)).toBe(false);
    }
    expect(await readFile(pending, 'utf-8')).toBe(TORN);
  });
});
