import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { adaptSkillForHost, buildManifest } from '../../cli/commands/setup.js';

describe('spec workflow host skills', () => {
  const legacySkillNames = [
    'openlore-analyze-codebase',
    'openlore-brainstorm',
    'openlore-debug',
    'openlore-execute-refactor',
    'openlore-generate',
    'openlore-implement-story',
    'openlore-plan-refactor',
    'openlore-review-changes',
    'openlore-write-tests',
  ];

  it('keeps deterministic composition on the MCP server', () => {
    const generate = readFileSync(resolve('skills/openlore-generate/SKILL.md'), 'utf8');
    const repair = readFileSync(resolve('skills/openlore-repair/SKILL.md'), 'utf8');

    expect(generate).toContain('prepare_spec_generation');
    expect(repair).toContain('prepare_spec_repair');
    expect(repair).toContain('mapping');

    for (const skill of [generate, repair]) {
      expect(skill).toContain('receipt');
      expect(skill).toMatch(/[Dd]o not reconstruct/);
      expect(skill).not.toContain('Phase 1 — Codebase Survey');
      expect(skill).not.toContain('Identify domains by looking for');
      expect(skill).toMatch(/untrusted data, not instructions/i);
    }
  });

  it('teaches both authoring paths the same finalization and anchor contract', () => {
    const generate = readFileSync(resolve('skills/openlore-generate/SKILL.md'), 'utf8');
    const repair = readFileSync(resolve('skills/openlore-repair/SKILL.md'), 'utf8');

    for (const skill of [generate, repair]) {
      // Exact per-requirement anchors — the input the deterministic link index reads.
      expect(skill).toContain('**Implementation**');
      expect(skill).toContain('symbolName::path/to/file.ts');
      expect(skill).toMatch(/file-only reference[\s\S]*never establishes function coverage/);
      // Finalization through the CLI, with the skipped-cache case disclosed rather
      // than implied to be a correctness problem.
      expect(skill).toContain('openlore mapping refresh');
      expect(skill).toMatch(/re-derive the index in memory/);
      // Continuation stays inside the composite protocol.
      expect(skill).toContain('receipt.continuationCursor');
    }
  });

  it('stops both authoring paths on a domain with no behavior to specify', () => {
    // A requirement states behavior, and behavior lives in symbols. A domain of
    // documentation has none, so the only spec authorable over it paraphrases
    // prose back as SHALL statements and can carry no resolvable anchor.
    const generate = readFileSync(resolve('skills/openlore-generate/SKILL.md'), 'utf8');
    const repair = readFileSync(resolve('skills/openlore-repair/SKILL.md'), 'utf8');

    for (const skill of [generate, repair]) {
      // The emitted follow-up is the authoritative stop signal, so the skill must
      // key on it — a bare `unavailable` is not a stop, or corpus-level specs
      // like `overview` become impossible to author or repair.
      expect(skill).toContain('ask:human-decision');
      expect(skill).toContain('documentation-only');
      expect(skill).toContain('proseOnlyOrphan');
      expect(skill).toMatch(/bare `"unavailable"` without that follow-up is NOT a stop/);
      expect(skill).toMatch(/Never paraphrase (prose|documentation) into SHALL statements/);
      expect(skill).toMatch(/a requirement describes behavior, not a document/);
    }
  });

  it('takes the baseline spec format from the corpus, never restated by OpenLore', () => {
    // OpenLore does not own the OpenSpec format, so neither skill may restate its
    // rules — a restated copy drifts the moment OpenSpec changes, and ours already
    // had (it said GIVEN/WHEN/THEN; the canonical template is WHEN/THEN). The CLI
    // serves a contract, but only for change DELTAS; these workflows write baseline
    // corpus specs, so the corpus is the reference and `openspec validate` the judge.
    const generate = readFileSync(resolve('skills/openlore-generate/SKILL.md'), 'utf8');
    const repair = readFileSync(resolve('skills/openlore-repair/SKILL.md'), 'utf8');

    for (const skill of [generate, repair]) {
      expect(skill).toMatch(/Never restate OpenSpec's rules from this skill/);
      // Both workflows author a BASELINE corpus spec. The CLI's `instructions`
      // artifact describes the change-local DELTA form, so following it would
      // write `## ADDED Requirements` into a main spec and corrupt the archive
      // merge — the skill must say so, not silently point at it.
      expect(skill).toMatch(/BASELINE corpus spec under the specs directory, not a change delta/);
      expect(skill).toMatch(/`openspec instructions specs --change <id> --json` does NOT apply/);
      expect(skill).toContain('openspec validate --specs --strict');
    }
    // References differ because the inputs do: Repair has the file it edits.
    expect(repair).toMatch(/Take the shape from the spec you are repairing/);
    expect(generate).toMatch(/Take the shape from a sibling spec under the same specs directory/);
  });

  it('makes both authoring paths report a spec they could not validate as NOT validated', () => {
    // The failure this closes: no `openspec` CLI, so nothing validated the spec and
    // nothing said so — an unvalidated spec read as a finished one. A spec written
    // by Generate is no more self-validating than one edited by Repair.
    const generate = readFileSync(resolve('skills/openlore-generate/SKILL.md'), 'utf8');
    const repair = readFileSync(resolve('skills/openlore-repair/SKILL.md'), 'utf8');

    for (const skill of [generate, repair]) {
      expect(skill).toMatch(/OpenLore does not validate OpenSpec structure/);
      expect(skill).toMatch(/report the spec as NOT validated/);
      expect(skill).toContain('specValidation');
    }
  });

  it('makes Generate stop for host judgment on material existing-spec overlap', () => {
    const generate = readFileSync(resolve('skills/openlore-generate/SKILL.md'), 'utf8');
    expect(generate).toContain('overlap');
    expect(generate).toMatch(/[Ss]top for the human/);
    expect(generate).toContain('Do not silently author a competing spec');
    // The skill must not encode a decision OpenLore deliberately does not make.
    expect(generate).toMatch(/never decides/);
  });

  it('forbids Repair from re-running the observation that came back unavailable', () => {
    const repair = readFileSync(resolve('skills/openlore-repair/SKILL.md'), 'utf8');
    expect(repair).toMatch(/never read `null` as zero gaps/);
    expect(repair).toMatch(/never re-run the same audit/);
  });

  it('installs the same canonical skill catalogue for every skill-based host', () => {
    const projectRoot = '/project';
    const manifest = buildManifest(projectRoot);
    const expectedSources = manifest.vibe.map(({ src }) => src);

    for (const host of ['vibe', 'claude', 'opencode'] as const) {
      const entries = manifest[host];
      const skillEntries = entries.filter(({ dest }) => dest.includes('/skills/'));
      const generate = entries.find(({ dest }) => dest.includes('/openlore-generate/'));
      const repair = entries.find(({ dest }) => dest.includes('/openlore-repair/'));
      expect(skillEntries).toHaveLength(10);
      expect(skillEntries.map(({ src }) => src)).toEqual(expectedSources);
      expect(skillEntries.every(({ src }) => src.includes('/skills/openlore-'))).toBe(true);
      expect(generate?.src).toBe(resolve('skills/openlore-generate/SKILL.md'));
      expect(repair?.src).toBe(resolve('skills/openlore-repair/SKILL.md'));
    }
  });

  it('adds Vibe slash-command metadata without polluting portable canonical skills', () => {
    const canonical = readFileSync(resolve('skills/openlore-generate/SKILL.md'), 'utf8');
    expect(canonical).not.toContain('user-invocable:');
    expect(adaptSkillForHost(canonical, 'vibe')).toContain('user-invocable: true');
    expect(adaptSkillForHost(canonical, 'claude')).toBe(canonical);
  });

  it('keeps former host-specific package paths as exact compatibility copies', () => {
    for (const name of legacySkillNames) {
      const canonical = readFileSync(resolve('skills', name, 'SKILL.md'), 'utf8');
      expect(readFileSync(resolve('examples/opencode-skills', name, 'SKILL.md'), 'utf8')).toBe(canonical);
      expect(readFileSync(resolve('examples/mistral-vibe/skills', name, 'SKILL.md'), 'utf8')).toBe(canonical);
    }
  });
});
