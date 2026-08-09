import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetRepairServiceForTesting,
  registerRepairHost,
} from '../cold-start-bootstrap.js';
import { computeIndexStaleness } from './index-staleness.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'openlore-index-staleness-'));
  mkdirSync(join(root, '.openlore', 'analysis'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, '.openlore', 'analysis', 'llm-context.json'), '{}');
  writeFileSync(join(root, 'src', 'payments.ts'), 'export function refundCard() {}\n');
});

afterEach(() => {
  _resetRepairServiceForTesting();
  rmSync(root, { recursive: true, force: true });
});

describe('computeIndexStaleness', () => {
  it('serves a stale disclosure without claiming repair when no host is active', async () => {
    const result = await computeIndexStaleness(
      root,
      { result: { filePath: 'src/payments.ts' } },
      { artifactMtimeMs: 0 },
    );

    expect(result?.staleFiles).toEqual(['src/payments.ts']);
    expect(result?.repairScheduled).toBeUndefined();
  });

  it('hands one stale cited-file batch to the exact host and reports acceptance', async () => {
    const repair = vi.fn(() => true);
    registerRepairHost(root, repair);

    const result = await computeIndexStaleness(
      root,
      { results: [{ filePath: 'src/payments.ts' }, { filePath: 'src/payments.ts' }] },
      { artifactMtimeMs: 0 },
    );

    expect(repair).toHaveBeenCalledOnce();
    expect(repair).toHaveBeenCalledWith(['src/payments.ts']);
    expect(result?.repairScheduled).toBe(true);
  });

  it('omits the boundary for a cited file older than the served generation', async () => {
    utimesSync(join(root, 'src', 'payments.ts'), 100, 100);
    expect(await computeIndexStaleness(
      root,
      { filePath: 'src/payments.ts' },
      { artifactMtimeMs: 200_000 },
    )).toBeUndefined();
  });
});
