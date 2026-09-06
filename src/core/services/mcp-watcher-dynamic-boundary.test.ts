/**
 * The watcher's dynamic-boundary lane (change: disclose-dynamic-boundary-regions).
 *
 * `dynamic-boundary.json` is ABSENT on a repository with no site, so this lane — unlike the style
 * fingerprint's — must be able to CREATE the artifact when a save introduces the first site and
 * REMOVE it when the last one goes. Both transitions are load-bearing: a stale artifact left behind
 * would keep disclosing a boundary the code no longer has, and a missing creation would leave a
 * newly-added `eval` invisible until the next full analyze.
 *
 * Pinned here because the lane is a SECOND PRODUCER of the same records the full build writes. If
 * the two disagree, the artifact stops being one source of truth — the failure the parse-health
 * lane's own tests exist to close.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpWatcher } from './mcp-watcher.js';
import { ARTIFACT_DYNAMIC_BOUNDARY } from '../../constants.js';
import type { DynamicBoundaryReport } from '../analyzer/dynamic-boundary.js';

function watcherIn(): { watcher: McpWatcher; outputPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'wdb-'));
  const outputPath = join(root, '.openlore', 'analysis');
  mkdirSync(outputPath, { recursive: true });
  return { watcher: new McpWatcher({ rootPath: root, outputPath }), outputPath };
}

/** Drive the private incremental lane directly — it is the unit under test. */
async function splice(
  watcher: McpWatcher,
  changed: Array<{ rel: string; content: string }>,
  deleted: string[] = [],
): Promise<void> {
  await (watcher as unknown as {
    updateDynamicBoundary(c: Array<{ rel: string; content: string }>, d?: string[]): Promise<void>;
  }).updateDynamicBoundary(changed, deleted);
}

function readReport(outputPath: string): DynamicBoundaryReport | null {
  const p = join(outputPath, ARTIFACT_DYNAMIC_BOUNDARY);
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf-8')) as DynamicBoundaryReport) : null;
}

const WITH_EVAL = 'export function run(src: string) { return eval(src); }\n';
const CLEAN = 'export function run(src: string) { return src.length; }\n';

describe('watcher dynamic-boundary lane', () => {
  it('creates the artifact when a save introduces the first site, and clears it when removed', async () => {
    const { watcher, outputPath } = watcherIn();

    // A repository with no site has no artifact at all.
    await splice(watcher, [{ rel: 'src/a.ts', content: CLEAN }]);
    expect(readReport(outputPath)).toBeNull();

    // Saving a file with an `eval` creates it.
    await splice(watcher, [{ rel: 'src/a.ts', content: WITH_EVAL }]);
    const report = readReport(outputPath)!;
    expect(report.totalSites).toBe(1);
    expect(report.files[0].filePath).toBe('src/a.ts');
    expect(report.files[0].sites[0].kind).toBe('code-eval');

    // Removing the construct and saving again clears the disclosure — and the artifact with it.
    await splice(watcher, [{ rel: 'src/a.ts', content: CLEAN }]);
    expect(readReport(outputPath)).toBeNull();
  });

  it('drops a deleted file and removes the artifact when it held the last site', async () => {
    const { watcher, outputPath } = watcherIn();
    await splice(watcher, [
      { rel: 'src/a.ts', content: WITH_EVAL },
      { rel: 'src/b.ts', content: WITH_EVAL },
    ]);
    expect(readReport(outputPath)!.totalFiles).toBe(2);

    await splice(watcher, [], ['src/a.ts']);
    const after = readReport(outputPath)!;
    expect(after.files.map(f => f.filePath)).toEqual(['src/b.ts']);

    await splice(watcher, [], ['src/b.ts']);
    expect(readReport(outputPath)).toBeNull();
  });

  it('leaves the artifact untouched when nothing changed', async () => {
    const { watcher, outputPath } = watcherIn();
    await splice(watcher, [{ rel: 'src/a.ts', content: WITH_EVAL }]);
    const before = readFileSync(join(outputPath, ARTIFACT_DYNAMIC_BOUNDARY), 'utf-8');

    // A clean file that had no record produces no write — no artifact churn on every save.
    await splice(watcher, [{ rel: 'src/clean.ts', content: CLEAN }]);
    expect(readFileSync(join(outputPath, ARTIFACT_DYNAMIC_BOUNDARY), 'utf-8')).toBe(before);
  });

  it('records the same vocabulary the full build does', async () => {
    const { watcher, outputPath } = watcherIn();
    await splice(watcher, [{
      rel: 'src/a.py',
      content: 'def dispatch(o, a):\n    return getattr(o, a)()\n',
    }]);
    const site = readReport(outputPath)!.files[0].sites[0];
    expect(site.kind).toBe('reflective-invoke');
    expect(site.refusal).toBe('no-static-target');
    expect(site.symbolId).toContain('dispatch');
  });

  it('is best-effort: an unreadable existing artifact never throws into the batch', async () => {
    const { watcher, outputPath } = watcherIn();
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(outputPath, ARTIFACT_DYNAMIC_BOUNDARY), 'not json');
    await expect(splice(watcher, [{ rel: 'src/a.ts', content: WITH_EVAL }])).resolves.toBeUndefined();
  });
});
