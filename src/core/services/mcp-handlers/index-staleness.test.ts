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

  it('discloses an unsafe payload citation without reading or repairing it', async () => {
    const repair = vi.fn(() => true);
    registerRepairHost(root, repair);
    const result = await computeIndexStaleness(root, { filePath: '../../secret.ts' }, {
      artifactMtimeMs: Number.MAX_SAFE_INTEGER,
    });
    expect(result?.staleFiles).toEqual(['[unsafe cited path]']);
    expect(result?.repairScheduled).toBeUndefined();
    expect(repair).not.toHaveBeenCalled();
  });

  it('bounds explicit graph citations and repairs only the checked batch', async () => {
    const repair = vi.fn((_files: readonly string[]) => true);
    registerRepairHost(root, repair);
    const files = Array.from({ length: 205 }, (_, i) => `src/missing-${i}.ts`);
    const result = await computeIndexStaleness(
      root,
      null,
      { artifactMtimeMs: Number.MAX_SAFE_INTEGER },
      files,
    );
    expect(result?.staleFiles).toHaveLength(200);
    expect(result?.uncheckedCitations).toBe(true);
    expect(repair).toHaveBeenCalledOnce();
    expect(repair.mock.calls[0][0]).toHaveLength(200);
  });
});
