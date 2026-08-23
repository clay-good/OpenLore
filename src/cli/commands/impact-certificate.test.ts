/**
 * add-change-impact-certificate — CLI surface of the certificate:
 *   - installImpactCertificateHook / uninstallImpactCertificateHook: the advisory
 *     git-hook is opt-in, coexists with the decisions gate + blast-radius hook
 *     (strips a trailing `exit 0` so the appended block is reachable), is
 *     idempotent, and uninstalls cleanly.
 *   - runImpactCertificateCli: advisory by default — an infrastructure error never
 *     blocks (exit 0), and exit 1 is produced ONLY in `--hook` mode when a
 *     configured `impactCertificate.block` surface severity actually fires.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../core/services/mcp-handlers/impact-certificate.js', () => ({
  computeImpactCertificate: vi.fn(),
}));
vi.mock('../../core/services/config-manager.js', () => ({
  readOpenLoreConfig: vi.fn(),
}));

import {
  installImpactCertificateHook,
  uninstallImpactCertificateHook,
  runImpactCertificateCli,
  triggeredBlockSeverities,
} from './impact-certificate.js';
import { computeImpactCertificate, type ImpactCertificate } from '../../core/services/mcp-handlers/impact-certificate.js';
import { readOpenLoreConfig } from '../../core/services/config-manager.js';

const HOOK_MARKER = '# openlore-impact-certificate-hook';

async function tmpRepo(precommit?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ol-cert-hook-'));
  await mkdir(join(root, '.git', 'hooks'), { recursive: true });
  if (precommit !== undefined) await writeFile(join(root, '.git', 'hooks', 'pre-commit'), precommit, 'utf-8');
  return root;
}
const readHook = (root: string) => readFile(join(root, '.git', 'hooks', 'pre-commit'), 'utf-8');

describe('impact-certificate git hook install/uninstall', () => {
  const created: string[] = [];
  const mk = async (pc?: string) => { const r = await tmpRepo(pc); created.push(r); return r; };
  afterEach(async () => { for (const r of created.splice(0)) await rm(r, { recursive: true, force: true }); process.exitCode = 0; });

  it('installs a fresh advisory hook (#!/bin/sh, marker, executable, exit-0 default)', async () => {
    const root = await mk();
    await installImpactCertificateHook(root);
    const h = await readHook(root);
    expect(h.startsWith('#!/bin/sh')).toBe(true);
    expect(h).toContain(HOOK_MARKER);
    expect(h).toContain('impact-certificate --hook');
    expect(h).toContain('if [ "$CERT_EXIT" -ne 0 ]; then'); // advisory: only a configured severity propagates
  });

  it('appends after an existing decisions/blast-radius hook, stripping a trailing `exit 0`', async () => {
    const root = await mk('#!/bin/sh\n\n# openlore-blast-radius-hook\nrun-blast\nexit 0\n');
    await installImpactCertificateHook(root);
    const h = await readHook(root);
    expect(h).toContain('run-blast');                  // original hook preserved
    expect(h).toContain(HOOK_MARKER);                  // our block appended
    expect(h).not.toMatch(/exit 0\s*\n+# openlore-impact-certificate-hook/); // not made unreachable
  });

  it('is idempotent — re-install does not double-append', async () => {
    const root = await mk();
    await installImpactCertificateHook(root);
    await installImpactCertificateHook(root);
    const h = await readHook(root);
    expect(h.split(HOOK_MARKER).length - 1).toBe(1);
  });

  it('round-trips: install over an existing hook then uninstall restores the original', async () => {
    const root = await mk('#!/bin/sh\n\n# openlore-decisions-hook\nrun-gate\nexit 0\n');
    await installImpactCertificateHook(root);
    await uninstallImpactCertificateHook(root);
    const h = await readHook(root);
    expect(h).toContain('run-gate');
    expect(h).not.toContain(HOOK_MARKER);
    expect(h).not.toContain('impact-certificate --hook');
  });

  it('refuses to install when there is no git repository (exitCode 1, no hook written)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ol-cert-nogit-'));
    created.push(root);
    await installImpactCertificateHook(root);
    expect(process.exitCode).toBe(1);
  });

  it('uninstall is a no-op when no hook block is present', async () => {
    const root = await mk('#!/bin/sh\n\nrun-gate\n');
    await uninstallImpactCertificateHook(root);
    expect(await readHook(root)).toContain('run-gate');
  });
});

const CRIT_PATH = { surface: 'client', surfaceSeverity: 'critical' as const, openingEdge: { from: 'A', to: 'B' }, path: ['A', 'B'], pathIds: ['a::A', 'b::B'], reaches: 'B' };
function cert(paths: ImpactCertificate['newlyOpenedPaths'], over: Partial<ImpactCertificate> = {}): ImpactCertificate {
  return {
    kind: 'impact-certificate', version: 1, baseRef: 'HEAD', resolvedBaseRef: 'HEAD', change: 'working-tree',
    changed: { files: 1, symbols: 1 }, surfaces: [{ name: 'client', severity: 'critical', resolvedSymbols: 1, unresolvedMembers: [] }],
    newlyOpenedPaths: paths, impact: { unavailable: 'x' }, tests: { unavailable: 'x' }, specs: { unavailable: 'x' },
    lease: { anchors: [] }, findings: [], highestSurfaceSeverity: paths.length ? 'critical' : 'none',
    posture: 'advisory', caveats: [], headline: 'h', ...over,
  };
}

describe('triggeredBlockSeverities', () => {
  it('fires only on a configured severity, advisory otherwise', () => {
    expect(triggeredBlockSeverities(cert([CRIT_PATH]), ['critical'])).toEqual(['critical']);
    expect(triggeredBlockSeverities(cert([CRIT_PATH]), ['warn'])).toEqual([]);
    expect(triggeredBlockSeverities(cert([CRIT_PATH]), [])).toEqual([]);
  });
});

describe('runImpactCertificateCli (advisory posture & exit codes)', () => {
  let outSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    outSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    errSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    vi.mocked(readOpenLoreConfig).mockResolvedValue(null as never);
  });
  afterEach(() => { outSpy.mockRestore(); errSpy.mockRestore(); vi.clearAllMocks(); });

  it('returns 0 (advisory) and never throws when compute returns an error', async () => {
    vi.mocked(computeImpactCertificate).mockResolvedValue({ error: 'No analysis found.' });
    expect(await runImpactCertificateCli({ cwd: '/p', hook: true })).toBe(0);
  });

  it('--json error surfaces as {status:"unavailable"} and still exits 0', async () => {
    vi.mocked(computeImpactCertificate).mockResolvedValue({ error: 'No analysis found.' });
    const code = await runImpactCertificateCli({ cwd: '/p', json: true });
    expect(code).toBe(0);
    const payload = JSON.parse((outSpy.mock.calls.at(-1)?.[0] as string));
    expect(payload).toMatchObject({ status: 'unavailable', error: 'No analysis found.' });
  });

  it('returns 0 (advisory) and never throws when compute itself throws', async () => {
    vi.mocked(computeImpactCertificate).mockRejectedValue(new Error('boom'));
    expect(await runImpactCertificateCli({ cwd: '/p', hook: true })).toBe(0);
  });

  it('a DIRECT invocation fails non-zero on an unresolvable base (a typo cannot yield a clean cert)', async () => {
    // computeImpactCertificate tags the fatal-base error so the CLI can distinguish it
    // from infrastructure failure and exit non-zero (fix-cli-conclusion-honesty).
    vi.mocked(computeImpactCertificate).mockResolvedValue({ error: 'base ref "bogus" did not resolve', baseUnresolved: true });
    const code = await runImpactCertificateCli({ cwd: '/p', base: 'bogus', json: true });
    expect(code).toBe(1);
  });

  it('the HOOK never blocks on a bad base: it passes allowBaseFallback and stays exit 0', async () => {
    // In hook mode the CLI opts into the disclosed fallback, so compute never returns the
    // fatal-base error; even if it did, the hook must not block. Assert both.
    vi.mocked(computeImpactCertificate).mockResolvedValue(cert([]));
    const code = await runImpactCertificateCli({ cwd: '/p', base: 'bogus', hook: true });
    expect(code).toBe(0);
    expect(vi.mocked(computeImpactCertificate).mock.calls[0][0]).toMatchObject({ allowBaseFallback: true });
  });

  it('--allow-base-fallback on a direct invocation is forwarded to compute', async () => {
    vi.mocked(computeImpactCertificate).mockResolvedValue(cert([]));
    await runImpactCertificateCli({ cwd: '/p', base: 'bogus', allowBaseFallback: true, json: true });
    expect(vi.mocked(computeImpactCertificate).mock.calls[0][0]).toMatchObject({ allowBaseFallback: true });
  });

  it('blocks (exit 1) in --hook mode only when a configured surface severity fires', async () => {
    vi.mocked(computeImpactCertificate).mockResolvedValue(cert([CRIT_PATH]));
    vi.mocked(readOpenLoreConfig).mockResolvedValue({ impactCertificate: { block: ['critical'] } } as never);
    const code = await runImpactCertificateCli({ cwd: '/p', hook: true });
    expect(code).toBe(1);
    expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('')).toMatch(/commit blocked/i);
  });

  it('stays advisory (exit 0) in --hook mode when no severity is configured to block', async () => {
    vi.mocked(computeImpactCertificate).mockResolvedValue(cert([CRIT_PATH]));
    vi.mocked(readOpenLoreConfig).mockResolvedValue(null as never);
    expect(await runImpactCertificateCli({ cwd: '/p', hook: true })).toBe(0);
  });

  it('does not block on a non-configured severity (warn opening, block=[critical])', async () => {
    const warnPath = { surface: 'logs', surfaceSeverity: 'warn' as const, openingEdge: { from: 'A', to: 'L' }, path: ['A', 'L'], pathIds: ['a::A', 'l::L'], reaches: 'L' };
    vi.mocked(computeImpactCertificate).mockResolvedValue(cert([warnPath], { highestSurfaceSeverity: 'warn' }));
    vi.mocked(readOpenLoreConfig).mockResolvedValue({ impactCertificate: { block: ['critical'] } } as never);
    expect(await runImpactCertificateCli({ cwd: '/p', hook: true })).toBe(0);
  });

  it('never blocks on a malformed impactCertificate.block (valid JSON, wrong type)', async () => {
    vi.mocked(computeImpactCertificate).mockResolvedValue(cert([CRIT_PATH]));
    vi.mocked(readOpenLoreConfig).mockResolvedValue({ impactCertificate: { block: {} } } as never);
    expect(await runImpactCertificateCli({ cwd: '/p', hook: true })).toBe(0);
  });

  it('never blocks when the config read itself throws', async () => {
    vi.mocked(computeImpactCertificate).mockResolvedValue(cert([CRIT_PATH]));
    vi.mocked(readOpenLoreConfig).mockRejectedValue(new Error('disk gone'));
    expect(await runImpactCertificateCli({ cwd: '/p', hook: true })).toBe(0);
  });

  it('does not block outside --hook mode even when a severity would fire (certificate to stdout)', async () => {
    vi.mocked(computeImpactCertificate).mockResolvedValue(cert([CRIT_PATH]));
    vi.mocked(readOpenLoreConfig).mockResolvedValue({ impactCertificate: { block: ['critical'] } } as never);
    const code = await runImpactCertificateCli({ cwd: '/p' });
    expect(code).toBe(0);
    expect(outSpy.mock.calls.length).toBeGreaterThan(0);
  });

  it('human render surfaces zero-test truncation and widening receipts', async () => {
    vi.mocked(computeImpactCertificate).mockResolvedValue(cert([], {
      tests: {
        count: 0,
        toRun: [],
        soundness: { caveats: ['Symbol scope resolved by substring fallback and may have widened.'] },
        truncatedAtDepth: 2,
      },
    }));
    expect(await runImpactCertificateCli({ cwd: '/p' })).toBe(0);
    const out = outSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(out).toContain('truncated at depth 2');
    expect(out).toContain('substring fallback');
  });
});
