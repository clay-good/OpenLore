import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DECISIONS_PENDING_FILE,
  OPENLORE_DECISIONS_SUBDIR,
  OPENLORE_DIR,
  PUBLIC_SURFACE_BASELINE_REL_PATH,
} from '../../constants.js';

const out: string[] = [];
vi.mock('../output.js', () => ({ writeStdout: vi.fn(async (text: string) => { out.push(text); }) }));
vi.mock('../../core/services/tool-dispatch.js', () => ({ dispatchTool: vi.fn() }));

const { dispatchTool } = await import('../../core/services/tool-dispatch.js');
const { runCertifyPublicSurfaceCli } = await import('./certify-public-surface.js');

const breakingFinding = (subject: string, code = 'export-removed') =>
  ({ code, severity: 'error', source: 'public-surface', subject, message: `${code} ${subject}` });

function diff(extra: Record<string, unknown> = {}) {
  return {
    mode: 'diff', base: 'main', head: 'working tree', overall: 'breaking',
    summary: { breaking: 1, potentiallyBreaking: 0, nonBreaking: 0, breakingConsumed: 0, breakingUnconsumedInIndex: 1, accepted: 0 },
    changes: [], breaking: [], suggestedBump: 'major',
    findings: [breakingFinding('a.ts::gone'), { ...breakingFinding('a.ts::gone', 'signature-unprovable'), severity: 'warning' }],
    consumerCensus: { scope: 'in-repo' },
    soundness: { posture: '', languages: '' },
    ...extra,
  };
}

describe('certify-public-surface --accept', () => {
  let dir: string;
  beforeEach(async () => {
    out.length = 0;
    dir = await mkdtemp(join(tmpdir(), 'openlore-cli-accept-'));
    await mkdir(join(dir, OPENLORE_DIR), { recursive: true });
    vi.mocked(dispatchTool).mockReset();
    vi.mocked(dispatchTool).mockResolvedValue(diff() as never);
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const baselineText = () => readFile(join(dir, PUBLIC_SURFACE_BASELINE_REL_PATH), 'utf8');

  it('refuses without a justification, before running the analysis, and writes nothing', async () => {
    expect(await runCertifyPublicSurfaceCli({ cwd: dir, base: 'main', accept: true, json: true })).toBe(1);
    expect(dispatchTool).not.toHaveBeenCalled();
    expect(JSON.parse(out.join(''))).toMatchObject({ status: 'refused', error: expect.stringMatching(/requires a justification/) });
    await expect(baselineText()).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses without --base', async () => {
    expect(await runCertifyPublicSurfaceCli({ cwd: dir, accept: true, justification: 'why', json: true })).toBe(1);
    expect(JSON.parse(out.join('')).error).toMatch(/--accept needs --base/);
  });

  it('refuses --justification or --decision without --accept', async () => {
    expect(await runCertifyPublicSurfaceCli({ cwd: dir, base: 'main', justification: 'why', json: true })).toBe(1);
    expect(dispatchTool).not.toHaveBeenCalled();
  });

  it('refuses to anchor to a decision that is not current', async () => {
    const d = join(dir, OPENLORE_DIR, OPENLORE_DECISIONS_SUBDIR);
    await mkdir(d, { recursive: true });
    const decision = (id: string, extra = {}) => ({
      id, status: 'approved', title: id, rationale: 'r', consequences: 'c', proposedRequirement: null, affectedDomains: [],
      affectedFiles: [], syncedToSpecs: [], sessionId: 's', recordedAt: '2026-06-01T00:00:00Z', contentOrigin: 'agent-recorded', confidence: 'high', ...extra,
    });
    await writeFile(join(d, DECISIONS_PENDING_FILE), JSON.stringify({
      version: '1', sessionId: 's', updatedAt: '2026-06-01T00:00:00Z',
      decisions: [decision('a1b2c3d4'), decision('b2c3d4e5', { supersedes: 'a1b2c3d4' })],
    }));
    expect(await runCertifyPublicSurfaceCli({ cwd: dir, base: 'main', accept: true, justification: 'why', decision: 'A1B2C3D4', json: true })).toBe(1);
    expect(JSON.parse(out.join('')).error).toMatch(/refusing to anchor to decision a1b2c3d4: .*superseded by b2c3d4e5/);
    await expect(baselineText()).rejects.toMatchObject({ code: 'ENOENT' });

    out.length = 0;
    expect(await runCertifyPublicSurfaceCli({ cwd: dir, base: 'main', accept: true, justification: 'why', decision: 'b2c3d4e5', json: true })).toBe(0);
    expect(await baselineText()).toContain('"b2c3d4e5"');
  });

  it('writes the breaking findings (never the warning) with the justification', async () => {
    expect(await runCertifyPublicSurfaceCli({ cwd: dir, base: 'main', accept: true, justification: 'retired in v3', json: true })).toBe(0);
    expect(JSON.parse(out.join(''))).toMatchObject({ status: 'accepted', written: true, added: [{ code: 'export-removed', subject: 'a.ts::gone' }] });
    expect(await baselineText()).toBe('# OpenLore accepted public-surface breakages v1\n["accept","export-removed","a.ts::gone","","retired in v3",""]\n');
  });

  it('reports nothing to accept when every breaking finding is already accepted', async () => {
    vi.mocked(dispatchTool).mockResolvedValue(diff({ findings: [] }) as never);
    expect(await runCertifyPublicSurfaceCli({ cwd: dir, base: 'main', accept: true, justification: 'why', json: true })).toBe(0);
    expect(JSON.parse(out.join('')).status).toBe('nothing-to-accept');
  });

  it('never overwrites a baseline the analysis could not read', async () => {
    vi.mocked(dispatchTool).mockResolvedValue(diff({ baseline: { path: PUBLIC_SURFACE_BASELINE_REL_PATH, error: 'baseline ignored: bad header', accepted: [], stale: [], unmatched: [] } }) as never);
    await writeFile(join(dir, PUBLIC_SURFACE_BASELINE_REL_PATH), 'hand-edited\n');
    expect(await runCertifyPublicSurfaceCli({ cwd: dir, base: 'main', accept: true, justification: 'why', json: true })).toBe(1);
    expect(await baselineText()).toBe('hand-edited\n');
  });

  it('refuses to accept findings computed against a fallback base', async () => {
    vi.mocked(dispatchTool).mockResolvedValue(diff({ baseRefFallback: { requested: 'release/1.x', resolved: 'main' } }) as never);
    expect(await runCertifyPublicSurfaceCli({ cwd: dir, base: 'release/1.x', allowBaseFallback: true, accept: true, justification: 'why', json: true })).toBe(1);
    expect(JSON.parse(out.join('')).error).toMatch(/base "release\/1\.x" did not resolve/);
    await expect(baselineText()).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses --federation without --base', async () => {
    expect(await runCertifyPublicSurfaceCli({ cwd: dir, federation: true, json: true })).toBe(1);
    expect(dispatchTool).not.toHaveBeenCalled();
  });

  it('names what a re-accept replaced', async () => {
    await runCertifyPublicSurfaceCli({ cwd: dir, base: 'main', accept: true, justification: 'first' });
    out.length = 0;
    expect(await runCertifyPublicSurfaceCli({ cwd: dir, base: 'main', accept: true, justification: 'second' })).toBe(0);
    expect(out.join('')).toContain('re-accepted export-removed  a.ts::gone');
  });

  it('passes federation scope through to the tool', async () => {
    await runCertifyPublicSurfaceCli({ cwd: dir, base: 'main', federation: true, federationRepos: ['sib'], json: true });
    expect(dispatchTool).toHaveBeenCalledWith('certify_public_surface', expect.objectContaining({ federation: true, federationRepos: ['sib'] }), dir);
  });

  it('renders the split, the census, and accepted and stale entries', async () => {
    vi.mocked(dispatchTool).mockResolvedValue(diff({
      changes: [{ changeKind: 'removed', class: 'breaking', name: 'gone', file: 'a.ts', reasons: ['removed'], ruleCodes: ['export-removed'] }],
      breaking: [{ changeKind: 'removed', class: 'breaking', name: 'gone', file: 'a.ts', reasons: ['removed'], consumers: [], breakingClass: 'breaking-unconsumed-in-index', crossRepoConsumers: [{ repo: 'sib', name: 'main', file: 'm.ts' }] }],
      consumerCensus: { scope: 'federation', reposConsulted: ['sib'], reposSkipped: [] },
      baseline: {
        path: PUBLIC_SURFACE_BASELINE_REL_PATH, entries: 2,
        accepted: [{ code: 'export-removed', subject: 'a.ts::gone', justification: 'retired' }],
        stale: [{ code: 'param-removed', subject: 'a.ts::gone', justification: 'old', reason: 'decision a1b2c3d4 was superseded' }],
        unmatched: [],
      },
    }) as never);
    expect(await runCertifyPublicSurfaceCli({ cwd: dir, base: 'main' })).toBe(0);
    const text = out.join('');
    expect(text).toContain('breaking: 0 consumed, 1 with no indexed consumer in this repo or a federated repo (not "safe")');
    expect(text).toContain('federation: checked sib');
    expect(text).not.toContain('is a federation registry set up');
    expect(text).toContain('accepted baseline .openlore/public-surface-baseline.jsonl: 1 accepted · 1 stale · 0 unmatched');
    expect(text).toContain('breaking-unconsumed-in-index');
    expect(text).toContain('breaks 1 consumer(s) in federated repos (matched by name): sib:main');
    expect(text).toContain('accepted export-removed: retired');
    expect(text).toContain('stale acceptance of param-removed, still reported: decision a1b2c3d4 was superseded');
  });
});
