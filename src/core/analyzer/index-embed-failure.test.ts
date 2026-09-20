/**
 * A semantic-index failure has to survive the process that saw it
 * (change: make-index-self-state-honest).
 *
 * On 2026-09-20 `[mcp-watcher] embed error: fetch failed` was written to
 * `.openlore/serve.log` eleven times while `doctor` reported a healthy endpoint and every
 * query served keyword results. The log is not a surface anyone consults; the index
 * receipt is.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearIndexEmbedFailure,
  readIndexReceipt,
  recordIndexEmbedFailure,
} from './analysis-indexes.js';

const RECEIPT = 'analysis-indexes.json';

describe('index embed failures are recorded where index-state surfaces read', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openlore-embed-failure-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('records the reason, the endpoint and when it happened', async () => {
    await recordIndexEmbedFailure(dir, { reason: 'fetch failed', endpoint: 'http://127.0.0.1:8765/v1' });

    const receipt = await readIndexReceipt(dir);
    expect(receipt?.embedFailure).toMatchObject({
      reason: 'fetch failed',
      endpoint: 'http://127.0.0.1:8765/v1',
    });
    expect(Date.parse(receipt!.embedFailure!.at)).not.toBeNaN();
  });

  it('preserves an existing receipt while adding the failure', async () => {
    await writeFile(join(dir, RECEIPT), JSON.stringify({
      generationId: 'generation-1',
      configurationHash: 'hash-1',
      result: { functionIndex: 'built', textIndex: 'built', specIndex: 'built', degraded: [] },
    }), 'utf-8');

    await recordIndexEmbedFailure(dir, { reason: 'fetch failed' });

    const raw = JSON.parse(await readFile(join(dir, RECEIPT), 'utf-8')) as Record<string, unknown>;
    expect(raw.generationId).toBe('generation-1');
    expect(raw.configurationHash).toBe('hash-1');
    expect(raw.embedFailure).toMatchObject({ reason: 'fetch failed' });
  });

  it('clears the failure once the same path succeeds', async () => {
    await recordIndexEmbedFailure(dir, { reason: 'fetch failed' });

    await clearIndexEmbedFailure(dir);

    expect((await readIndexReceipt(dir))?.embedFailure).toBeUndefined();
  });

  it('reports no receipt at all for a directory that has none', async () => {
    expect(await readIndexReceipt(dir)).toBeNull();
  });

  it('never throws when the receipt cannot be written', async () => {
    // A path that is not a directory: recording a disclosure must not take down the
    // watcher that was already handling a failure.
    await expect(recordIndexEmbedFailure(join(dir, 'missing', 'deeper'), { reason: 'fetch failed' }))
      .resolves.toBeUndefined();
  });
});
