/**
 * Conclusion-honesty parity guard (change: fix-cli-conclusion-honesty).
 *
 * The honesty disciplines — resolve-or-disclose a `--base` ref, disclose index
 * staleness on a cached-graph conclusion — are only worth anything if EVERY command
 * applies them. The v2.1.5 audit found the opposite: some commands disclosed, their
 * siblings silently answered over the same defect. This test is the CLAUDE.md
 * MCP↔CLI parity doctrine applied inside the CLI: it enumerates every command taking
 * `--base` (or reading the cached graph) and fails when one drops off the shared path.
 *
 * It is a SOURCE-level guard on purpose: a new `--base` command that forgets the
 * helper fails here, at authoring time, instead of shipping a silent fallback.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const COMMANDS_DIR = join(process.cwd(), 'src', 'cli', 'commands');
const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf-8');

/**
 * Every `--base` command and HOW it satisfies the resolve-or-disclose contract:
 *  - `handler`: the command resolves the base itself, in this handler, which MUST
 *    reference the one shared helper `resolveBaseRefDisclosed`.
 *  - `delegatesTo`: the command does not resolve a base itself; it forwards the ref
 *    to a composed handler that does (so the disclosure flows up transitively).
 *
 * A NEW `--base` command that is not registered here fails `enumerates every --base
 * command` below — forcing its author to declare, and wire, its compliance.
 */
const BASE_REF_COMMANDS: Record<string, { handler: string } | { delegatesTo: string[] }> = {
  'certify-public-surface': { handler: 'src/core/services/mcp-handlers/public-surface.ts' },
  'impact-certificate': { handler: 'src/core/services/mcp-handlers/impact-certificate.ts' },
  'blast-radius': { handler: 'src/core/services/mcp-handlers/blast-radius.ts' },
  'briefing-since': { handler: 'src/core/services/mcp-handlers/briefing-since.ts' },
  'coverage-gaps': { handler: 'src/core/services/mcp-handlers/coverage-gaps.ts' },
  'review-corpus': { handler: 'src/cli/commands/review-corpus.ts' },
  // enforce + review are composers: they forward `--base` to computeBlastRadius /
  // computeImpactCertificate, which resolve-or-disclose through the shared helper.
  enforce: { delegatesTo: ['src/core/services/mcp-handlers/blast-radius.ts'] },
  review: { delegatesTo: ['src/core/services/mcp-handlers/blast-radius.ts'] },
};

/**
 * Cached-graph conclusion commands that must disclose index staleness through the one
 * shared boundary shape (`computeStaleness` + `assembleBoundary`). certify-public-surface
 * already emitted it pre-change; blast-radius and briefing-since adopted it here.
 */
const STALENESS_HANDLERS: Record<string, string> = {
  'blast-radius': 'src/core/services/mcp-handlers/blast-radius.ts',
  'briefing-since': 'src/core/services/mcp-handlers/briefing-since.ts',
  'certify-public-surface': 'src/core/services/mcp-handlers/public-surface.ts',
  'coverage-gaps': 'src/core/services/mcp-handlers/coverage-gaps.ts',
};

/** Command files that declare a `--base <ref>` option. */
function commandsDeclaringBase(): string[] {
  return readdirSync(COMMANDS_DIR)
    .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .filter(f => /\.option\('--base/.test(readFileSync(join(COMMANDS_DIR, f), 'utf-8')))
    .map(f => f.replace(/\.ts$/, ''));
}

describe('conclusion-honesty parity: base-ref resolution', () => {
  it('enumerates every --base command (a new one must register its compliance)', () => {
    const declared = commandsDeclaringBase().sort();
    const registered = Object.keys(BASE_REF_COMMANDS).sort();
    expect(declared).toEqual(registered);
  });

  it('every direct-resolving --base handler routes through the shared resolveBaseRefDisclosed helper', () => {
    for (const [cmd, how] of Object.entries(BASE_REF_COMMANDS)) {
      if (!('handler' in how)) continue;
      const src = read(how.handler);
      expect(src, `${cmd} (${how.handler}) must call resolveBaseRefDisclosed`).toMatch(/resolveBaseRefDisclosed/);
    }
  });

  it('every delegating --base command forwards to a helper-compliant handler', () => {
    for (const [cmd, how] of Object.entries(BASE_REF_COMMANDS)) {
      if (!('delegatesTo' in how)) continue;
      for (const delegate of how.delegatesTo) {
        expect(read(delegate), `${cmd} delegates to ${delegate}, which must call resolveBaseRefDisclosed`).toMatch(/resolveBaseRefDisclosed/);
      }
    }
  });
});

describe('conclusion-honesty parity: index-staleness disclosure', () => {
  it('every cached-graph conclusion handler discloses staleness via the shared boundary shape', () => {
    for (const [cmd, handler] of Object.entries(STALENESS_HANDLERS)) {
      const src = read(handler);
      expect(src, `${cmd} (${handler}) must compute staleness`).toMatch(/computeStaleness/);
      expect(src, `${cmd} (${handler}) must assemble the confidence boundary`).toMatch(/assembleBoundary/);
    }
  });
});
