import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Onboarding guard: the CLI front door (description + `openlore --help` epilog) must
// describe what OpenLore actually is — persistent architectural memory for coding agents,
// entered via `openlore install` — not the legacy spec-generation framing. A new user's
// first impression and "what do I run first?" both live here, so lock them against drift.
const source = readFileSync(join(import.meta.dirname, 'index.ts'), 'utf8');

describe('CLI onboarding front door', () => {
  it('leads with the agent-context-substrate value, not the legacy spec-gen framing', () => {
    expect(source).toContain('Persistent architectural memory for coding agents');
    expect(source).not.toContain('Reverse-engineer OpenSpec specifications from existing codebases');
  });

  it('steers new users to the one-command `openlore install` first', () => {
    expect(source).toContain('Get started (one command, no API key)');
    expect(source).toMatch(/\$ openlore install/);
  });

  it('does not repeat the stale "test generates tests" claim (test reports coverage)', () => {
    // `openlore test` stopped generating stubs (commit 7f2dd4b); the epilog must not say it does.
    expect(source).not.toMatch(/openlore test\s+Generate spec-driven tests/);
  });

  it('groups the command surface by job in --help (CommandSurfaceGroupedByJob)', () => {
    // The ~49 commands must render grouped by job, not as one flat list, so the
    // front door is legible. Lock the wiring so it cannot be silently dropped.
    expect(source).toContain('applyJobGroupedHelp');
    expect(source).toMatch(/^applyJobGroupedHelp\(program\);$/m);
    // The grouping pass tags each registered subcommand, so it must run after the last
    // addCommand() — otherwise late-registered commands silently fall out of their group.
    expect(source.lastIndexOf('program.addCommand(')).toBeLessThan(
      source.indexOf('applyJobGroupedHelp(program);')
    );
  });

  it('surfaces `openlore features` so opt-in capabilities are discoverable from the front door', () => {
    // ZeroConfigWithGuidedActivation: a user must be able to find "where do I turn on X?"
    // without grepping the docs — the front-door epilog names the features command.
    expect(source).toMatch(/openlore features/);
  });

  it('shows help and exits 0 on a bare `openlore` (no command), not the Commander default', () => {
    // A new user typing just `openlore` to explore should get help on stdout + exit 0,
    // not Commander's default (help on stderr, exit 1).
    expect(source).toMatch(/process\.argv\.length\s*<=\s*2/);
    expect(source).toMatch(/outputHelp\(\)/);
    expect(source).toMatch(/process\.exit\(0\)/);
  });
});
