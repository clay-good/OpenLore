/**
 * `openlore enforce` — the unified enforcement gate (change: add-finding-enforcement-policy).
 *
 * Guards cli/GateConsultsTheUnifiedEnforcementPolicy and cli/SilencedFindingsRemainVisible:
 *   - install/uninstall coexists with the decisions gate (strips a trailing `exit 0`),
 *   - advisory by default (no policy ⇒ exit 0, finding reported as advisory),
 *   - a `blocking`-mapped finding fails the gate in --hook mode (exit 1),
 *   - an `off`-mapped finding is listed (silenced) but never fails.
 *
 * Runs end-to-end over a real decision store + an .openlore/config.json. Plain
 * .test.ts so CI runs it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  installEnforcementHook,
  uninstallEnforcementHook,
  runEnforceCli,
  blastRadiusFindings,
  impactCertificateFindings,
} from './enforce.js';
import { classifyFindings } from '../../core/services/mcp-handlers/enforcement-policy.js';
import {
  OPENLORE_DIR,
  OPENLORE_DECISIONS_SUBDIR,
  DECISIONS_PENDING_FILE,
  OPENLORE_CONFIG_FILENAME,
} from '../../constants.js';
import type { DecisionStore, PendingDecision, EnforcementClass } from '../../types/index.js';

const created: string[] = [];
afterEach(async () => { for (const r of created.splice(0)) await rm(r, { recursive: true, force: true }); process.exitCode = 0; });

async function mkRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'openlore-enforce-'));
  created.push(root);
  await mkdir(join(root, OPENLORE_DIR), { recursive: true });
  return root;
}

function decision(p: Partial<PendingDecision> & { id: string }): PendingDecision {
  return {
    id: p.id, status: p.status ?? 'approved', title: p.title ?? `d ${p.id}`,
    rationale: p.rationale ?? '', consequences: '', proposedRequirement: null,
    affectedDomains: [], affectedFiles: [], supersedes: p.supersedes,
    sessionId: 's1', recordedAt: '2026-06-23T00:00:00Z', contentOrigin: 'agent-recorded', confidence: 'high', syncedToSpecs: [],
  };
}

/** Write a decision store where an approved decision A cites a superseded decision B. */
async function writeStaleScenario(root: string): Promise<void> {
  const dir = join(root, OPENLORE_DIR, OPENLORE_DECISIONS_SUBDIR);
  await mkdir(dir, { recursive: true });
  const store: DecisionStore = {
    version: '1', sessionId: 's1', updatedAt: '2026-06-23T00:00:00Z',
    decisions: [
      decision({ id: 'aaaaaaaa', title: 'auth flow', rationale: 'builds on bbbbbbbb' }),
      decision({ id: 'bbbbbbbb', title: 'use bcrypt' }),
      decision({ id: 'cccccccc', title: 'use argon2', supersedes: 'bbbbbbbb' }),
    ],
  };
  await writeFile(join(dir, DECISIONS_PENDING_FILE), JSON.stringify(store, null, 2) + '\n', 'utf-8');
}

async function writePolicy(root: string, policy: Record<string, EnforcementClass>): Promise<void> {
  await writeFile(join(root, OPENLORE_DIR, OPENLORE_CONFIG_FILENAME), JSON.stringify({
    version: '1.0.0', projectType: 'nodejs', openspecPath: 'openspec',
    analysis: { maxFiles: 100, includePatterns: [], excludePatterns: [] },
    generation: { domains: 'auto' }, createdAt: '2026-01-01T00:00:00Z', lastRun: null,
    enforcement: { policy },
  }, null, 2), 'utf-8');
}

type GateJson = {
  gated: boolean;
  blocking: Array<{ code: string }>;
  advisory: Array<{ code: string }>;
  off: Array<{ code: string }>;
  unknownPolicyCodes: string[];
};

async function gateJson(root: string): Promise<{ code: number; json: GateJson }> {
  const out: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string) => { out.push(s); return true; }) as typeof process.stdout.write;
  let code: number;
  try {
    code = await runEnforceCli({ cwd: root, json: true });
  } finally {
    process.stdout.write = orig;
  }
  return { code, json: JSON.parse(out.join('')) as GateJson };
}

describe('enforce git hook install/uninstall', () => {
  const readHook = (root: string) => readFile(join(root, '.git', 'hooks', 'pre-commit'), 'utf-8');

  it('installs a fresh advisory hook (#!/bin/sh, marker, advisory by default)', async () => {
    const root = await mkRepo();
    await mkdir(join(root, '.git'), { recursive: true });
    await installEnforcementHook(root);
    const h = await readHook(root);
    expect(h.startsWith('#!/bin/sh')).toBe(true);
    expect(h).toContain('# openlore-enforcement-hook');
    expect(h).toContain('enforce --hook');
  });

  it('appends after an existing decisions-gate hook, stripping a trailing `exit 0`', async () => {
    const root = await mkRepo();
    await mkdir(join(root, '.git', 'hooks'), { recursive: true });
    await writeFile(join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\n\n# openlore-decisions-hook\nrun-gate\nexit 0\n', 'utf-8');
    await installEnforcementHook(root);
    const h = await readHook(root);
    expect(h).toContain('# openlore-decisions-hook');
    expect(h).not.toMatch(/exit 0\s*\n+# openlore-enforcement-hook/);
  });

  it('is idempotent and uninstall removes only our block', async () => {
    const root = await mkRepo();
    await mkdir(join(root, '.git', 'hooks'), { recursive: true });
    await writeFile(join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\n\n# openlore-decisions-hook\nrun-gate\nexit 0\n', 'utf-8');
    await installEnforcementHook(root);
    await installEnforcementHook(root);
    let h = await readHook(root);
    expect(h.split('# openlore-enforcement-hook').length - 1).toBe(1);
    await uninstallEnforcementHook(root);
    h = await readHook(root);
    expect(h).toContain('# openlore-decisions-hook');
    expect(h).not.toContain('# openlore-enforcement-hook');
  });
});

// ── source mapping: blast-radius + impact-certificate → unified findings ───────
// These are the gate's collection paths for the diff-heavy sources, exercised as
// pure functions over synthetic briefings (the same style as triggeredBlockPatterns).
describe('blastRadiusFindings — orphan patterns map to unified findings', () => {
  const briefing = (memOrphaned: number, decOrphaned: number) => ({
    memory: { orphaned: memOrphaned, drifted: 0, willDrift: [] },
    decisions: { affected: decOrphaned, orphaned: decOrphaned, items: [] },
  }) as never;

  it('emits orphans-anchored-memory only when memory is orphaned', () => {
    expect(blastRadiusFindings(briefing(2, 0)).map((f) => f.code)).toEqual(['orphans-anchored-memory']);
  });
  it('emits orphans-anchored-decision only when a decision is orphaned', () => {
    expect(blastRadiusFindings(briefing(0, 1)).map((f) => f.code)).toEqual(['orphans-anchored-decision']);
  });
  it('emits both when both are orphaned, neither when clean', () => {
    expect(blastRadiusFindings(briefing(1, 1)).map((f) => f.code).sort())
      .toEqual(['orphans-anchored-decision', 'orphans-anchored-memory']);
    expect(blastRadiusFindings(briefing(0, 0))).toEqual([]);
  });
  it('a lowered blastRadius.block / policy entry classifies the finding as blocking', () => {
    const findings = blastRadiusFindings(briefing(1, 0));
    const r = classifyFindings(findings, { 'orphans-anchored-memory': 'blocking' });
    expect(r.gated).toBe(true);
    expect(r.blocking.map((f) => f.code)).toEqual(['orphans-anchored-memory']);
  });
});

describe('impactCertificateFindings — surface severities map to per-severity codes', () => {
  const cert = (paths: Array<{ surface: string; surfaceSeverity: string }>) =>
    ({ newlyOpenedPaths: paths }) as never;

  it('groups newly-opened paths into surface-<severity> codes', () => {
    const out = impactCertificateFindings(cert([
      { surface: 'client', surfaceSeverity: 'critical' },
      { surface: 'data', surfaceSeverity: 'warn' },
    ]));
    expect(out.map((f) => f.code).sort()).toEqual(['surface-critical', 'surface-warn']);
  });
  it('dedups multiple paths into one finding per severity, surfaces sorted', () => {
    const out = impactCertificateFindings(cert([
      { surface: 'zeta', surfaceSeverity: 'critical' },
      { surface: 'alpha', surfaceSeverity: 'critical' },
    ]));
    expect(out).toHaveLength(1);
    expect(out[0].subject).toBe('alpha,zeta'); // deterministic sort
  });
  it('intrinsic severity mirrors the surface severity (info→info, warn→warn, critical→error)', () => {
    const sev = (s: string) => impactCertificateFindings(cert([{ surface: 'x', surfaceSeverity: s }]))[0].severity;
    expect(sev('info')).toBe('info');
    expect(sev('warn')).toBe('warn');
    expect(sev('critical')).toBe('error');
  });
  it('block:["critical"] equivalent — surface-critical classifies as blocking', () => {
    const out = impactCertificateFindings(cert([{ surface: 'client', surfaceSeverity: 'critical' }]));
    const r = classifyFindings(out, { 'surface-critical': 'blocking' });
    expect(r.gated).toBe(true);
  });
  it('empty certificate ⇒ no findings', () => {
    expect(impactCertificateFindings(cert([]))).toEqual([]);
  });
});

describe('enforce gate decision', () => {
  it('advisory by default — a stale-decision-reference does not block (exit 0)', async () => {
    const root = await mkRepo();
    await writeStaleScenario(root);
    const { code, json } = await gateJson(root);
    expect(code).toBe(0);
    expect(json.gated).toBe(false);
    expect(json.advisory.map((f) => f.code)).toContain('stale-decision-reference');
  });

  it('a blocking-mapped finding fails the gate in --hook mode (exit 1)', async () => {
    const root = await mkRepo();
    await writeStaleScenario(root);
    await writePolicy(root, { 'stale-decision-reference': 'blocking' });
    const code = await runEnforceCli({ cwd: root, hook: true });
    expect(code).toBe(1);
    const { json } = await gateJson(root);
    expect(json.gated).toBe(true);
    expect(json.blocking.map((f) => f.code)).toEqual(['stale-decision-reference']);
  });

  it('an off-mapped finding is listed (silenced) but never blocks', async () => {
    const root = await mkRepo();
    await writeStaleScenario(root);
    await writePolicy(root, { 'stale-decision-reference': 'off' });
    const { code, json } = await gateJson(root);
    expect(code).toBe(0);
    expect(json.gated).toBe(false);
    expect(json.off.map((f) => f.code)).toEqual(['stale-decision-reference']);
    expect(json.advisory).toHaveLength(0);
  });

  it('an unknown policy code is retained and surfaced, not an error', async () => {
    const root = await mkRepo();
    await writeStaleScenario(root);
    await writePolicy(root, { 'stale-decision-reference': 'advisory', 'future-code': 'blocking' });
    const { code, json } = await gateJson(root);
    expect(code).toBe(0);
    expect(json.unknownPolicyCodes).toEqual(['future-code']);
  });

  it('a malformed enforcement.policy degrades to advisory — never throws or blocks', async () => {
    const root = await mkRepo();
    await writeStaleScenario(root);
    // hostile shapes that must not crash or block the gate
    await writeFile(join(root, OPENLORE_DIR, OPENLORE_CONFIG_FILENAME),
      JSON.stringify({
        version: '1.0.0', projectType: 'nodejs', openspecPath: 'openspec',
        analysis: { maxFiles: 100, includePatterns: [], excludePatterns: [] },
        generation: { domains: 'auto' }, createdAt: '2026-01-01T00:00:00Z', lastRun: null,
        enforcement: { policy: ['blocking'] },
      }), 'utf-8');
    const { code, json } = await gateJson(root);
    expect(code).toBe(0);
    expect(json.gated).toBe(false);
    expect(json.advisory.map((f) => f.code)).toContain('stale-decision-reference');
  });

  it('no findings ⇒ clean advisory pass', async () => {
    const root = await mkRepo();
    // a store with no supersession
    const dir = join(root, OPENLORE_DIR, OPENLORE_DECISIONS_SUBDIR);
    await mkdir(dir, { recursive: true });
    const store: DecisionStore = { version: '1', sessionId: 's', updatedAt: 'x', decisions: [decision({ id: 'aaaaaaaa' })] };
    await writeFile(join(dir, DECISIONS_PENDING_FILE), JSON.stringify(store), 'utf-8');
    const { code, json } = await gateJson(root);
    expect(code).toBe(0);
    expect(json.gated).toBe(false);
    expect(json.advisory).toHaveLength(0);
    expect(json.blocking).toHaveLength(0);
  });
});
