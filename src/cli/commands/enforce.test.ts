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
import { delimiter, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  installEnforcementHook,
  uninstallEnforcementHook,
  runEnforceCli,
  blastRadiusFindings,
  blastRadiusAssessmentComplete,
  impactCertificateFindings,
  dynamicBoundaryFindings,
  corpusIntentGovernanceFindings,
  collectGovernanceFindings,
  renderAgentHook,
} from './enforce.js';
import { classifyFindings } from '../../core/services/mcp-handlers/enforcement-policy.js';
import { applyEnforcementBaseline } from '../../core/services/mcp-handlers/enforcement-baseline.js';
import {
  OPENLORE_DIR,
  OPENLORE_DECISIONS_SUBDIR,
  DECISIONS_PENDING_FILE,
  OPENLORE_CONFIG_FILENAME,
} from '../../constants.js';
import type { DecisionStore, PendingDecision, EnforcementClass } from '../../types/index.js';

const created: string[] = [];
const execFileAsync = promisify(execFile);
afterEach(async () => { for (const r of created.splice(0)) await rm(r, { recursive: true, force: true }); process.exitCode = 0; });

async function mkRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'openlore-enforce-'));
  created.push(root);
  await mkdir(join(root, OPENLORE_DIR), { recursive: true });
  return root;
}

async function initializeGitHead(root: string): Promise<void> {
  await execFileAsync('git', ['init', '-q'], { cwd: root });
  await execFileAsync('git', [
    '-c', 'user.name=OpenLore Test', '-c', 'user.email=openlore@example.test', '-c', 'commit.gpgsign=false',
    'commit', '--allow-empty', '-q', '-m', 'initial',
  ], { cwd: root });
}

function decision(p: Partial<PendingDecision> & { id: string }): PendingDecision {
  return {
    id: p.id, status: p.status ?? 'approved', title: p.title ?? `d ${p.id}`,
    rationale: p.rationale ?? '', consequences: '', proposedRequirement: null,
    affectedDomains: [], affectedFiles: [], supersedes: p.supersedes,
    sessionId: 's1', recordedAt: '2026-06-23T00:00:00Z', contentOrigin: 'agent-recorded', confidence: 'high', syncedToSpecs: [],
    constraints: p.constraints,
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

async function commitFrozenScenario(root: string): Promise<string> {
  await initializeGitHead(root);
  await writeStaleScenario(root);
  await writePolicy(root, { 'stale-decision-reference': 'frozen' });
  await gateJson(root);
  await execFileAsync('git', ['add', '.gitignore', '.openlore/config.json', '.openlore/enforcement-baseline.jsonl'], { cwd: root });
  await execFileAsync('git', [
    '-c', 'user.name=OpenLore Test', '-c', 'user.email=openlore@example.test', '-c', 'commit.gpgsign=false',
    'commit', '-q', '-m', 'frozen baseline',
  ], { cwd: root });
  return readFile(join(root, '.openlore', 'enforcement-baseline.jsonl'), 'utf-8');
}

type GateJson = {
  schemaVersion: number;
  gated: boolean;
  blocking: Array<{ code: string }>;
  new: Array<{ code: string; enforcementClass: string; baselineState?: string }>;
  advisory: Array<{ code: string; severity: string }>;
  frozen: Array<{ code: string; enforcementClass: string; baselineState?: string }>;
  off: Array<{ code: string }>;
  unknownPolicyCodes: string[];
  ratchet: {
    initializedCodes: string[];
    frozenCount: number;
    newCount: number;
    retiredCount: number;
    baselineChanged: boolean;
    requiresInitialization: string[];
    failedAssessmentCodes: string[];
    unstaged: boolean;
  };
  caveats: string[];
  decisionEligibility?: {
    adoption: { constrained: number; authoritative: number; ratio: number };
    coverage: { constrainedEligible: number; eligible: number; ratio: number | null };
    unclassifiedCount: number;
    activeRuleCount: number;
  };
};

async function writeDecisionConstraintScenario(root: string): Promise<void> {
  const decisionsDir = join(root, OPENLORE_DIR, OPENLORE_DECISIONS_SUBDIR);
  const analysisDir = join(root, OPENLORE_DIR, 'analysis');
  await mkdir(decisionsDir, { recursive: true });
  await mkdir(analysisDir, { recursive: true });
  const constrained = decision({
    id: 'aaaaaaaa',
    title: 'Keep app database agnostic',
    rationale: 'Persistence stays behind the service boundary.',
    constraints: {
      version: 1,
      eligibility: { status: 'eligible', enforcedBoundary: 'src/app does not depend on src/db.' },
      rules: [{ id: 'app-no-db', scope: 'src/app', kind: 'forbidden', from: 'src/app', to: 'src/db' }],
    },
  });
  await writeFile(join(decisionsDir, DECISIONS_PENDING_FILE), JSON.stringify({
    version: '1', sessionId: 's1', updatedAt: '2026-08-23T00:00:00Z', decisions: [constrained],
  }, null, 2) + '\n');
  await writeFile(join(analysisDir, 'dependency-graph.json'), JSON.stringify({
    nodes: [
      { id: '/repo/src/app/a.ts', file: { path: 'src/app/a.ts', absolutePath: '/repo/src/app/a.ts' }, exports: [], metrics: {} },
      { id: '/repo/src/db/b.ts', file: { path: 'src/db/b.ts', absolutePath: '/repo/src/db/b.ts' }, exports: [], metrics: {} },
    ],
    edges: [{ source: '/repo/src/app/a.ts', target: '/repo/src/db/b.ts', importedNames: [], isTypeOnly: false, weight: 1 }],
  }, null, 2));
}

async function gateJson(root: string, hook = false): Promise<{ code: number; json: GateJson }> {
  const out: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string) => { out.push(s); return true; }) as typeof process.stdout.write;
  let code: number;
  try {
    code = await runEnforceCli({ cwd: root, json: true, hook });
  } finally {
    process.stdout.write = orig;
  }
  return { code, json: JSON.parse(out.join('')) as GateJson };
}

async function gateHuman(root: string): Promise<string> {
  const out: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string) => { out.push(s); return true; }) as typeof process.stdout.write;
  try {
    await runEnforceCli({ cwd: root });
  } finally {
    process.stdout.write = orig;
  }
  return out.join('');
}

async function gateHookHuman(root: string): Promise<{ code: number; stderr: string }> {
  const out: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((s: string | Uint8Array) => { out.push(String(s)); return true; }) as typeof process.stderr.write;
  try {
    return { code: await runEnforceCli({ cwd: root, hook: true }), stderr: out.join('') };
  } finally {
    process.stderr.write = orig;
  }
}

async function gateAgentHook(root: string): Promise<{ code: number; stderr: string }> {
  const out: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((s: string | Uint8Array) => { out.push(String(s)); return true; }) as typeof process.stderr.write;
  try {
    return { code: await runEnforceCli({ cwd: root, agentHook: true }), stderr: out.join('') };
  } finally {
    process.stderr.write = orig;
  }
}

describe('agent-loop enforcement hook', () => {
  it('resolves the repository root when the agent starts in a subdirectory', async () => {
    const root = await mkRepo();
    await initializeGitHead(root);
    await writeStaleScenario(root);
    await writePolicy(root, { 'stale-decision-reference': 'blocking' });
    const nested = join(root, 'packages', 'client');
    await mkdir(nested, { recursive: true });

    const out: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((value: string | Uint8Array) => { out.push(String(value)); return true; }) as typeof process.stderr.write;
    try {
      expect(await runEnforceCli({ cwd: nested, gitRoot: true, agentHook: true })).toBe(2);
    } finally {
      process.stderr.write = original;
    }
    expect(out.join('')).toContain('[blocking] Stale decision reference: decision:aaaaaaaa');
  });

  // POSIX-only fixture, like the trailing-`\r` case below: Windows silently strips
  // trailing whitespace from a path component, so a repository directory named
  // `repo ` cannot be created there and `git` cannot even be spawned with it as cwd.
  // The property under test (git's reported root is not trimmed) is therefore not
  // expressible on Windows; the subdirectory case above covers root resolution there.
  it.runIf(process.platform !== 'win32')('preserves trailing whitespace in the resolved repository path', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'openlore-enforce-parent-'));
    created.push(parent);
    const root = join(parent, 'repo ');
    await mkdir(join(root, OPENLORE_DIR), { recursive: true });
    await initializeGitHead(root);
    await writeStaleScenario(root);
    await writePolicy(root, { 'stale-decision-reference': 'blocking' });

    const out: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((value: string | Uint8Array) => { out.push(String(value)); return true; }) as typeof process.stderr.write;
    try {
      expect(await runEnforceCli({ cwd: root, gitRoot: true, agentHook: true })).toBe(2);
    } finally {
      process.stderr.write = original;
    }
    expect(out.join('')).toContain('[blocking] Stale decision reference: decision:aaaaaaaa');
  });

  it.runIf(process.platform !== 'win32')('preserves a trailing carriage return in the resolved repository path', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'openlore-enforce-parent-'));
    created.push(parent);
    const root = join(parent, 'repo\r');
    await mkdir(join(root, OPENLORE_DIR), { recursive: true });
    await initializeGitHead(root);
    await writeStaleScenario(root);
    await writePolicy(root, { 'stale-decision-reference': 'blocking' });

    const out: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((value: string | Uint8Array) => { out.push(String(value)); return true; }) as typeof process.stderr.write;
    try {
      expect(await runEnforceCli({ cwd: root, gitRoot: true, agentHook: true })).toBe(2);
    } finally {
      process.stderr.write = original;
    }
    expect(out.join('')).toContain('[blocking] Stale decision reference: decision:aaaaaaaa');
  });

  it('fails open with a caveat when the repository root cannot be resolved', async () => {
    const root = await mkRepo();
    const out: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((value: string | Uint8Array) => { out.push(String(value)); return true; }) as typeof process.stderr.write;
    try {
      expect(await runEnforceCli({ cwd: root, gitRoot: true, agentHook: true })).toBe(0);
    } finally {
      process.stderr.write = original;
    }
    expect(out.join('')).toMatch(/repository root unavailable/i);
    expect(out.join('')).toMatch(/agent turn was not blocked/i);
  });

  it('exits 2 only for blocking findings and renders the remediation first', async () => {
    const root = await mkRepo();
    await initializeGitHead(root);
    await writeStaleScenario(root);
    await writePolicy(root, { 'stale-decision-reference': 'blocking' });

    const result = await gateAgentHook(root);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('[blocking] Stale decision reference: decision:aaaaaaaa');
    expect(result.stderr.indexOf('Stale decision reference:')).toBeLessThan(result.stderr.indexOf('stale-decision-reference:'));
  });

  it('keeps advisory and frozen findings non-blocking in the agent loop', async () => {
    const root = await mkRepo();
    await initializeGitHead(root);
    await writeStaleScenario(root);

    const advisory = await gateAgentHook(root);
    expect(advisory.code).toBe(0);
    expect(advisory.stderr).toContain('[advisory]');

    await writePolicy(root, { 'stale-decision-reference': 'frozen' });
    const frozen = await gateAgentHook(root);
    expect(frozen.code).toBe(0);
    expect(frozen.stderr).toContain('[frozen:advisory]');
  });

  it('reports infrastructure caveats and exits 0 when config cannot be read', async () => {
    const root = await mkRepo();
    await initializeGitHead(root);
    await writeFile(join(root, OPENLORE_DIR, OPENLORE_CONFIG_FILENAME), '{broken', 'utf-8');

    const result = await gateAgentHook(root);
    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/config unavailable/i);
    expect(result.stderr).toMatch(/incomplete; the agent turn was not blocked/i);
  });

  it('reports an unavailable configured source and exits 0 instead of blocking', async () => {
    const root = await mkRepo();
    await initializeGitHead(root);
    await writePolicy(root, { 'architecture-forbidden-dependency': 'blocking' });
    await writeFile(join(root, '.openlore', 'architecture.json'), JSON.stringify({
      forbidden: [{ from: 'src/domain', to: 'src/infra' }],
    }), 'utf-8');

    const result = await gateAgentHook(root);
    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/architecture rule check unavailable/i);
    expect(result.stderr).toMatch(/incomplete; the agent turn was not blocked/i);
  });

  it('does not fabricate remediation for finding codes without a template', () => {
    const result = classifyFindings([{
      code: 'surface-info', severity: 'info', source: 'impact-certificate',
      subject: 'client', message: 'informational reachability change',
    }], {});
    const output = renderAgentHook(result, []);
    expect(output).toContain('[advisory] surface-info: informational reachability change');
    expect(output).not.toContain('Action:');
  });

  it('renders a source-default blocking finding as advisory when no policy configured it', () => {
    const result = classifyFindings([{
      code: 'corpus-reference-unresolved', severity: 'error', source: 'corpus-integrity',
      subject: 'ADR-1', message: 'target is missing',
    }], {});
    expect(result.blocking).toHaveLength(1);
    expect(renderAgentHook(result, [], false, new Set())).toContain('[advisory]');
  });

  it('rejects incompatible output, hook, and lifecycle modes', async () => {
    const root = await mkRepo();
    for (const options of [
      { json: true }, { hook: true }, { installHook: true }, { uninstallHook: true },
    ]) {
      const out: string[] = [];
      const original = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((value: string | Uint8Array) => { out.push(String(value)); return true; }) as typeof process.stderr.write;
      try {
        expect(await runEnforceCli({ cwd: root, agentHook: true, ...options })).toBe(1);
      } finally {
        process.stderr.write = original;
      }
      expect(out.join('')).toMatch(/cannot be combined/i);
    }
  });
});

describe('architecture assessment hardening', () => {
  it('fails configured architecture codes when declared config is malformed', async () => {
    const root = await mkRepo();
    await writeFile(join(root, '.openlore', 'architecture.json'), '{not-json');

    const collected = await collectGovernanceFindings(root, null, {
      'architecture-forbidden-dependency': 'blocking',
    });

    expect(collected.failedCodes).toContain('architecture-forbidden-dependency');
    expect(collected.caveats.join(' ')).toContain('architecture rule assessment incomplete');
  });

  it('fails configured architecture codes for a misspelled rule key', async () => {
    const root = await mkRepo();
    await writeFile(join(root, '.openlore', 'architecture.json'), JSON.stringify({
      forbiden: [{ from: 'src/domain', to: 'src/infra' }],
    }));

    const collected = await collectGovernanceFindings(root, null, {
      'architecture-forbidden-dependency': 'blocking',
    });

    expect(collected.failedCodes).toContain('architecture-forbidden-dependency');
    expect(collected.assessedCodes).not.toContain('architecture-forbidden-dependency');
  });

  it('never assesses a valid rule from a partially malformed config', async () => {
    const root = await mkRepo();
    await writeFile(join(root, '.openlore', 'architecture.json'), JSON.stringify({
      forbidden: [{ from: 'src/domain', to: 'src/infra' }],
      forbiden: [{ from: 'src/domain', to: 'src/infra' }],
    }));

    const collected = await collectGovernanceFindings(root, null, {
      'architecture-forbidden-dependency': 'frozen',
    });

    expect(collected.failedCodes).toContain('architecture-forbidden-dependency');
    expect(collected.assessedCodes).not.toContain('architecture-forbidden-dependency');
  });

  it('does not fail an unrelated architecture code when an active rule lacks a graph', async () => {
    const root = await mkRepo();
    await writeFile(join(root, '.openlore', 'architecture.json'), JSON.stringify({
      orphan: [{ scope: 'src/lib' }],
    }));

    const collected = await collectGovernanceFindings(root, null, {
      'architecture-cycle': 'blocking',
    });

    expect(collected.failedCodes).toContain('architecture-orphan');
    expect(collected.failedCodes).not.toContain('architecture-cycle');
    expect(collected.assessedCodes).toContain('architecture-cycle');
  });
});

describe('enforce git hook install/uninstall', () => {
  const readHook = (root: string) => readFile(join(root, '.git', 'hooks', 'pre-commit'), 'utf-8');

  it('installs a fresh advisory hook (#!/bin/sh, marker, advisory by default)', async () => {
    const root = await mkRepo();
    await mkdir(join(root, '.git'), { recursive: true });
    await installEnforcementHook(root);
    const h = await readHook(root);
    expect(h.startsWith('#!/bin/sh')).toBe(true);
    expect(h).toContain('# openlore-enforcement-hook');
    expect(h).toContain("'enforce' '--hook'");
    expect(h).not.toContain('node_modules/.bin/openlore');
    expect(h).not.toContain('command -v openlore');
  });

  it('pins an absolute launcher instead of relying on PATH', async () => {
    const root = await mkRepo();
    await mkdir(join(root, '.git'), { recursive: true });
    await installEnforcementHook(root);

    const h = await readHook(root);
    expect(h).toContain(process.execPath);
    expect(h).not.toContain('npx');
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

  it('installs into core.hooksPath and Git executes the resulting hook', async () => {
    const root = await mkRepo();
    await execFileAsync('git', ['init'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'test@openlore.dev'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'OpenLore Test'], { cwd: root });
    await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: root });
    await execFileAsync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root });
    await mkdir(join(root, '.githooks'), { recursive: true });
    await mkdir(join(root, 'test-bin'), { recursive: true });
    await writeFile(
      join(root, '.githooks', 'pre-commit'),
      '#!/bin/sh\n',
      { encoding: 'utf-8', mode: 0o755 },
    );
    await writeFile(
      join(root, 'test-bin', 'openlore'),
      '#!/bin/sh\nif [ "$2" = "--help" ]; then echo --hook; elif [ "$2" = "--hook" ]; then printf ran > openlore-hook-ran; fi\n',
      { encoding: 'utf-8', mode: 0o755 },
    );

    await installEnforcementHook(root);
    const hook = await readFile(join(root, '.githooks', 'pre-commit'), 'utf-8');
    expect(hook).toContain('# openlore-enforcement-hook');
    await execFileAsync('git', ['commit', '--allow-empty', '-m', 'exercise custom hook'], {
      cwd: root,
      env: { ...process.env, PATH: `${join(root, 'test-bin')}${delimiter}${process.env.PATH ?? ''}` },
    });
    await expect(readFile(join(root, 'openlore-hook-ran'), 'utf-8')).rejects.toThrow();
  });
});

// ── source mapping: blast-radius + impact-certificate → unified findings ───────
// These are the gate's collection paths for the diff-heavy sources, exercised as
// pure functions over synthetic briefings (the same style as triggeredBlockPatterns).
describe('blastRadiusFindings — orphan patterns map to unified findings', () => {
  const briefing = (memOrphaned: number, decOrphaned: number) => ({
    memory: {
      orphaned: memOrphaned, drifted: 0, willDrift: [],
      orphanFindings: Array.from({ length: memOrphaned }, (_, i) => ({ id: `memory-${i}`, filePath: `memory-${i}.ts`, message: `memory ${i} orphaned` })),
    },
    decisions: {
      affected: decOrphaned, orphaned: decOrphaned, items: [],
      orphanFindings: Array.from({ length: decOrphaned }, (_, i) => ({ id: `decision-${i}`, filePath: `adr-${i}.md`, message: `decision ${i} orphaned` })),
    },
    driftAssessment: { complete: true, filesOmitted: 0, detailsTruncated: false },
  }) as unknown as import('../../core/services/mcp-handlers/blast-radius.js').BlastRadiusBriefing;

  it('emits orphans-anchored-memory only when memory is orphaned', () => {
    expect(blastRadiusFindings(briefing(2, 0)).map((f) => f.code)).toEqual([
      'orphans-anchored-memory', 'orphans-anchored-memory',
    ]);
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

  it('does not let a second orphan hide behind the first frozen identity', async () => {
    const root = await mkRepo();
    const policy = { 'orphans-anchored-memory': 'frozen' } as const;
    const managed = new Set(['orphans-anchored-memory']);
    await applyEnforcementBaseline(root, classifyFindings(blastRadiusFindings(briefing(1, 0)), policy), policy, managed, 'bootstrap');

    const result = await applyEnforcementBaseline(
      root,
      classifyFindings(blastRadiusFindings(briefing(2, 0)), policy),
      policy,
      managed,
      'gate',
    );

    expect(result.gate.gated).toBe(true);
    expect(result.gate.blocking).toHaveLength(1);
    expect(result.gate.blocking[0]).toMatchObject({ discriminator: 'memory-1', baselineState: 'new' });
  });

  it('preserves frozen orphan debt when drift analysis is partial', async () => {
    const root = await mkRepo();
    const policy = { 'orphans-anchored-memory': 'frozen' } as const;
    const managed = new Set(['orphans-anchored-memory']);
    await applyEnforcementBaseline(root, classifyFindings(blastRadiusFindings(briefing(1, 0)), policy), policy, managed, 'bootstrap');
    const path = join(root, '.openlore', 'enforcement-baseline.jsonl');
    const before = await readFile(path, 'utf-8');
    const partial = {
      ...briefing(0, 0),
      driftAssessment: { complete: false, filesOmitted: 1, detailsTruncated: false },
    } as never;

    const assessed = blastRadiusAssessmentComplete(partial) ? managed : new Set<string>();
    const result = await applyEnforcementBaseline(
      root,
      classifyFindings(blastRadiusFindings(partial), policy),
      policy,
      assessed,
      'gate',
    );

    expect(blastRadiusAssessmentComplete(partial)).toBe(false);
    expect(result.baseline.removed).toBe(0);
    expect(await readFile(path, 'utf-8')).toBe(before);
  });
});

describe('impactCertificateFindings — surface severities map to per-severity codes', () => {
  const cert = (paths: Array<{ surface: string; surfaceSeverity: string }>) =>
    ({ newlyOpenedPaths: paths.map((path) => ({
      ...path,
      openingEdge: { from: `from-${path.surface}`, to: `to-${path.surface}` },
      path: [`from-${path.surface}`, `to-${path.surface}`],
      pathIds: [`src/from.ts::from-${path.surface}`, `src/to.ts::to-${path.surface}`],
      reaches: `to-${path.surface}`,
    })) }) as never;

  it('groups newly-opened paths into surface-<severity> codes', () => {
    const out = impactCertificateFindings(cert([
      { surface: 'client', surfaceSeverity: 'critical' },
      { surface: 'data', surfaceSeverity: 'warn' },
    ]));
    expect(out.map((f) => f.code).sort()).toEqual(['surface-critical', 'surface-warn']);
  });
  it('emits one stable finding per reached surface/path', () => {
    const out = impactCertificateFindings(cert([
      { surface: 'zeta', surfaceSeverity: 'critical' },
      { surface: 'alpha', surfaceSeverity: 'critical' },
    ]));
    expect(out).toHaveLength(2);
    expect(out.map((finding) => finding.subject)).toEqual(['alpha', 'zeta']);
  });
  it('keeps distinct canonical paths when their display names collide', () => {
    const base = {
      surface: 'client', surfaceSeverity: 'critical',
      openingEdge: { from: 'run', to: 'send' }, path: ['run', 'send'], reaches: 'send',
    };
    const out = impactCertificateFindings({
      newlyOpenedPaths: [
        { ...base, pathIds: ['src/a.ts::run', 'src/a.ts::send'] },
        { ...base, pathIds: ['src/b.ts::run', 'src/b.ts::send'] },
      ],
    } as never);
    expect(out).toHaveLength(2);
    expect(new Set(out.map((finding) => finding.discriminator)).size).toBe(2);
  });
  it('normalizes intrinsic surface severity (info→info, warn→warning, critical→error)', () => {
    const sev = (s: string) => impactCertificateFindings(cert([{ surface: 'x', surfaceSeverity: s }]))[0].severity;
    expect(sev('info')).toBe('info');
    expect(sev('warn')).toBe('warning');
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

  it('ratchets alpha without making the still-existing zeta path new', async () => {
    const root = await mkRepo();
    const policy = { 'surface-critical': 'frozen' } as const;
    const managed = new Set(['surface-critical']);
    const both = impactCertificateFindings(cert([
      { surface: 'alpha', surfaceSeverity: 'critical' },
      { surface: 'zeta', surfaceSeverity: 'critical' },
    ]));
    await applyEnforcementBaseline(root, classifyFindings(both, policy), policy, managed, 'bootstrap');

    const zeta = impactCertificateFindings(cert([{ surface: 'zeta', surfaceSeverity: 'critical' }]));
    const result = await applyEnforcementBaseline(root, classifyFindings(zeta, policy), policy, managed, 'gate');

    expect(result.gate.gated).toBe(false);
    expect(result.baseline.removed).toBe(1);
    expect(result.gate.frozen[0]).toMatchObject({ subject: 'zeta', baselineState: 'frozen' });
  });
});

describe('corpus intent findings — reviewer output maps to the unified gate', () => {
  const finding = {
    code: 'corpus-normative-weakened' as const,
    artifact: 'openspec/specs/auth/spec.md',
    requirement: 'RejectInvalidTokens',
    message: 'RejectInvalidTokens weakened SHALL to SHOULD.',
    baseValue: 'SHALL',
    headValue: 'SHOULD',
  };

  it('preserves artifact and message with a stable per-requirement identity', () => {
    expect(corpusIntentGovernanceFindings([finding])).toEqual([{
      code: 'corpus-normative-weakened',
      severity: 'warning',
      source: 'corpus-intent-review',
      subject: 'openspec/specs/auth/spec.md',
      message: 'RejectInvalidTokens weakened SHALL to SHOULD.',
      discriminator: JSON.stringify(['RejectInvalidTokens', 'SHALL', 'SHOULD']),
    }]);
  });

  it('is advisory by default and becomes blocking only through policy', () => {
    const findings = corpusIntentGovernanceFindings([finding]);
    expect(classifyFindings(findings, {}).gated).toBe(false);
    expect(classifyFindings(findings, {
      'corpus-normative-weakened': 'blocking',
    }).gated).toBe(true);
  });

  it('collects corpus intent changes in the real enforce path', async () => {
    const root = await mkRepo();
    await initializeGitHead(root);
    const specDir = join(root, 'openspec', 'specs', 'auth');
    await mkdir(specDir, { recursive: true });
    const base = '# Auth\n\n## Requirements\n\n### Requirement: RejectInvalidTokens\n\n' +
      'The system SHALL reject invalid tokens.\n\n#### Scenario: Reject\n\n' +
      '- **GIVEN** an invalid token\n- **WHEN** authentication runs\n- **THEN** the request is rejected\n';
    await writeFile(join(specDir, 'spec.md'), base);
    await execFileAsync('git', ['add', 'openspec'], { cwd: root });
    await execFileAsync('git', [
      '-c', 'user.name=OpenLore Test', '-c', 'user.email=openlore@example.test',
      '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'base corpus',
    ], { cwd: root });
    await writeFile(join(specDir, 'spec.md'), base.replace('SHALL', 'SHOULD'));

    const result = await gateJson(root);

    expect(result.code).toBe(0);
    expect(result.json.advisory).toContainEqual(expect.objectContaining({
      code: 'corpus-normative-weakened',
    }));
  });
});

describe('enforce gate decision', () => {
  it('applies corpus source defaults and honors an explicit advisory downgrade', async () => {
    const root = await mkRepo();
    await initializeGitHead(root);
    const specDir = join(root, 'openspec', 'specs', 'demo');
    await mkdir(specDir, { recursive: true });
    await writeFile(join(specDir, 'spec.md'),
      '# Demo\n\n## Requirements\n\n### Requirement: Broken\n\n> Decision recorded: deadbeef\n');
    await execFileAsync('git', ['add', 'openspec/specs/demo/spec.md'], { cwd: root });

    const blocked = await gateJson(root, true);
    expect(blocked.code).toBe(1);
    expect(blocked.json.blocking.map((finding) => finding.code)).toContain('corpus-reference-unresolved');

    await writePolicy(root, { 'corpus-reference-unresolved': 'advisory' });
    await execFileAsync('git', ['add', '.openlore/config.json'], { cwd: root });
    const downgraded = await gateJson(root, true);
    expect(downgraded.code).toBe(0);
    expect(downgraded.json.advisory.map((finding) => finding.code)).toContain('corpus-reference-unresolved');
  });

  it('does not gate when undeclared-reference advice is the only corpus finding', async () => {
    const root = await mkRepo();
    await initializeGitHead(root);
    const specDir = join(root, 'openspec', 'specs', 'demo');
    const changeDir = join(root, 'openspec', 'changes', 'active');
    await mkdir(specDir, { recursive: true });
    await mkdir(changeDir, { recursive: true });
    await writeFile(join(specDir, 'spec.md'),
      '# Demo\n\n## Decisions\n\n### Known\n\n**Status:** Approved\n**ID:** aaaaaaaa\n');
    await writeFile(join(changeDir, 'proposal.md'), '# Proposal\n\nDecision aaaaaaaa informs this work.\n');
    await execFileAsync('git', ['add', 'openspec'], { cwd: root });

    const result = await gateJson(root, true);
    expect(result.code).toBe(0);
    expect(result.json.gated).toBe(false);
    expect(result.json.advisory.map((finding) => finding.code)).toEqual(['corpus-reference-undeclared']);
  });

  it('checks index/worktree parity for source-default blocking corpus findings', async () => {
    const root = await mkRepo();
    await initializeGitHead(root);
    const specDir = join(root, 'openspec', 'specs', 'demo');
    await mkdir(specDir, { recursive: true });
    const bad = '# Demo\n\n## Requirements\n\n### Requirement: Broken\n\nThe system SHALL fail closed.\n\n> Decision recorded: deadbeef\n';
    const clean = '# Demo\n\n## Requirements\n\n### Requirement: Clean\n\nThe system SHALL remain valid.\n';
    await writeFile(join(specDir, 'spec.md'), bad, 'utf8');
    await execFileAsync('git', ['add', 'openspec/specs/demo/spec.md'], { cwd: root });
    await writeFile(join(specDir, 'spec.md'), clean, 'utf8');

    const { code, json } = await gateJson(root, true);
    expect(code).toBe(1);
    expect(json.gated).toBe(true);
    expect(json.ratchet.unstaged).toBe(true);
  });

  it('sanitizes repository-authored control bytes in hook output', async () => {
    const root = await mkRepo();
    await initializeGitHead(root);
    const specDir = join(root, 'openspec', 'specs', 'demo');
    await mkdir(specDir, { recursive: true });
    await writeFile(join(specDir, 'spec.md'),
      '# Demo\n\n## Requirements\n\n### Requirement: hostile-\u001b[2J-name\n\nThe system SHALL cite.\n\n> Decision recorded: deadbeef\n', 'utf8');
    await execFileAsync('git', ['add', 'openspec/specs/demo/spec.md'], { cwd: root });

    const result = await gateHookHuman(root);
    expect(result.code).toBe(1);
    expect(result.stderr).not.toContain('\u001b');
    expect(result.stderr).not.toContain('\r');
    expect(result.stderr).toContain('hostile-[2J-name');
  });

  it('advisory by default — a stale-decision-reference does not block (exit 0)', async () => {
    const root = await mkRepo();
    await writeStaleScenario(root);
    const { code, json } = await gateJson(root);
    expect(code).toBe(0);
    expect(json.schemaVersion).toBe(3);
    expect(json.advisory.every((finding) => ['info', 'warning', 'error', 'critical'].includes(finding.severity))).toBe(true);
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

  it('a malformed enforcement.policy fails closed in hook mode', async () => {
    const root = await mkRepo();
    await initializeGitHead(root);
    await writeStaleScenario(root);
    // A hostile policy shape must not be lowered to the no-policy default.
    await writeFile(join(root, OPENLORE_DIR, OPENLORE_CONFIG_FILENAME),
      JSON.stringify({
        version: '1.0.0', projectType: 'nodejs', openspecPath: 'openspec',
        analysis: { maxFiles: 100, includePatterns: [], excludePatterns: [] },
        generation: { domains: 'auto' }, createdAt: '2026-01-01T00:00:00Z', lastRun: null,
        enforcement: { policy: ['blocking'] },
      }), 'utf-8');
    const { code, json } = await gateJson(root, true);
    expect(code).toBe(1);
    expect(json.gated).toBe(true);
    expect(json.caveats.join(' ')).toMatch(/enforcement config unavailable.*enforcement\.policy/i);
    expect(json.ratchet.unstaged).toBe(true);
  });

  it('rejects staged malformed config when the working tree is restored to valid no-policy bytes', async () => {
    const root = await mkRepo();
    await initializeGitHead(root);
    const configPath = join(root, OPENLORE_DIR, OPENLORE_CONFIG_FILENAME);
    await writePolicy(root, {});
    const valid = await readFile(configPath, 'utf-8');
    await execFileAsync('git', ['add', '-f', '.openlore/config.json'], { cwd: root });
    await execFileAsync('git', [
      '-c', 'user.name=OpenLore Test', '-c', 'user.email=openlore@example.test', '-c', 'commit.gpgsign=false',
      'commit', '-q', '-m', 'valid config',
    ], { cwd: root });

    await writeFile(configPath, '{ malformed staged policy', 'utf-8');
    await execFileAsync('git', ['add', '-f', '.openlore/config.json'], { cwd: root });
    await writeFile(configPath, valid, 'utf-8');

    const { code, json } = await gateJson(root, true);
    expect(code).toBe(1);
    expect(json.gated).toBe(true);
    expect(json.ratchet.unstaged).toBe(true);
    expect(json.caveats.join(' ')).toMatch(/config differs between the Git index and working tree/i);
  });

  it('an absent config remains advisory even when hook Git checks are unavailable', async () => {
    const root = await mkRepo();
    const { code, json } = await gateJson(root, true);
    expect(code).toBe(0);
    expect(json.gated).toBe(false);
    expect(json.caveats.join(' ')).not.toMatch(/config unavailable|staging status unavailable/i);
  });

  it('does not create baseline state for a Git repository with no policy or prior baseline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openlore-enforce-no-policy-'));
    created.push(root);
    await initializeGitHead(root);

    const { code, json } = await gateJson(root, true);

    expect(code).toBe(0);
    expect(json.gated).toBe(false);
    await expect(readFile(join(root, '.openlore', 'enforcement-baseline.jsonl'), 'utf-8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed and preserves a 0/0 receipt when a configured frozen source is unavailable', async () => {
    const root = await mkRepo();
    await writePolicy(root, { 'orphans-anchored-memory': 'frozen' });

    const { code, json } = await gateJson(root, true);
    expect(code).toBe(1);
    expect(json.gated).toBe(true);
    expect(json.ratchet).toMatchObject({ frozenCount: 0, newCount: 0 });
    expect(json.ratchet.failedAssessmentCodes).toContain('orphans-anchored-memory');
    expect(json.caveats.join(' ')).toMatch(/frozen assessment failed.*baseline bytes were preserved/i);
    expect(await gateHuman(root)).toMatch(/Ratchet: 0 frozen, 0 new/);
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

  it('bootstraps frozen debt outside hook mode, then reports it as frozen', async () => {
    const root = await mkRepo();
    await initializeGitHead(root);
    await writeStaleScenario(root);
    await writePolicy(root, { 'stale-decision-reference': 'frozen' });

    const first = await gateJson(root);
    expect(first.code).toBe(0);
    expect(first.json.gated).toBe(false);
    expect(first.json.ratchet.initializedCodes).toEqual(['stale-decision-reference']);
    expect(first.json.frozen).toHaveLength(1);
    await execFileAsync('git', ['add', '.gitignore', '.openlore/config.json', '.openlore/enforcement-baseline.jsonl'], { cwd: root });

    const second = await gateJson(root, true);
    expect(second.code).toBe(0);
    expect(second.json.gated).toBe(false);
    expect(second.json.frozen[0]).toMatchObject({
      code: 'stale-decision-reference', enforcementClass: 'frozen', baselineState: 'frozen',
    });
  });

  it('fails closed when an active frozen hook cannot inspect staging state', async () => {
    const root = await mkRepo();
    await writeStaleScenario(root);
    await writePolicy(root, { 'stale-decision-reference': 'frozen' });
    const policy = { 'stale-decision-reference': 'frozen' } as const;
    const finding = {
      code: 'stale-decision-reference', severity: 'warning' as const, source: 'stale-decision-reference',
      subject: 'decision:aaaaaaaa', discriminator: 'bbbbbbbb', message: 'stale reference',
    };
    await applyEnforcementBaseline(root, classifyFindings([finding], policy), policy, new Set(Object.keys(policy)), 'bootstrap');

    const result = await gateJson(root, true);

    expect(result.code).toBe(1);
    expect(result.json.gated).toBe(true);
    expect(result.json.caveats.join(' ')).toMatch(/frozen baseline staging status unavailable/i);
  });

  it('rejects an unstaged frozen-baseline mismatch in hook mode', async () => {
    const root = await mkRepo();
    await initializeGitHead(root);
    await writeStaleScenario(root);
    await writePolicy(root, { 'stale-decision-reference': 'frozen' });
    await gateJson(root);
    await execFileAsync('git', ['add', '.gitignore', '.openlore/enforcement-baseline.jsonl'], { cwd: root });
    await writeFile(join(root, '.openlore', 'enforcement-baseline.jsonl'), '# OpenLore frozen enforcement baseline v1\n', 'utf-8');

    const result = await gateJson(root, true);

    expect(result.code).toBe(1);
    expect(result.json.gated).toBe(true);
    expect(result.json.ratchet.unstaged).toBe(true);
  });

  it('rejects staged source bytes when the assessed worktree has been restored clean', async () => {
    const root = await mkRepo();
    await initializeGitHead(root);
    await mkdir(join(root, 'src'), { recursive: true });
    const sourcePath = join(root, 'src', 'subject.ts');
    await writeFile(sourcePath, 'export const subject = "clean";\n', 'utf-8');
    await execFileAsync('git', ['add', 'src/subject.ts'], { cwd: root });
    await execFileAsync('git', [
      '-c', 'user.name=OpenLore Test', '-c', 'user.email=openlore@example.test', '-c', 'commit.gpgsign=false',
      'commit', '-q', '-m', 'source',
    ], { cwd: root });
    await writeStaleScenario(root);
    await writePolicy(root, { 'stale-decision-reference': 'frozen' });
    await gateJson(root);
    await execFileAsync('git', ['add', '.gitignore', '.openlore/config.json', '.openlore/enforcement-baseline.jsonl'], { cwd: root });
    await execFileAsync('git', [
      '-c', 'user.name=OpenLore Test', '-c', 'user.email=openlore@example.test', '-c', 'commit.gpgsign=false',
      'commit', '-q', '-m', 'baseline',
    ], { cwd: root });

    await writeFile(sourcePath, 'export const subject = "bad staged bytes";\n', 'utf-8');
    await execFileAsync('git', ['add', 'src/subject.ts'], { cwd: root });
    await writeFile(sourcePath, 'export const subject = "clean";\n', 'utf-8');

    const result = await gateJson(root, true);

    expect(result.code).toBe(1);
    expect(result.json.gated).toBe(true);
    expect(result.json.ratchet.unstaged).toBe(true);
  });

  it('hook mode never initializes a missing frozen baseline', async () => {
    const root = await mkRepo();
    await initializeGitHead(root);
    await writeStaleScenario(root);
    await writePolicy(root, { 'stale-decision-reference': 'frozen' });

    const result = await gateJson(root, true);
    expect(result.code).toBe(1);
    expect(result.json.gated).toBe(true);
    expect(result.json.ratchet.requiresInitialization).toEqual(['stale-decision-reference']);
    expect(result.json.blocking[0]).toMatchObject({
      enforcementClass: 'frozen', baselineState: 'new',
    });
    expect(result.json.new).toEqual(result.json.blocking);
  });

  it('ratchets a fixed finding away so reintroduction blocks as new', async () => {
    const root = await mkRepo();
    await initializeGitHead(root);
    await writeStaleScenario(root);
    await writePolicy(root, { 'stale-decision-reference': 'frozen' });
    await gateJson(root);
    await execFileAsync('git', ['add', '.gitignore', '.openlore/enforcement-baseline.jsonl'], { cwd: root });
    await execFileAsync('git', [
      '-c', 'user.name=OpenLore Test', '-c', 'user.email=openlore@example.test', '-c', 'commit.gpgsign=false',
      'commit', '-q', '-m', 'baseline',
    ], { cwd: root });

    const dir = join(root, OPENLORE_DIR, OPENLORE_DECISIONS_SUBDIR);
    const clean: DecisionStore = {
      version: '1', sessionId: 's', updatedAt: 'x', decisions: [decision({ id: 'aaaaaaaa' })],
    };
    await writeFile(join(dir, DECISIONS_PENDING_FILE), JSON.stringify(clean), 'utf-8');
    const fixed = await gateJson(root);
    expect(fixed.json.ratchet.retiredCount).toBe(1);

    await writeStaleScenario(root);
    const regressed = await gateJson(root, true);
    expect(regressed.code).toBe(1);
    expect(regressed.json.ratchet.newCount).toBe(1);
    expect(regressed.json.blocking[0]).toMatchObject({ enforcementClass: 'frozen', baselineState: 'new' });
    expect(regressed.json.new).toEqual(regressed.json.blocking);
  });

  it('rejects a staged baseline that launders a new frozen finding', async () => {
    const root = await mkRepo();
    await initializeGitHead(root);
    await writeStaleScenario(root);
    await writePolicy(root, { 'stale-decision-reference': 'frozen' });
    await gateJson(root);
    const baselinePath = join(root, '.openlore', 'enforcement-baseline.jsonl');
    await execFileAsync('git', ['add', '.gitignore', '.openlore/enforcement-baseline.jsonl'], { cwd: root });
    await execFileAsync('git', [
      '-c', 'user.name=OpenLore Test', '-c', 'user.email=openlore@example.test', '-c', 'commit.gpgsign=false',
      'commit', '-q', '-m', 'baseline',
    ], { cwd: root });

    const dir = join(root, OPENLORE_DIR, OPENLORE_DECISIONS_SUBDIR);
    const store = JSON.parse(await readFile(join(dir, DECISIONS_PENDING_FILE), 'utf-8')) as DecisionStore;
    store.decisions.push(decision({ id: 'dddddddd', rationale: 'also builds on bbbbbbbb' }));
    await writeFile(join(dir, DECISIONS_PENDING_FILE), JSON.stringify(store, null, 2) + '\n', 'utf-8');
    const baseline = await readFile(baselinePath, 'utf-8');
    await writeFile(
      baselinePath,
      `${baseline.trimEnd()}\n["finding","stale-decision-reference","decision:dddddddd","bbbbbbbb"]\n`,
      'utf-8',
    );
    await execFileAsync('git', ['add', '.openlore/enforcement-baseline.jsonl'], { cwd: root });

    const result = await gateJson(root, true);

    expect(result.code).toBe(1);
    expect(result.json.gated).toBe(true);
    expect(result.json.caveats.join(' ')).toMatch(/integrity check failed.*grew/i);
  });

  it('allows a staged downgrade when the trusted baseline remains byte-for-byte unchanged', async () => {
    const root = await mkRepo();
    const before = await commitFrozenScenario(root);
    await writePolicy(root, { 'stale-decision-reference': 'advisory' });
    await execFileAsync('git', ['add', '.openlore/config.json'], { cwd: root });

    const result = await gateJson(root, true);

    expect(result.code).toBe(0);
    expect(result.json.gated).toBe(false);
    expect(await readFile(join(root, '.openlore', 'enforcement-baseline.jsonl'), 'utf-8')).toBe(before);
  });

  it('rejects baseline deletion or growth staged with an all-code downgrade', async () => {
    for (const mutation of ['deletion', 'growth'] as const) {
      const root = await mkRepo();
      const baseline = await commitFrozenScenario(root);
      const baselinePath = join(root, '.openlore', 'enforcement-baseline.jsonl');
      await writePolicy(root, { 'stale-decision-reference': 'advisory' });
      if (mutation === 'deletion') {
        await rm(baselinePath);
      } else {
        await writeFile(
          baselinePath,
          `${baseline.trimEnd()}\n["finding","stale-decision-reference","decision:laundered","retired-x"]\n`,
          'utf-8',
        );
      }
      await execFileAsync('git', ['add', '-A', '--', '.openlore/config.json', '.openlore/enforcement-baseline.jsonl'], { cwd: root });

      const result = await gateJson(root, true);

      expect(result.code, mutation).toBe(1);
      expect(result.json.gated, mutation).toBe(true);
      expect(result.json.caveats.join(' '), mutation).toMatch(/integrity check failed.*unassessed or non-frozen code/i);
    }
  });
});

describe('decision-bound constraint enforcement and reporting', () => {
  it('emits a receipt-bearing advisory finding and four separate ledger measurements', async () => {
    const root = await mkRepo();
    await writeDecisionConstraintScenario(root);
    const { code, json } = await gateJson(root);
    expect(code).toBe(0);
    const finding = json.advisory.find((item) => item.code === 'decision-constraint-violation') as
      | { code: string; decision?: { id: string; title: string; rationale: string; ruleId: string } }
      | undefined;
    expect(finding?.decision).toEqual({
      id: 'aaaaaaaa',
      title: 'Keep app database agnostic',
      rationale: 'Persistence stays behind the service boundary.',
      ruleId: 'app-no-db',
      servedContentMetadata: { provenance: 'reviewed-corpus' },
    });
    expect(json.decisionEligibility).toMatchObject({
      adoption: { constrained: 1, authoritative: 1, ratio: 1 },
      coverage: { constrainedEligible: 1, eligible: 1, ratio: 1 },
      unclassifiedCount: 0,
      activeRuleCount: 1,
    });

    const human = await gateHuman(root);
    expect(human).toContain('Decision constraint adoption: 1/1 (100.0%).');
    expect(human).toContain('Decision constraint coverage: 1/1 (100.0%).');
    expect(human).toContain('Decision eligibility unclassified: 0.');
    expect(human).toContain('Active decision rules: 1.');
    expect(human).not.toMatch(/combined|overall.*percentage|coverageScore/i);
  });

  it('honors an explicit blocking policy and fails closed when its graph is missing', async () => {
    const root = await mkRepo();
    await initializeGitHead(root);
    await writeDecisionConstraintScenario(root);
    await writePolicy(root, { 'decision-constraint-violation': 'blocking' });
    const assessed = await gateJson(root);
    expect(assessed.json.blocking.map((finding) => finding.code)).toContain('decision-constraint-violation');

    await rm(join(root, OPENLORE_DIR, 'analysis', 'dependency-graph.json'));
    const missing = await gateJson(root, true);
    expect(missing.code).toBe(1);
    expect(missing.json.ratchet.failedAssessmentCodes).toContain('decision-constraint-violation');
  });

  it('sanitizes hostile decision text in normal terminal output', async () => {
    const root = await mkRepo();
    await writeDecisionConstraintScenario(root);
    const storePath = join(root, OPENLORE_DIR, OPENLORE_DECISIONS_SUBDIR, DECISIONS_PENDING_FILE);
    const store = JSON.parse(await readFile(storePath, 'utf8')) as DecisionStore;
    store.decisions[0].title = 'hostile\u001b]8;;https://evil.example\u0007link';
    store.decisions[0].rationale = 'reason\u001b[2J';
    await writeFile(storePath, JSON.stringify(store));
    const human = await gateHuman(root);
    expect(human).not.toContain('\u001b');
    expect(human).not.toContain('\u0007');
  });
});

// ---------------------------------------------------------------------------
// Dynamic-boundary findings (change: disclose-dynamic-boundary-regions)
// ---------------------------------------------------------------------------

describe('dynamicBoundaryFindings', () => {
  const crossing = (over: Record<string, unknown> = {}) => ({
    kind: 'dynamic-boundary' as const,
    count: 12,
    sites: [
      { file: 'src/b.ts', line: 4, kind: 'computed-member' },
      { file: 'src/a.ts', line: 9, kind: 'reflective-invoke' },
    ],
    detail: 'x',
    ...over,
  });
  const cert = (over: Record<string, unknown> = {}) => ({
    newlyOpenedPaths: [], surfaces: [{ name: 's' }], findings: [], caveats: [],
    ...over,
  } as never);

  it('emits nothing when the certificate made no negative claim to qualify', () => {
    // The spec's emission condition is narrow ON PURPOSE: a finding fires only where a conclusion
    // qualifies or caps a verdict, never for a purely informational disclosure. A certificate that
    // carries the crossing but did NOT withhold its claim is informational.
    expect(dynamicBoundaryFindings(cert({ dynamicBoundaries: crossing() }))).toEqual([]);
    expect(dynamicBoundaryFindings(cert({ newPathClaimQualified: true }))).toEqual([]);
  });

  it('emits one advisory finding per capped conclusion, carrying the truncation receipt', () => {
    const findings = dynamicBoundaryFindings(cert({
      newPathClaimQualified: true,
      dynamicBoundaries: crossing({ omittedSites: 3 }),
    }));
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe('dynamic-boundary-in-conclusion-scope');
    // The severity rides the emitted finding, never the registry entry.
    expect(findings[0].severity).toBe('info');
    expect(findings[0].subject).toBe('no new paths into any declared surface');
    // Both units are stated: `count` is SITES, the list and the omitted figure are GROUPS, so a
    // reader can check that 2 listed + 3 omitted is the group total.
    expect(findings[0].message).toContain('12 dispatch site(s) in the changed file(s)');
    expect(findings[0].message).toContain('across 5 file/kind group(s)');
    expect(findings[0].message).toContain('src/a.ts:9');
    expect(findings[0].message).toContain('3 group(s) not listed');
    // Sites are ordered, so the discriminator is stable across re-runs of the same diff and a
    // frozen baseline adopts it once.
    expect(findings[0].discriminator).toBe('src/a.ts:9:reflective-invoke,src/b.ts:4:computed-member');
  });

  it('is advisory by default, and blocks only when a policy says so', () => {
    const findings = dynamicBoundaryFindings(cert({
      newPathClaimQualified: true, dynamicBoundaries: crossing(),
    }));
    const open = classifyFindings(findings, {});
    expect(open.classified[0].enforcementClass).toBe('advisory');
    expect(open.blocking).toHaveLength(0);
    const policed = classifyFindings(findings, {
      'dynamic-boundary-in-conclusion-scope': 'blocking',
    });
    expect(policed.classified[0].enforcementClass).toBe('blocking');
    expect(policed.blocking).toHaveLength(1);
  });
});
