/**
 * add-preflight-blast-radius-guard — CLI surface of the blast-radius guard:
 *   - installBlastRadiusHook / uninstallBlastRadiusHook: the advisory git-hook
 *     is opt-in, coexists with the decisions gate (strips a trailing `exit 0` so
 *     the appended block is reachable), is idempotent, and uninstalls cleanly.
 *   - runBlastRadiusCli: advisory by default — an infrastructure error never
 *     blocks (exit 0), and exit 1 is produced ONLY when `--hook` mode and a
 *     configured `blastRadius.block` pattern actually fires.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../core/services/mcp-handlers/blast-radius.js', () => ({
  computeBlastRadius: vi.fn(),
}));
vi.mock('../../core/services/config-manager.js', () => ({
  readOpenLoreConfig: vi.fn(),
}));

import {
  installBlastRadiusHook,
  uninstallBlastRadiusHook,
  runBlastRadiusCli,
} from './blast-radius.js';
import { computeBlastRadius } from '../../core/services/mcp-handlers/blast-radius.js';
import { readOpenLoreConfig } from '../../core/services/config-manager.js';
import type { BlastRadiusBriefing } from '../../core/services/mcp-handlers/blast-radius.js';

const HOOK_MARKER = '# openlore-blast-radius-hook';

async function tmpRepo(precommit?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ol-blast-hook-'));
  await mkdir(join(root, '.git', 'hooks'), { recursive: true });
  if (precommit !== undefined) await writeFile(join(root, '.git', 'hooks', 'pre-commit'), precommit, 'utf-8');
  return root;
}
const readHook = (root: string) => readFile(join(root, '.git', 'hooks', 'pre-commit'), 'utf-8');

describe('blast-radius git hook install/uninstall', () => {
  const created: string[] = [];
  const mk = async (pc?: string) => { const r = await tmpRepo(pc); created.push(r); return r; };
  afterEach(async () => { for (const r of created.splice(0)) await rm(r, { recursive: true, force: true }); process.exitCode = 0; });

  it('installs a fresh advisory hook (#!/bin/sh, marker, executable, exit-0 default)', async () => {
    const root = await mk();
    await installBlastRadiusHook(root);
    const h = await readHook(root);
    expect(h.startsWith('#!/bin/sh')).toBe(true);
    expect(h).toContain(HOOK_MARKER);
    expect(h).toContain('blast-radius --hook');
    // advisory by default: only a configured pattern (nonzero exit) ever propagates
    expect(h).toContain('if [ "$BLAST_EXIT" -ne 0 ]; then');
  });

  it('appends after an existing decisions-gate hook, stripping a trailing `exit 0` so the block is reachable', async () => {
    const root = await mk('#!/bin/sh\n\n# openlore-decisions-hook\nrun-gate\nexit 0\n');
    await installBlastRadiusHook(root);
    const h = await readHook(root);
    expect(h).toContain('run-gate');                 // original hook preserved
    expect(h).toContain(HOOK_MARKER);                // our block appended
    // the original trailing `exit 0` must not sit immediately before our block (would make it unreachable)
    expect(h).not.toMatch(/exit 0\s*\n+# openlore-blast-radius-hook/);
  });

  it('is idempotent — re-install does not double-append', async () => {
    const root = await mk();
    await installBlastRadiusHook(root);
    await installBlastRadiusHook(root);
    const h = await readHook(root);
    expect(h.split(HOOK_MARKER).length - 1).toBe(1);
  });

  it('round-trips: install over an existing hook then uninstall restores the original', async () => {
    const original = '#!/bin/sh\n\n# openlore-decisions-hook\nrun-gate\nexit 0\n';
    const root = await mk(original);
    await installBlastRadiusHook(root);
    await uninstallBlastRadiusHook(root);
    const h = await readHook(root);
    expect(h).toContain('run-gate');
    expect(h).not.toContain(HOOK_MARKER);            // our block fully removed
    expect(h).not.toContain('blast-radius --hook');
  });

  it('refuses to install when there is no git repository (exitCode 1, no hook written)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ol-blast-nogit-'));
    created.push(root);
    await installBlastRadiusHook(root);
    expect(process.exitCode).toBe(1);
  });

  it('uninstall is a no-op when no hook block is present', async () => {
    const root = await mk('#!/bin/sh\n\nrun-gate\n');
    await uninstallBlastRadiusHook(root);
    expect(await readHook(root)).toContain('run-gate');
  });
});

describe('runBlastRadiusCli (advisory posture & exit codes)', () => {
  let outSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    outSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    errSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.mocked(readOpenLoreConfig).mockResolvedValue(null as never);
  });
  afterEach(() => { outSpy.mockRestore(); errSpy.mockRestore(); vi.clearAllMocks(); });

  const orphanBriefing = {
    headline: 'h', posture: 'advisory',
    impact: { hubsTouched: [], layersCrossed: [], governingDecisions: [] },
    tests: { count: 0, toRun: [] },
    memory: { orphaned: 1, drifted: 0, willDrift: [{ kind: 'memory-orphaned', message: 'gone', filePath: 'x.ts' }] },
    specs: { items: [], willGoStale: 0 },
    decisions: { affected: 0, orphaned: 0, items: [] },
  } as unknown as BlastRadiusBriefing;

  it('returns 0 (advisory) and never throws when compute returns an error', async () => {
    vi.mocked(computeBlastRadius).mockResolvedValue({ error: 'No analysis found.' });
    expect(await runBlastRadiusCli({ cwd: '/p', hook: true })).toBe(0);
  });

  it('--json error surfaces as {status:"unavailable"} and still exits 0', async () => {
    vi.mocked(computeBlastRadius).mockResolvedValue({ error: 'No analysis found.' });
    const code = await runBlastRadiusCli({ cwd: '/p', json: true });
    expect(code).toBe(0);
    const payload = JSON.parse((outSpy.mock.calls.at(-1)?.[0] as string));
    expect(payload).toMatchObject({ status: 'unavailable', error: 'No analysis found.' });
  });

  it('blocks (exit 1) in --hook mode only when a configured block pattern fires', async () => {
    vi.mocked(computeBlastRadius).mockResolvedValue(orphanBriefing);
    vi.mocked(readOpenLoreConfig).mockResolvedValue({ blastRadius: { block: ['orphans-anchored-memory'] } } as never);
    const code = await runBlastRadiusCli({ cwd: '/p', hook: true });
    expect(code).toBe(1);
    expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('')).toMatch(/commit blocked/i);
  });

  it('stays advisory (exit 0) in --hook mode when no block pattern is configured', async () => {
    vi.mocked(computeBlastRadius).mockResolvedValue(orphanBriefing);
    vi.mocked(readOpenLoreConfig).mockResolvedValue(null as never);
    expect(await runBlastRadiusCli({ cwd: '/p', hook: true })).toBe(0);
  });

  it('does not block outside --hook mode even when a pattern would fire (briefing to stdout)', async () => {
    vi.mocked(computeBlastRadius).mockResolvedValue(orphanBriefing);
    vi.mocked(readOpenLoreConfig).mockResolvedValue({ blastRadius: { block: ['orphans-anchored-memory'] } } as never);
    const code = await runBlastRadiusCli({ cwd: '/p' });
    expect(code).toBe(0);
    expect(outSpy.mock.calls.length).toBeGreaterThan(0); // human briefing went to stdout, not stderr
  });

  it('human render surfaces zero-test truncation and widening receipts', async () => {
    const boundary = {
      ...orphanBriefing,
      tests: {
        count: 0,
        toRun: [],
        truncatedAtDepth: 2,
        soundness: { caveats: ['Symbol scope resolved by substring fallback and may have widened.'] },
      },
    } as BlastRadiusBriefing;
    vi.mocked(computeBlastRadius).mockResolvedValue(boundary);
    expect(await runBlastRadiusCli({ cwd: '/p' })).toBe(0);
    const out = outSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(out).toContain('truncated at depth 2');
    expect(out).toContain('substring fallback');
  });

  it('never blocks on a malformed blastRadius.block (valid JSON, wrong type)', async () => {
    vi.mocked(computeBlastRadius).mockResolvedValue(orphanBriefing);
    // A wrong-typed `block` (object) would throw on iteration if not coerced — must not block.
    vi.mocked(readOpenLoreConfig).mockResolvedValue({ blastRadius: { block: {} } } as never);
    expect(await runBlastRadiusCli({ cwd: '/p', hook: true })).toBe(0);
  });

  it('never blocks when the config read itself throws', async () => {
    vi.mocked(computeBlastRadius).mockResolvedValue(orphanBriefing);
    vi.mocked(readOpenLoreConfig).mockRejectedValue(new Error('disk gone'));
    expect(await runBlastRadiusCli({ cwd: '/p', hook: true })).toBe(0);
  });

  it('human render surfaces a disclosed base-ref fallback (baseRefFallback set)', async () => {
    const fellBack = {
      headline: 'h', posture: 'advisory', baseRef: 'totally-bogus-ref', resolvedBaseRef: 'main',
      baseRefFallback: { requested: 'totally-bogus-ref', resolved: 'main' },
      impact: { hubsTouched: [], layersCrossed: [], governingDecisions: [] },
      tests: { count: 0, toRun: [] },
      memory: { orphaned: 0, drifted: 0, willDrift: [] },
      specs: { willGoStale: 0, items: [] },
      decisions: { affected: 0, orphaned: 0, items: [] },
    } as unknown as BlastRadiusBriefing;
    vi.mocked(computeBlastRadius).mockResolvedValue(fellBack);
    expect(await runBlastRadiusCli({ cwd: '/p' })).toBe(0);
    const out = outSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(out).toMatch(/base ref "totally-bogus-ref" did not resolve.*diffed against "main"/i);
  });

  it('human render discloses capped detail lists with a "… and N more" line (no silent truncation)', async () => {
    const capped = {
      headline: 'h', posture: 'advisory',
      impact: { hubsTouched: [], layersCrossed: [], governingDecisions: [] },
      tests: { count: 0, toRun: [] },
      memory: { orphaned: 0, drifted: 0, willDrift: [] },
      // 8 stale specs but items capped at 5 → render must show "… and 3 more"
      specs: { willGoStale: 8, items: Array.from({ length: 5 }, (_, i) => ({ kind: 'stale', message: `s${i}`, domain: null, specPath: null })) },
      decisions: { affected: 23, orphaned: 0, items: Array.from({ length: 20 }, () => ({ kind: 'adr-gap', message: 'g', domain: null })) },
    } as unknown as BlastRadiusBriefing;
    vi.mocked(computeBlastRadius).mockResolvedValue(capped);
    const code = await runBlastRadiusCli({ cwd: '/p' });
    expect(code).toBe(0);
    const out = outSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(out).toMatch(/and 3 more spec/i);
    expect(out).toMatch(/and 3 more decision/i); // 23 affected − 20 shown
  });
});
