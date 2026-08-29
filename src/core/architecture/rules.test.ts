import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadArchitectureRules, parseArchitectureRules, parseInvariantMarkers, rulesAreInert } from './rules.js';

describe('parseArchitectureRules', () => {
  it('parses layers, forbidden, and allowedOnly', () => {
    const { rules, warnings } = parseArchitectureRules(
      {
        layers: { cli: ['src/cli'], core: ['src/core'], utils: ['src/utils'] },
        forbidden: [{ from: 'src/core', to: 'src/cli', reason: 'core stays UI-agnostic' }],
        allowedOnly: [{ module: 'src/api', mayDependOn: ['src/core', 'src/types'] }],
      },
      'config',
    );
    expect(warnings).toEqual([]);
    expect(rules).toHaveLength(3);
    const layers = rules.find(r => r.kind === 'layers');
    expect(layers).toBeTruthy();
    const forbidden = rules.find(r => r.kind === 'forbidden');
    expect(forbidden).toMatchObject({ from: 'src/core', to: 'src/cli', reason: 'core stays UI-agnostic', source: 'config' });
  });

  it('warns and skips malformed entries — never throws', () => {
    const { rules, warnings } = parseArchitectureRules(
      {
        layers: { onlyOne: ['src/x'] }, // <2 layers → no direction
        forbidden: [{ from: 'src/core' }, { from: 'a', to: 'b' }], // first missing "to"
        allowedOnly: [{ module: 'src/api', mayDependOn: 'not-an-array' }],
      },
      'config',
    );
    // Only the valid forbidden rule survives.
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ kind: 'forbidden', from: 'a', to: 'b' });
    expect(warnings.length).toBeGreaterThanOrEqual(3);
  });

  it('returns a warning (not a throw) on non-object input', () => {
    expect(() => parseArchitectureRules(null, 'config')).not.toThrow();
    expect(parseArchitectureRules(42, 'config').warnings).toHaveLength(1);
  });

  it('preserves prototype-named layers as own data without prototype pollution', () => {
    const { rules, warnings } = parseArchitectureRules(
      JSON.parse('{"layers":{"__proto__":["src/a"],"constructor":["src/b"],"prototype":["src/c"]}}'),
      'config',
    );

    expect(warnings).toEqual([]);
    expect(rules).toHaveLength(1);
    const rule = rules[0];
    expect(rule.kind).toBe('layers');
    if (rule.kind !== 'layers') throw new Error('expected layers rule');
    expect(Object.keys(rule.layers)).toEqual(['__proto__', 'constructor', 'prototype']);
    expect(Object.hasOwn(rule.layers, '__proto__')).toBe(true);
    expect(rule.layers.__proto__).toEqual(['src/a']);
    expect(Object.getPrototypeOf(rule.layers)).toBe(Object.prototype);
    expect(Object.prototype).not.toHaveProperty('0', 'src/a');
  });

  it('rulesAreInert reflects an empty rule set', () => {
    expect(rulesAreInert({ rules: [], warnings: [] })).toBe(true);
    expect(rulesAreInert(parseArchitectureRules({ forbidden: [{ from: 'a', to: 'b' }] }, 'config'))).toBe(false);
  });
});

describe('parseInvariantMarkers', () => {
  it('parses forbidden and allowedOnly markers from ADR text', () => {
    const text = [
      '# ADR 0001',
      'Some prose.',
      '- Invariant: forbidden src/core -> src/cli (core stays UI-agnostic)',
      '> Invariant: allowedOnly src/api -> src/core, src/types',
      'Invariant: nonsense that does not parse',
    ].join('\n');
    const rules = parseInvariantMarkers(text);
    expect(rules).toHaveLength(2);
    expect(rules[0]).toMatchObject({ kind: 'forbidden', from: 'src/core', to: 'src/cli', reason: 'core stays UI-agnostic', source: 'decision' });
    expect(rules[1]).toMatchObject({ kind: 'allowedOnly', module: 'src/api', mayDependOn: ['src/core', 'src/types'], source: 'decision' });
  });

  it('returns nothing when there are no markers', () => {
    expect(parseInvariantMarkers('no markers here\njust text')).toEqual([]);
  });

  it('preserves statusless legacy ADR rules while retiring explicitly rejected ones', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openlore-legacy-invariant-'));
    const decisions = join(root, 'openspec', 'decisions');
    await mkdir(decisions, { recursive: true });
    await writeFile(join(decisions, 'adr-0001-legacy.md'), [
      '# ADR-0001: Legacy', '', '> Decision ID: aaaaaaaa',
      'Invariant: forbidden src/a -> src/b', '',
    ].join('\n'));
    await writeFile(join(decisions, 'adr-0002-rejected.md'), [
      '# ADR-0002: Rejected', '', '## Status', '', 'rejected', '',
      '> Decision ID: bbbbbbbb', 'Invariant: forbidden src/c -> src/d', '',
    ].join('\n'));

    const loaded = await loadArchitectureRules(root);

    expect(loaded.rules.map((rule) => rule.ruleId)).toEqual(['legacy-1']);
    expect(loaded.warnings.join(' ')).toMatch(/retired.*rejected/i);
  });

  it('does not follow an individual ADR symlink outside the repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openlore-legacy-symlink-'));
    const outside = await mkdtemp(join(tmpdir(), 'openlore-legacy-outside-'));
    const decisions = join(root, 'openspec', 'decisions');
    await mkdir(decisions, { recursive: true });
    const target = join(outside, 'outside.md');
    await writeFile(target, [
      '# ADR-0001: Outside', '', '## Status', '', 'accepted', '',
      '> Decision ID: aaaaaaaa', 'Invariant: forbidden src/a -> src/b', '',
    ].join('\n'));
    await symlink(target, join(decisions, 'adr-0001-outside.md'));

    const loaded = await loadArchitectureRules(root);

    expect(loaded.rules).toEqual([]);
    expect(loaded.warnings).toContain('could not read decision file adr-0001-outside.md');
  });
});
