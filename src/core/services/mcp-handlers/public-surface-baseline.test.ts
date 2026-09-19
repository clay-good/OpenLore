import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileGitSync } from '../../../utils/git-exec.js';
import { OPENLORE_DIR, PUBLIC_SURFACE_BASELINE_REL_PATH } from '../../../constants.js';
import {
  applyAcceptedBaseline,
  justificationError,
  parseAcceptedBaseline,
  readAcceptedBaseline,
  serializeAcceptedBaseline,
  writeAcceptedBreakages,
  MAX_JUSTIFICATION_LENGTH,
  type AcceptedBreakage,
  type DecisionCurrency,
} from './public-surface-baseline.js';
import type { GovernanceFinding } from './enforcement-policy.js';

const HEADER = '# OpenLore accepted public-surface breakages v1\n';

function finding(code: string, subject: string, source = 'public-surface'): GovernanceFinding {
  return { code, severity: code === 'signature-unprovable' ? 'warning' : 'error', source, subject, message: `${code} on ${subject}` };
}

const noDecisions = new Map<string, DecisionCurrency>();

describe('accepted-baseline file format', () => {
  it('round-trips entries sorted by identity, one record per line', () => {
    const entries: AcceptedBreakage[] = [
      { code: 'param-removed', subject: 'src/b.ts::b', justification: 'dropped in v3' },
      { code: 'export-removed', subject: 'src/a.ts::parseLegacy', justification: 'legacy parser retired', decision: 'a1b2c3d4' },
    ];
    const text = serializeAcceptedBaseline(entries);
    expect(text).toBe(
      HEADER +
      '["accept","export-removed","src/a.ts::parseLegacy","legacy parser retired","a1b2c3d4"]\n' +
      '["accept","param-removed","src/b.ts::b","dropped in v3",""]\n',
    );
    expect(parseAcceptedBaseline(text)).toEqual([entries[1], entries[0]]);
    expect(serializeAcceptedBaseline([entries[1], entries[0]])).toBe(text);
  });

  it('escapes non-ASCII so a reviewed line cannot hide its content', () => {
    const text = serializeAcceptedBaseline([{ code: 'export-removed', subject: 'src/ä.ts::f', justification: 'ok' }]);
    expect(text).toContain('src/\\u00e4.ts::f');
    expect(parseAcceptedBaseline(text)[0].subject).toBe('src/ä.ts::f');
  });

  it.each([
    ['a wrong header', '# something else\n'],
    ['invalid JSON', HEADER + '{nope\n'],
    ['a wrong arity', HEADER + '["accept","export-removed","s","why"]\n'],
    ['a non-breaking code', HEADER + '["accept","export-added","s","why",""]\n'],
    ['the warning code', HEADER + '["accept","signature-unprovable","s","why",""]\n'],
    ['an empty subject', HEADER + '["accept","export-removed","","why",""]\n'],
    ['an empty justification', HEADER + '["accept","export-removed","s","  ",""]\n'],
    ['a padded justification', HEADER + '["accept","export-removed","s"," why",""]\n'],
    ['a control character', HEADER + '["accept","export-removed","s","why\\u001b[31m",""]\n'],
    ['a malformed decision id', HEADER + '["accept","export-removed","s","why","A1B2C3D4"]\n'],
    ['a duplicate identity', HEADER + '["accept","export-removed","s","why",""]\n["accept","export-removed","s","again",""]\n'],
    ['a comment line', HEADER + '# note\n'],
  ])('rejects %s', (_label, text) => {
    expect(() => parseAcceptedBaseline(text)).toThrow();
  });

  it('requires a bounded, printable justification', () => {
    expect(justificationError(undefined)).toMatch(/requires a justification/);
    expect(justificationError('   ')).toMatch(/requires a justification/);
    expect(justificationError('x'.repeat(MAX_JUSTIFICATION_LENGTH + 1))).toMatch(/exceeds/);
    expect(justificationError('line one\nline two')).toMatch(/control characters/);
    expect(justificationError('intended: v3 drops the legacy parser')).toBeNull();
  });
});

describe('applyAcceptedBaseline', () => {
  const accepted: AcceptedBreakage = { code: 'export-removed', subject: 'src/a.ts::parseLegacy', justification: 'retired in v3' };

  it('an accepted break stops blocking but stays visible, and a new break still reports', () => {
    const findings = [finding('export-removed', 'src/a.ts::parseLegacy'), finding('param-removed', 'src/b.ts::b')];
    const r = applyAcceptedBaseline(findings, [accepted], noDecisions);
    expect(r.findings.map((f) => f.subject)).toEqual(['src/b.ts::b']);
    expect(r.accepted).toEqual([{ ...accepted, finding: findings[0] }]);
    expect(r.stale).toEqual([]);
    expect(r.unmatched).toEqual([]);
  });

  it('matches on code AND subject: another rule on the same symbol still reports', () => {
    const findings = [finding('param-removed', 'src/a.ts::parseLegacy')];
    const r = applyAcceptedBaseline(findings, [accepted], noDecisions);
    expect(r.findings).toEqual(findings);
    expect(r.unmatched).toEqual([{ code: 'export-removed', subject: 'src/a.ts::parseLegacy' }]);
  });

  it('never accepts a warning or a finding from another source', () => {
    const entries: AcceptedBreakage[] = [{ code: 'export-removed', subject: 's', justification: 'x' }];
    const findings = [finding('export-removed', 's', 'blast-radius'), finding('signature-unprovable', 's')];
    const r = applyAcceptedBaseline(findings, entries, noDecisions);
    expect(r.findings).toEqual(findings);
    expect(r.accepted).toEqual([]);
  });

  it('a superseded decision anchor expires the acceptance and cites the superseder', () => {
    const entry = { ...accepted, decision: 'a1b2c3d4' };
    const currency = new Map<string, DecisionCurrency>([['a1b2c3d4', { current: false, reason: 'decision a1b2c3d4 was superseded by b2c3d4e5', supersededBy: 'b2c3d4e5' }]]);
    const findings = [finding('export-removed', 'src/a.ts::parseLegacy')];
    const r = applyAcceptedBaseline(findings, [entry], currency);
    expect(r.findings).toEqual(findings);
    expect(r.accepted).toEqual([]);
    expect(r.stale).toEqual([{ ...entry, reason: 'decision a1b2c3d4 was superseded by b2c3d4e5', supersededBy: 'b2c3d4e5' }]);
  });

  it('a current decision anchor is honored; an unchecked one is not', () => {
    const entry = { ...accepted, decision: 'a1b2c3d4' };
    const findings = [finding('export-removed', 'src/a.ts::parseLegacy')];
    expect(applyAcceptedBaseline(findings, [entry], new Map([['a1b2c3d4', { current: true }]])).accepted).toHaveLength(1);
    const unchecked = applyAcceptedBaseline(findings, [entry], noDecisions);
    expect(unchecked.findings).toEqual(findings);
    expect(unchecked.stale[0].reason).toMatch(/could not be checked/);
  });
});

describe('writeAcceptedBreakages and readAcceptedBaseline', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'openlore-surface-baseline-'));
    await mkdir(join(root, OPENLORE_DIR), { recursive: true });
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('refuses without a justification and writes nothing', async () => {
    await expect(writeAcceptedBreakages(root, [finding('export-removed', 's')], '  ')).rejects.toThrow(/requires a justification/);
    await expect(readFile(join(root, PUBLIC_SURFACE_BASELINE_REL_PATH), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('writes only acceptable findings, then reads them back', async () => {
    const r = await writeAcceptedBreakages(root, [
      finding('export-removed', 'src/a.ts::a'),
      finding('signature-unprovable', 'src/a.ts::a'),
    ], ' retired in v3 ', 'a1b2c3d4');
    expect(r).toMatchObject({ written: true, replaced: 0, path: PUBLIC_SURFACE_BASELINE_REL_PATH });
    expect(r.added).toEqual([{ code: 'export-removed', subject: 'src/a.ts::a', justification: 'retired in v3', decision: 'a1b2c3d4' }]);
    const read = await readAcceptedBaseline(root);
    expect(read.present).toBe(true);
    expect(read.entries).toEqual(r.added);
  });

  it('keeps existing entries and replaces a re-accepted identity', async () => {
    await writeAcceptedBreakages(root, [finding('export-removed', 'src/a.ts::a'), finding('param-removed', 'src/b.ts::b')], 'first');
    const again = await writeAcceptedBreakages(root, [finding('export-removed', 'src/a.ts::a')], 'second', 'b2c3d4e5');
    expect(again).toMatchObject({ added: [], replaced: 1, written: true });
    expect((await readAcceptedBaseline(root)).entries).toEqual([
      { code: 'export-removed', subject: 'src/a.ts::a', justification: 'second', decision: 'b2c3d4e5' },
      { code: 'param-removed', subject: 'src/b.ts::b', justification: 'first' },
    ]);
    const unchanged = await writeAcceptedBreakages(root, [finding('export-removed', 'src/a.ts::a')], 'second', 'b2c3d4e5');
    expect(unchanged.written).toBe(false);
  });

  it('refuses to overwrite a baseline it cannot parse', async () => {
    await writeFile(join(root, PUBLIC_SURFACE_BASELINE_REL_PATH), 'garbage\n', 'utf8');
    await expect(writeAcceptedBreakages(root, [finding('export-removed', 's')], 'why')).rejects.toThrow(/header/);
    expect(await readFile(join(root, PUBLIC_SURFACE_BASELINE_REL_PATH), 'utf8')).toBe('garbage\n');
  });

  it('refuses a symlinked baseline on read', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'openlore-surface-outside-'));
    try {
      await writeFile(join(outside, 'b.jsonl'), HEADER, 'utf8');
      await symlink(join(outside, 'b.jsonl'), join(root, PUBLIC_SURFACE_BASELINE_REL_PATH));
      await expect(readAcceptedBaseline(root)).rejects.toThrow();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('makes the baseline trackable while .openlore/ stays ignored', async () => {
    execFileGitSync('git', ['init', '-q', root]);
    await writeFile(join(root, '.gitignore'), '.openlore/\n', 'utf8');
    await writeFile(join(root, OPENLORE_DIR, 'runtime.json'), '{}', 'utf8');
    await writeAcceptedBreakages(root, [finding('export-removed', 'src/a.ts::a')], 'why');
    const status = execFileGitSync('git', ['status', '--short', '--untracked-files=all'], { cwd: root }).toString();
    expect(status).toContain(`?? ${PUBLIC_SURFACE_BASELINE_REL_PATH}`);
    expect(status).not.toContain('runtime.json');
    expect(status).not.toContain('.public-surface-baseline.jsonl.lock');
  });

  it('upgrades the enforcement ratchet\'s earlier managed block instead of adding a second one', async () => {
    execFileGitSync('git', ['init', '-q', root]);
    const legacy = '# openlore-enforcement-baseline\n!.openlore/\n.openlore/*\n!.openlore/config.json\n!.openlore/enforcement-baseline.jsonl\n# end-openlore-enforcement-baseline\n';
    await writeFile(join(root, '.gitignore'), `.openlore/\n\n${legacy}`, 'utf8');
    await writeAcceptedBreakages(root, [finding('export-removed', 'src/a.ts::a')], 'why');
    const gitignore = await readFile(join(root, '.gitignore'), 'utf8');
    expect(gitignore.split('# openlore-enforcement-baseline\n')).toHaveLength(2);
    expect(gitignore).toContain('!.openlore/enforcement-baseline.jsonl\n!.openlore/public-surface-baseline.jsonl\n# end-openlore-enforcement-baseline');
    const status = execFileGitSync('git', ['status', '--short', '--untracked-files=all'], { cwd: root }).toString();
    expect(status).toContain(`?? ${PUBLIC_SURFACE_BASELINE_REL_PATH}`);
  });
});
