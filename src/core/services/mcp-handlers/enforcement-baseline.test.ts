import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  classifyFindings,
  type EnforcementPolicy,
  type GovernanceFinding,
} from './enforcement-policy.js';
import {
  applyEnforcementBaseline,
  enforcementFindingIdentity,
} from './enforcement-baseline.js';
import {
  ENFORCEMENT_BASELINE_REL_PATH,
  OPENLORE_DIR,
} from '../../../constants.js';

const created: string[] = [];
const execFileAsync = promisify(execFile);
const lockInterception = vi.hoisted(() => ({ afterAcquire: null as null | (() => Promise<void>) }));

vi.mock('../../runtime/advisory-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../runtime/advisory-lock.js')>();
  return {
    ...actual,
    acquireLockAt: async (...args: Parameters<typeof actual.acquireLockAt>) => {
      const result = await actual.acquireLockAt(...args);
      const afterAcquire = lockInterception.afterAcquire;
      lockInterception.afterAcquire = null;
      if (afterAcquire) await afterAcquire();
      return result;
    },
  };
});

afterEach(async () => {
  lockInterception.afterAcquire = null;
  for (const path of created.splice(0)) await rm(path, { recursive: true, force: true });
});

async function makeRoot(prefix = 'openlore-enforcement-baseline-'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  created.push(root);
  await mkdir(join(root, OPENLORE_DIR), { recursive: true });
  return root;
}

const policy: EnforcementPolicy = { 'stale-decision-reference': 'frozen' };
const managed = new Set(['stale-decision-reference']);

function finding(subject: string, discriminator?: string): GovernanceFinding {
  return {
    code: 'stale-decision-reference',
    severity: 'warning',
    source: 'stale-decision-reference',
    subject,
    message: `stale reference in ${subject}`,
    ...(discriminator === undefined ? {} : { discriminator }),
  };
}

function gate(findings: GovernanceFinding[], selectedPolicy: EnforcementPolicy = policy) {
  return classifyFindings(findings, selectedPolicy);
}

async function baselineBytes(root: string): Promise<string> {
  return readFile(join(root, ENFORCEMENT_BASELINE_REL_PATH), 'utf8');
}

describe('frozen enforcement baseline', () => {
  it('records per-code initialization even when the first snapshot has zero findings', async () => {
    const root = await makeRoot();

    const result = await applyEnforcementBaseline(root, gate([]), policy, managed, 'bootstrap');

    expect(result.gate.gated).toBe(false);
    expect(result.baseline).toMatchObject({
      initialized: ['stale-decision-reference'],
      frozen: 0,
      new: 0,
      written: true,
    });
    expect(await baselineBytes(root)).toContain('["code","stale-decision-reference"]');

    const firstFinding = await applyEnforcementBaseline(
      root,
      gate([finding('memory:m1', 'retired-a')]),
      policy,
      managed,
      'gate',
    );
    expect(firstFinding.gate.gated).toBe(true);
    expect(firstFinding.gate.blocking[0]).toMatchObject({
      enforcementClass: 'frozen',
      baselineState: 'new',
    });
  });

  it('freezes every finding in the initial snapshot without gating', async () => {
    const root = await makeRoot();
    const initial = finding('memory:m1', 'retired-a');

    const result = await applyEnforcementBaseline(root, gate([initial]), policy, managed, 'bootstrap');

    expect(result.gate.gated).toBe(false);
    expect(result.gate.frozen).toHaveLength(1);
    expect(result.gate.frozen[0]).toMatchObject({
      enforcementClass: 'frozen',
      baselineState: 'frozen',
    });
    expect(await baselineBytes(root)).toContain(JSON.stringify(enforcementFindingIdentity(initial)));
  });

  it('gates a new finding while preserving its frozen class and new baseline state', async () => {
    const root = await makeRoot();
    const existing = finding('memory:m1', 'retired-a');
    const added = finding('memory:m2', 'retired-b');
    await applyEnforcementBaseline(root, gate([existing]), policy, managed, 'bootstrap');

    const result = await applyEnforcementBaseline(root, gate([existing, added]), policy, managed, 'gate');

    expect(result.gate.gated).toBe(true);
    expect(result.baseline).toMatchObject({ frozen: 1, new: 1, written: false });
    expect(result.gate.blocking).toHaveLength(1);
    expect(result.gate.blocking[0]).toMatchObject({
      subject: 'memory:m2',
      enforcementClass: 'frozen',
      baselineState: 'new',
    });
    expect(result.gate.frozen.find((item) => item.subject === 'memory:m1')).toMatchObject({
      enforcementClass: 'frozen',
      baselineState: 'frozen',
    });
  });

  it('ratchets a resolved identity away so reintroducing it is new and blocking', async () => {
    const root = await makeRoot();
    const original = finding('spec:auth', 'retired-a');
    await applyEnforcementBaseline(root, gate([original]), policy, managed, 'bootstrap');

    const removed = await applyEnforcementBaseline(root, gate([]), policy, managed, 'gate');
    expect(removed.baseline).toMatchObject({ removed: 1, written: true });
    expect(await baselineBytes(root)).not.toContain(JSON.stringify(enforcementFindingIdentity(original)));

    const reintroduced = await applyEnforcementBaseline(root, gate([original]), policy, managed, 'gate');
    expect(reintroduced.gate.gated).toBe(true);
    expect(reintroduced.gate.blocking[0]).toMatchObject({
      enforcementClass: 'frozen',
      baselineState: 'new',
    });
  });

  it('does not read, write, or ratchet the baseline after a downgrade to advisory', async () => {
    const root = await makeRoot();
    const original = finding('decision:d1', 'retired-a');
    await applyEnforcementBaseline(root, gate([original]), policy, managed, 'bootstrap');
    const before = await baselineBytes(root);
    const advisoryPolicy: EnforcementPolicy = { 'stale-decision-reference': 'advisory' };

    const result = await applyEnforcementBaseline(
      root,
      gate([], advisoryPolicy),
      advisoryPolicy,
      managed,
      'gate',
    );

    expect(result.baseline.written).toBe(false);
    expect(await baselineBytes(root)).toBe(before);

    const resumed = await applyEnforcementBaseline(
      root,
      gate([original], policy),
      policy,
      managed,
      'gate',
    );
    expect(resumed.gate.gated).toBe(false);
    expect(resumed.gate.frozen).toHaveLength(1);
    expect(resumed.gate.frozen[0]).toMatchObject({ baselineState: 'frozen' });
    expect(await baselineBytes(root)).toBe(before);
  });

  it('accepts an unchanged all-code downgrade when checked against trusted bytes', async () => {
    const root = await makeRoot();
    const original = finding('decision:d1', 'retired-a');
    await applyEnforcementBaseline(root, gate([original]), policy, managed, 'bootstrap');
    const trusted = await baselineBytes(root);
    const advisoryPolicy: EnforcementPolicy = { 'stale-decision-reference': 'advisory' };

    const result = await applyEnforcementBaseline(
      root,
      gate([], advisoryPolicy),
      advisoryPolicy,
      managed,
      'gate',
      trusted,
    );

    expect(result.gate.gated).toBe(false);
    expect(result.baseline).toMatchObject({ frozen: 0, new: 0, removed: 0, written: false });
    expect(await baselineBytes(root)).toBe(trusted);
  });

  it('rejects baseline deletion and growth when every trusted code was downgraded', async () => {
    const advisoryPolicy: EnforcementPolicy = { 'stale-decision-reference': 'advisory' };
    for (const candidate of ['deletion', 'growth'] as const) {
      const root = await makeRoot();
      const original = finding('decision:d1', 'retired-a');
      await applyEnforcementBaseline(root, gate([original]), policy, managed, 'bootstrap');
      const trusted = await baselineBytes(root);
      const path = join(root, ENFORCEMENT_BASELINE_REL_PATH);
      if (candidate === 'deletion') {
        await writeFile(path, '# OpenLore frozen enforcement baseline v1\n', 'utf8');
      } else {
        await writeFile(
          path,
          trusted.trimEnd() + '\n' + JSON.stringify(enforcementFindingIdentity(finding('decision:d2', 'retired-b'))) + '\n',
          'utf8',
        );
      }
      const before = await baselineBytes(root);

      const result = await applyEnforcementBaseline(
        root,
        gate([], advisoryPolicy),
        advisoryPolicy,
        managed,
        'gate',
        trusted,
      );

      expect(result.gate.gated).toBe(true);
      expect(result.gate.frozen).toEqual([]);
      expect(result.baseline).toMatchObject({ frozen: 0, integrityError: true, written: false });
      expect(result.baseline.caveat).toMatch(/unassessed or non-frozen code/i);
      expect(await baselineBytes(root)).toBe(before);
    }
  });

  it('pins the deterministic human-readable v1 snapshot', async () => {
    const root = await makeRoot();
    await applyEnforcementBaseline(
      root,
      gate([finding('memory:z', 'retired-z'), finding('memory:a', 'retired-a')]),
      policy,
      managed,
      'bootstrap',
    );

    expect(await baselineBytes(root)).toBe(
      '# OpenLore frozen enforcement baseline v1\n' +
      '["code","stale-decision-reference"]\n' +
      '["finding","stale-decision-reference","memory:a","retired-a"]\n' +
      '["finding","stale-decision-reference","memory:z","retired-z"]\n',
    );
  });

  it('reports 312 frozen and exactly 2 new findings as disjoint partitions', async () => {
    const root = await makeRoot();
    const existing = Array.from({ length: 312 }, (_, index) => finding(`memory:${index}`, `retired-${index}`));
    await applyEnforcementBaseline(root, gate(existing), policy, managed, 'bootstrap');
    const added = [finding('memory:new-a', 'retired-new-a'), finding('memory:new-b', 'retired-new-b')];

    const result = await applyEnforcementBaseline(root, gate([...existing, ...added]), policy, managed, 'gate');

    expect(result.baseline).toMatchObject({ frozen: 312, new: 2 });
    expect(result.gate.frozen).toHaveLength(312);
    expect(result.gate.blocking).toHaveLength(2);
    expect(result.gate.frozen.every((item) => item.baselineState === 'frozen')).toBe(true);
    expect(result.gate.blocking.every((item) => item.baselineState === 'new')).toBe(true);
  });

  it('fails closed on a malformed baseline and never overwrites its bytes', async () => {
    const root = await makeRoot();
    const path = join(root, ENFORCEMENT_BASELINE_REL_PATH);
    const malformed = '# OpenLore frozen enforcement baseline v1\nnot-json\n';
    await writeFile(path, malformed, 'utf8');

    const result = await applyEnforcementBaseline(
      root,
      gate([finding('memory:m1', 'retired-a')]),
      policy,
      managed,
      'gate',
    );

    expect(result.gate.gated).toBe(true);
    expect(result.baseline).toMatchObject({ frozen: 0, integrityError: true, written: false });
    expect(result.gate.frozen).toEqual([]);
    expect(result.gate.classified).toHaveLength(1);
    expect(result.baseline.caveat).toMatch(/invalid JSON/i);
    expect(await baselineBytes(root)).toBe(malformed);
  });

  it('does not ratchet a code whose source was not assessed by this run', async () => {
    const root = await makeRoot();
    const original = finding('memory:m1', 'retired-a');
    await applyEnforcementBaseline(root, gate([original]), policy, managed, 'bootstrap');
    const before = await baselineBytes(root);

    const result = await applyEnforcementBaseline(root, gate([]), policy, new Set(), 'gate');

    expect(result.baseline).toMatchObject({ removed: 0, written: false });
    expect(await baselineBytes(root)).toBe(before);
  });

  it('preserves trusted records byte-for-byte for unassessed and downgraded codes', async () => {
    const secondCode = 'orphans-anchored-memory';
    const bothPolicy: EnforcementPolicy = {
      'stale-decision-reference': 'frozen',
      [secondCode]: 'frozen',
    };
    const bothManaged = new Set(Object.keys(bothPolicy));
    const first = finding('memory:m1', 'retired-a');
    const second: GovernanceFinding = {
      code: secondCode,
      severity: 'error',
      source: 'blast-radius',
      subject: 'src/removed.ts',
      discriminator: 'memory-1',
      message: 'orphaned memory',
    };

    for (const selectedPolicy of [
      bothPolicy,
      { ...bothPolicy, [secondCode]: 'advisory' as const },
    ]) {
      const root = await makeRoot();
      await applyEnforcementBaseline(root, gate([first, second], bothPolicy), bothPolicy, bothManaged, 'bootstrap');
      const trusted = await baselineBytes(root);
      await writeFile(
        join(root, ENFORCEMENT_BASELINE_REL_PATH),
        trusted.split('\n').filter((line) => !line.includes('src/removed.ts')).join('\n'),
        'utf8',
      );

      const result = await applyEnforcementBaseline(
        root,
        gate([first], selectedPolicy),
        selectedPolicy,
        managed,
        'gate',
        trusted,
      );

      expect(result.gate.gated).toBe(true);
      expect(result.gate.frozen).toEqual([]);
      expect(result.baseline).toMatchObject({ frozen: 0, integrityError: true, written: false });
      expect(result.baseline.caveat).toMatch(/unassessed or non-frozen code/i);
    }
  });

  it('reports read-only removals without changing the baseline', async () => {
    const root = await makeRoot();
    const original = finding('memory:m1', 'retired-a');
    await applyEnforcementBaseline(root, gate([original]), policy, managed, 'bootstrap');
    const before = await baselineBytes(root);

    const result = await applyEnforcementBaseline(root, gate([]), policy, managed, 'read-only', before);

    expect(result.gate.gated).toBe(false);
    expect(result.baseline).toMatchObject({ frozen: 0, new: 0, removed: 1, written: false });
    expect(await baselineBytes(root)).toBe(before);
  });

  it('uses the source discriminator to distinguish findings with the same code and subject', async () => {
    const root = await makeRoot();
    const first = finding('spec:auth', 'retired-a');
    const second = finding('spec:auth', 'retired-b');
    expect(enforcementFindingIdentity(first)).not.toEqual(enforcementFindingIdentity(second));
    await applyEnforcementBaseline(root, gate([first]), policy, managed, 'bootstrap');

    const result = await applyEnforcementBaseline(root, gate([first, second]), policy, managed, 'gate');

    expect(result.gate.blocking).toHaveLength(1);
    expect(result.gate.blocking[0]).toMatchObject({
      discriminator: 'retired-b',
      baselineState: 'new',
    });
  });

  it('collapses exact duplicate identities for baseline counts', async () => {
    const root = await makeRoot();
    const duplicate = finding('spec:auth');
    const initialized = await applyEnforcementBaseline(root, gate([duplicate, { ...duplicate }]), policy, managed, 'bootstrap');
    expect(initialized.gate.gated).toBe(false);
    expect(initialized.baseline).toMatchObject({ frozen: 1, new: 0 });

    const rootWithEmptyBaseline = await makeRoot();
    await applyEnforcementBaseline(rootWithEmptyBaseline, gate([]), policy, managed, 'bootstrap');
    const newDuplicates = await applyEnforcementBaseline(
      rootWithEmptyBaseline,
      gate([duplicate, { ...duplicate }]),
      policy,
      managed,
      'gate',
    );
    expect(newDuplicates.baseline.new).toBe(1);
  });

  it('fails closed when semantically distinct emissions collide without a discriminator', async () => {
    for (const conflict of [
      { ...finding('spec:auth'), message: 'a different violation' },
      { ...finding('spec:auth'), source: 'another-source' },
    ]) {
      const root = await makeRoot();
      const result = await applyEnforcementBaseline(
        root,
        gate([finding('spec:auth'), conflict]),
        policy,
        managed,
        'bootstrap',
      );
      expect(result.gate.gated).toBe(true);
      expect(result.baseline).toMatchObject({ integrityError: true, written: false });
      expect(result.baseline.caveat).toMatch(/identity collision.*stable discriminator/i);
      await expect(readFile(join(root, ENFORCEMENT_BASELINE_REL_PATH), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('serializes hostile subjects as deterministic escaped JSONL records', async () => {
    const firstRoot = await makeRoot('openlore-enforcement-baseline-a-');
    const secondRoot = await makeRoot('openlore-enforcement-baseline-b-');
    const hostile = finding('spec:\n"quoted"\tseparator\\tail', 'retired-\n-id');
    const ordinary = finding('memory:z', 'retired-z');

    await applyEnforcementBaseline(firstRoot, gate([hostile, ordinary]), policy, managed, 'bootstrap');
    await applyEnforcementBaseline(secondRoot, gate([ordinary, hostile]), policy, managed, 'bootstrap');

    const first = await baselineBytes(firstRoot);
    const second = await baselineBytes(secondRoot);
    expect(first).toBe(second);
    expect(first).toContain('spec:\\n\\"quoted\\"\\tseparator\\\\tail');
    const records = first.split('\n').filter((line) => line && !line.startsWith('#'));
    expect(records.every((line) => Array.isArray(JSON.parse(line)))).toBe(true);
  });

  it('escapes bidi and non-ASCII code units so a VCS diff cannot be visually reordered', async () => {
    const root = await makeRoot();
    await applyEnforcementBaseline(root, gate([finding('safe\u202ereversed-é', 'retired-✓')]), policy, managed, 'bootstrap');
    const bytes = await baselineBytes(root);
    expect(bytes).toContain('safe\\u202ereversed-\\u00e9');
    expect(bytes).toContain('retired-\\u2713');
    expect(bytes).not.toContain('\u202e');
    expect(bytes).not.toContain('é');
  });

  it('requires the recognized v1 header and preserves unknown-version bytes', async () => {
    const root = await makeRoot();
    const path = join(root, ENFORCEMENT_BASELINE_REL_PATH);
    for (const malformed of [
      '["code","stale-decision-reference"]\n',
      '# OpenLore frozen enforcement baseline v2\n["code","stale-decision-reference"]\n',
    ]) {
      await writeFile(path, malformed, 'utf8');
      const result = await applyEnforcementBaseline(root, gate([]), policy, managed, 'gate');
      expect(result.gate.gated).toBe(true);
      expect(result.baseline.caveat).toMatch(/header/i);
      expect(await baselineBytes(root)).toBe(malformed);
    }
  });

  it('rejects markerless finding records in bootstrap, gate, and read-only modes', async () => {
    const root = await makeRoot();
    const path = join(root, ENFORCEMENT_BASELINE_REL_PATH);
    const markerless = '# OpenLore frozen enforcement baseline v1\n' +
      '["finding","stale-decision-reference","decision:d1","retired-a"]\n';
    for (const mode of ['bootstrap', 'gate', 'read-only'] as const) {
      await writeFile(path, markerless, 'utf8');
      const result = await applyEnforcementBaseline(root, gate([finding('decision:d1', 'retired-a')]), policy, managed, mode);
      expect(result.gate.gated).toBe(true);
      expect(result.baseline).toMatchObject({ integrityError: true, written: false });
      expect(result.baseline.caveat).toMatch(/no initialized code marker/i);
      expect(await baselineBytes(root)).toBe(markerless);
    }
  });

  it('adds a surgical gitignore exception so only the baseline is trackable', async () => {
    const root = await makeRoot();
    await writeFile(join(root, '.gitignore'), '.openlore/\n', 'utf8');
    await execFileAsync('git', ['init', '-q'], { cwd: root });

    await applyEnforcementBaseline(root, gate([]), policy, managed, 'bootstrap');

    const { stdout } = await execFileAsync('git', ['status', '--short', '--untracked-files=all'], { cwd: root });
    expect(stdout).toContain('?? .openlore/enforcement-baseline.jsonl');
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toContain('!.openlore/config.json');
    expect(stdout).not.toContain('.openlore/.enforcement-baseline.jsonl.lock');
    expect(stdout).not.toContain('.openlore/analysis/');
  });

  it('fails closed on a malformed or duplicated managed gitignore block', async () => {
    for (const content of [
      '# openlore-enforcement-baseline\n',
      '# openlore-enforcement-baseline\n!.openlore/\n# end-openlore-enforcement-baseline\n',
      '# openlore-enforcement-baseline\n!.openlore/\n.openlore/*\n!.openlore/config.json\n!.openlore/enforcement-baseline.jsonl\n# end-openlore-enforcement-baseline\n# openlore-enforcement-baseline\n',
    ]) {
      const root = await makeRoot();
      await writeFile(join(root, '.gitignore'), content, 'utf8');
      const result = await applyEnforcementBaseline(root, gate([]), policy, managed, 'bootstrap');
      expect(result.gate.gated).toBe(true);
      expect(result.baseline).toMatchObject({ integrityError: true, written: false });
      expect(result.baseline.caveat).toMatch(/gitignore.*malformed|malformed.*gitignore/i);
      expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe(content);
    }
  });

  it('fails closed when a nested gitignore overrides managed trackability exceptions', async () => {
    const root = await makeRoot();
    await execFileAsync('git', ['init', '-q'], { cwd: root });
    await writeFile(
      join(root, OPENLORE_DIR, '.gitignore'),
      'config.json\nenforcement-baseline.jsonl\n',
      'utf8',
    );

    const result = await applyEnforcementBaseline(root, gate([]), policy, managed, 'bootstrap');

    expect(result.gate.gated).toBe(true);
    expect(result.gate.frozen).toEqual([]);
    expect(result.baseline).toMatchObject({ frozen: 0, integrityError: true, written: false });
    expect(result.baseline.caveat).toMatch(/remains ignored.*higher-precedence/i);
    await expect(readFile(join(root, ENFORCEMENT_BASELINE_REL_PATH), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a symlinked gitignore without modifying its target', async () => {
    if (process.platform === 'win32') return;
    const root = await makeRoot();
    const outside = join(root, 'outside.gitignore');
    const original = 'outside-content\n';
    await writeFile(outside, original, 'utf8');
    await symlink(outside, join(root, '.gitignore'));
    const result = await applyEnforcementBaseline(root, gate([]), policy, managed, 'bootstrap');
    expect(result.gate.gated).toBe(true);
    expect(result.baseline).toMatchObject({ integrityError: true, written: false });
    expect(result.baseline.caveat).toMatch(/trackable/i);
    expect(await readFile(outside, 'utf8')).toBe(original);
  });

  it('repairs trackability during bootstrap even when baseline bytes are unchanged', async () => {
    const root = await makeRoot();
    await applyEnforcementBaseline(root, gate([]), policy, managed, 'bootstrap');
    const before = await baselineBytes(root);
    await writeFile(join(root, '.gitignore'), '.openlore/\n', 'utf8');
    const result = await applyEnforcementBaseline(root, gate([]), policy, managed, 'bootstrap');
    expect(result.baseline.written).toBe(false);
    expect(await baselineBytes(root)).toBe(before);
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toContain('!.openlore/enforcement-baseline.jsonl');
  });

  it('rejects input and generated output beyond the shared byte ceiling without replacing bytes', async () => {
    const root = await makeRoot();
    const path = join(root, ENFORCEMENT_BASELINE_REL_PATH);
    const oversized = '# OpenLore frozen enforcement baseline v1\n' + ' '.repeat(1_048_576);
    await writeFile(path, oversized, 'utf8');
    const readResult = await applyEnforcementBaseline(root, gate([]), policy, managed, 'gate');
    expect(readResult.gate.gated).toBe(true);
    expect(readResult.baseline.caveat).toMatch(/safety limit/i);
    expect(await baselineBytes(root)).toBe(oversized);

    await rm(path);
    const huge = finding('x'.repeat(1_048_576), 'retired-a');
    const writeResult = await applyEnforcementBaseline(root, gate([huge]), policy, managed, 'bootstrap');
    expect(writeResult.gate.gated).toBe(true);
    expect(writeResult.baseline.caveat).toMatch(/output exceeds/i);
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a symlinked baseline without reading through it', async () => {
    if (process.platform === 'win32') return;
    const root = await makeRoot();
    const outside = join(root, 'outside.jsonl');
    await writeFile(outside, '# OpenLore frozen enforcement baseline v1\n', 'utf8');
    await symlink(outside, join(root, ENFORCEMENT_BASELINE_REL_PATH));
    const result = await applyEnforcementBaseline(root, gate([]), policy, managed, 'gate');
    expect(result.gate.gated).toBe(true);
    expect(result.baseline.caveat).toMatch(/symbolic link|too many levels/i);
  });

  it('returns a fail-closed integrity receipt when the baseline directory is not a directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openlore-enforcement-baseline-lock-failure-'));
    created.push(root);
    await writeFile(join(root, OPENLORE_DIR), 'not a directory', 'utf8');
    const result = await applyEnforcementBaseline(root, gate([]), policy, managed, 'bootstrap');
    expect(result.gate.gated).toBe(true);
    expect(result.baseline).toMatchObject({ integrityError: true, written: false });
    expect(result.baseline.caveat).toMatch(/path unavailable.*not a directory/i);
  });

  it.skipIf(process.platform === 'win32')('detects an ancestor swap while acquiring the lock before reading or writing', async () => {
    const root = await makeRoot();
    const outside = await mkdtemp(join(tmpdir(), 'openlore-enforcement-baseline-swap-target-'));
    created.push(outside);
    const original = join(root, '.openlore-original');
    lockInterception.afterAcquire = async () => {
      await rename(join(root, OPENLORE_DIR), original);
      await symlink(outside, join(root, OPENLORE_DIR), 'dir');
    };

    const result = await applyEnforcementBaseline(root, gate([]), policy, managed, 'bootstrap');

    expect(result.gate.gated).toBe(true);
    expect(result.gate.frozen).toEqual([]);
    expect(result.baseline).toMatchObject({ frozen: 0, integrityError: true, written: false });
    expect(result.baseline.caveat).toMatch(/path changed.*symbolic link/i);
    await expect(readFile(join(outside, 'enforcement-baseline.jsonl'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects growth and initialized-marker removal relative to a trusted baseline while allowing shrink', async () => {
    const root = await makeRoot();
    const existing = finding('memory:m1', 'retired-a');
    await applyEnforcementBaseline(root, gate([existing]), policy, managed, 'bootstrap');
    const trusted = await baselineBytes(root);

    const added = finding('memory:m2', 'retired-b');
    await writeFile(
      join(root, ENFORCEMENT_BASELINE_REL_PATH),
      trusted.trimEnd() + '\n' + JSON.stringify(enforcementFindingIdentity(added)) + '\n',
      'utf8',
    );
    const growth = await applyEnforcementBaseline(root, gate([existing, added]), policy, managed, 'gate', trusted);
    expect(growth.gate.gated).toBe(true);
    expect(growth.baseline.caveat).toMatch(/grew/i);

    await writeFile(
      join(root, ENFORCEMENT_BASELINE_REL_PATH),
      '# OpenLore frozen enforcement baseline v1\n' + JSON.stringify(enforcementFindingIdentity(existing)) + '\n',
      'utf8',
    );
    const markerRemoval = await applyEnforcementBaseline(root, gate([existing]), policy, managed, 'gate', trusted);
    expect(markerRemoval.gate.gated).toBe(true);
    expect(markerRemoval.baseline.caveat).toMatch(/marker removed|no initialized code marker/i);

    await writeFile(
      join(root, ENFORCEMENT_BASELINE_REL_PATH),
      '# OpenLore frozen enforcement baseline v1\n["code","stale-decision-reference"]\n',
      'utf8',
    );
    const shrink = await applyEnforcementBaseline(root, gate([]), policy, managed, 'gate', trusted);
    expect(shrink.baseline.caveat).toBeUndefined();
    expect(shrink.gate.gated).toBe(false);
  });

  it('allows bootstrap records for a genuinely new code absent from the trusted baseline', async () => {
    const root = await makeRoot();
    const trusted = '# OpenLore frozen enforcement baseline v1\n';
    const current = finding('memory:m1', 'retired-a');
    const result = await applyEnforcementBaseline(root, gate([current]), policy, managed, 'bootstrap', trusted);
    expect(result.gate.gated).toBe(false);
    expect(result.baseline.initialized).toEqual(['stale-decision-reference']);
    expect(await baselineBytes(root)).toContain(JSON.stringify(enforcementFindingIdentity(current)));
  });

  it.skipIf(process.platform === 'win32')('refuses a symlinked .openlore directory without writing through it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openlore-enforcement-baseline-symlink-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'openlore-enforcement-baseline-symlink-target-'));
    created.push(root, outside);
    await symlink(outside, join(root, OPENLORE_DIR), 'dir');

    const result = await applyEnforcementBaseline(
      root,
      gate([finding('memory:m1', 'retired-a')]),
      policy,
      managed,
      'bootstrap',
    );

    expect(result.gate.gated).toBe(true);
    expect(result.baseline).toMatchObject({ integrityError: true, written: false });
    expect(result.baseline.caveat).toMatch(/symbolic link/i);
    await expect(readFile(join(outside, 'enforcement-baseline.jsonl'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
