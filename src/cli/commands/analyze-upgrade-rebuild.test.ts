/**
 * A schema bump must not strand the user (change: shrink-receiver-resolution-boundary).
 *
 * When `SCHEMA_VERSION` moves, every graph tool refuses with "run `openlore analyze` to rebuild
 * it". Analyze's skip, however, was gated on SOURCE freshness alone — so on an unchanged tree it
 * answered "up to date — source unchanged" and did nothing, leaving the user in a loop: told to
 * run a command that declines to act, with no working call graph until they guessed at `--force`.
 *
 * The skip is now additionally gated on the published store being readable by THIS build. These
 * tests pin the probe that decides it, in both directions — a future schema bump must not be able
 * to reintroduce the stranding.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readPublishedStoreFault } from './analyze.js';
import { SCHEMA_VERSION } from '../../core/services/edge-store.js';
import { ARTIFACT_CALL_GRAPH_DB } from '../../constants.js';

let dir: string;

/** Stamp a minimal store carrying `version` — enough for the schema probe to read. */
function writeStoreAtVersion(version: number): void {
  const db = new DatabaseSync(join(dir, ARTIFACT_CALL_GRAPH_DB));
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(version);
  db.close();
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'analyze-upgrade-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('readPublishedStoreFault', () => {
  it('reports a stale schema, so the skip cannot strand an upgrading user', async () => {
    writeStoreAtVersion(SCHEMA_VERSION - 1);
    const fault = await readPublishedStoreFault(dir);
    expect(fault).toBeTruthy();
    expect(fault).toContain(`v${SCHEMA_VERSION - 1}`);
    expect(fault).toContain(`v${SCHEMA_VERSION}`);
  });

  it('reports nothing for a store this build can read, so a healthy repo still skips', async () => {
    writeStoreAtVersion(SCHEMA_VERSION);
    expect(await readPublishedStoreFault(dir)).toBeNull();
  });

  it('reports nothing when there is no store at all — a first run is not a fault', async () => {
    expect(await readPublishedStoreFault(dir)).toBeNull();
  });

  it('never throws on an unreadable file — the probe reports, it does not abort analyze', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, ARTIFACT_CALL_GRAPH_DB), 'not a database', 'utf-8');
    await expect(readPublishedStoreFault(dir)).resolves.toBeTruthy();
  });

  it('leaves the store byte-identical — probing must never damage an index', async () => {
    writeStoreAtVersion(SCHEMA_VERSION - 1);
    const { readFileSync } = await import('node:fs');
    const before = readFileSync(join(dir, ARTIFACT_CALL_GRAPH_DB));
    await readPublishedStoreFault(dir);
    expect(readFileSync(join(dir, ARTIFACT_CALL_GRAPH_DB)).equals(before)).toBe(true);
  });
});
