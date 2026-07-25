/**
 * Spec-corpus integrity lint (change: restore-spec-corpus-integrity).
 *
 * OpenLore *sells* spec/code drift detection — its own committed spec corpus must survive its own
 * discipline. The corpus is loaded into agent context (`get_spec`, `search_specs`, and CLAUDE.md's
 * `@openspec/specs/overview/spec.md` include), so a phantom requirement mandating behavior that does
 * not exist is the exact confident-but-wrong failure the epistemic lease exists to prevent —
 * self-inflicted. This guard makes four corpus-corruption classes fail the build, per the
 * `openspec` domain requirement `SpecCorpusContainsOnlyCodeBackedRequirements`:
 *
 *   1. The vacuous auto-generated scenario template ("the system is in a valid state" →
 *      "the expected outcome occurs") — a placeholder that describes nothing.
 *   2. Dead intra-corpus links — a link to `../<domain>/spec.md` with no file on disk.
 *   3. Duplicate requirement names within a single domain — two `### Requirement: X` in one spec.
 *   4. A domain-table row in `overview` whose linked spec file does not exist on disk.
 *   5. A `### Requirement:` header outside the domain's `## Requirements` section — the defect that
 *      silently broke `openspec archive` for the WHOLE corpus (change: fix-spec-corpus-archivability).
 *
 * It also guards the decision-sync scoping repaired in this change (and enforced going forward by
 * the syncer fix in `delegate-lifecycle-scope-decision-sync`): a decision-synced requirement (one
 * carrying a `> Decision recorded: <id>` marker) must have its full copy in exactly ONE domain;
 * other domains carry a one-line pointer instead of forking the text.
 *
 * Scope: the committed spec corpus only (`openspec/specs/<domain>/spec.md`). PROPOSED deltas under
 * `openspec/changes/**` are explicitly out of scope — they describe behavior that does not exist
 * yet, by design.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

// src/<this> → repo root is one level up.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SPECS_DIR = join(REPO_ROOT, 'openspec', 'specs');

/** The domains committed on disk (a directory with a spec.md). */
function specDomains(): string[] {
  return readdirSync(SPECS_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory() && existsSync(join(SPECS_DIR, e.name, 'spec.md')))
    .map(e => e.name)
    .sort();
}

const DOMAINS = specDomains();
const specOf = (domain: string) => readFileSync(join(SPECS_DIR, domain, 'spec.md'), 'utf-8');

/** Split a spec into blocks that each begin with a `### Requirement:` header. */
function requirementNames(text: string): string[] {
  return [...text.matchAll(/^### Requirement: (.+)$/gm)].map(m => m[1].trim());
}

describe('spec-corpus lint: every requirement lives in the Requirements section', () => {
  // openspec parses a main spec's requirements ONLY from inside `## Requirements`. A
  // `### Requirement:` header anywhere else is invisible to validate/list — and, worse, makes
  // the whole spec structurally invalid, so `openspec archive` aborts for EVERY change that
  // touches that domain. The corpus reached 175 such headers across four domains before anyone
  // noticed, because nothing failed loudly: archiving simply stopped working.
  //
  // Sub-component blocks are the legitimate nested form and use `#### Requirement:` under a
  // `### Sub-component:` header; only the level-3 header is constrained here.
  for (const domain of DOMAINS) {
    it(`${domain} has no requirement header outside ## Requirements`, () => {
      const lines = specOf(domain).split('\n');
      let section: string | undefined;
      const strays: string[] = [];
      lines.forEach((line, i) => {
        if (line.startsWith('## ') && !line.startsWith('###')) section = line.slice(3).trim();
        else if (line.startsWith('### Requirement:') && section !== 'Requirements') {
          strays.push(`${domain}/spec.md:${i + 1} in "## ${section}" — ${line.trim()}`);
        }
      });
      expect(strays, `requirement headers outside "## Requirements" (openspec archive aborts on these)`).toEqual([]);
    });
  }
});

describe('spec-corpus lint: no vacuous placeholder scenarios', () => {
  // These two lines are the generated placeholder template. Real scenarios name concrete
  // preconditions and outcomes; the template names neither and must never reach the corpus.
  const VACUOUS_MARKERS = [
    '**GIVEN** the system is in a valid state',
    '**THEN** the expected outcome occurs',
  ];

  for (const domain of DOMAINS) {
    it(`${domain} contains no placeholder-template scenario`, () => {
      const text = specOf(domain);
      const lines = text.split('\n');
      const offenders: string[] = [];
      for (const marker of VACUOUS_MARKERS) {
        lines.forEach((line, i) => {
          if (line.includes(marker)) offenders.push(`${domain}/spec.md:${i + 1}: ${line.trim()}`);
        });
      }
      expect(
        offenders,
        `Placeholder-template scenario found in ${domain}. Rewrite the requirement with a real ` +
          `GIVEN/WHEN/THEN or delete it if its subject has no implementation:\n${offenders.join('\n')}`,
      ).toEqual([]);
    });
  }
});

describe('spec-corpus lint: no duplicate requirement names within a domain', () => {
  for (const domain of DOMAINS) {
    it(`${domain} has unique requirement names`, () => {
      const names = requirementNames(specOf(domain));
      const seen = new Set<string>();
      const dups = new Set<string>();
      for (const n of names) {
        if (seen.has(n)) dups.add(n);
        seen.add(n);
      }
      expect(
        [...dups],
        `Duplicate requirement name(s) in ${domain}/spec.md — disambiguate or merge:\n` +
          [...dups].join('\n'),
      ).toEqual([]);
    });
  }
});

describe('spec-corpus lint: no dead intra-corpus links', () => {
  for (const domain of DOMAINS) {
    it(`${domain} has no link to a missing spec file`, () => {
      const dir = join(SPECS_DIR, domain);
      const text = specOf(domain);
      const dead: string[] = [];
      // Markdown links whose target is a relative path to a .md file inside the corpus.
      for (const m of text.matchAll(/\]\(([^)]+\.md)\)/g)) {
        const target = m[1];
        if (/^https?:\/\//.test(target)) continue; // external URL
        const resolved = resolve(dir, target);
        // Only enforce links that point inside openspec/ (skip links out to src docs, etc.).
        if (!resolved.startsWith(join(REPO_ROOT, 'openspec') + '/')) continue;
        if (!existsSync(resolved)) dead.push(`${target} → ${resolved}`);
      }
      expect(
        dead,
        `Dead intra-corpus link(s) in ${domain}/spec.md — the target spec does not exist:\n${dead.join('\n')}`,
      ).toEqual([]);
    });
  }
});

describe('spec-corpus lint: the overview domain table is honest', () => {
  it('every domain-table row links to a spec file that exists', () => {
    const text = specOf('overview');
    // Rows look like: | Analyzer | ... | [spec.md](../analyzer/spec.md) |
    const rows = [...text.matchAll(/\]\((\.\.\/[^)]+\/spec\.md)\)/g)].map(m => m[1]);
    expect(rows.length, 'expected the overview to link its domains').toBeGreaterThan(0);
    const dir = join(SPECS_DIR, 'overview');
    const dead = rows.filter(r => !existsSync(resolve(dir, r)));
    expect(
      dead,
      `overview/spec.md domain table links a spec file that does not exist on disk:\n${dead.join('\n')}`,
    ).toEqual([]);
  });

  it('does not link the phantom domains this change removed', () => {
    const text = specOf('overview');
    for (const gone of ['auth', 'task', 'validator', 'services', 'types', 'import', 'chat', 'utilities', 'app']) {
      expect(
        text.includes(`../${gone}/spec.md`),
        `overview still links the removed/phantom domain "${gone}"`,
      ).toBe(false);
    }
  });
});

describe('spec-corpus lint: a synced decision requirement lives in exactly one domain', () => {
  it('no decision-synced requirement (by name) is forked across domains', () => {
    // The syncer's fork signature is the SAME requirement — identical `### Requirement: <name>`
    // carrying a `> Decision recorded:` marker — appearing in more than one domain. A distinct
    // requirement that merely CITES the same decision id under a DIFFERENT name is legitimate and
    // must not be flagged, so we key on the requirement name, not the decision id.
    const MARK = /^> Decision recorded: [0-9a-f]{8}$/m;
    const domainsByName = new Map<string, Set<string>>();
    for (const domain of DOMAINS) {
      const blocks = specOf(domain).split(/(?=^### Requirement: )/m);
      for (const b of blocks) {
        const nameM = /^### Requirement: (.+)$/m.exec(b);
        if (nameM && MARK.test(b)) {
          const name = nameM[1].trim();
          if (!domainsByName.has(name)) domainsByName.set(name, new Set());
          domainsByName.get(name)!.add(domain);
        }
      }
    }
    const forked = [...domainsByName.entries()]
      .filter(([, doms]) => doms.size > 1)
      .map(([name, doms]) => `${name}: [${[...doms].sort().join(', ')}]`);
    expect(
      forked,
      `A decision-synced requirement is duplicated verbatim across domains — keep one canonical ` +
        `copy and replace the others with a pointer:\n${forked.join('\n')}`,
    ).toEqual([]);
  });
});
