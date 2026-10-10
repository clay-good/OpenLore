/**
 * Spec-09 — Curated live-data repo manifest.
 *
 * A SMALL, version-pinned set of real OSS repositories spanning the supported
 * tree-sitter languages. The live-data harness fetches each into a gitignored
 * cache (see `repo-cache.ts`), analyzes it, and drives every MCP tool against it.
 *
 * Pinning contract
 * ----------------
 * Each entry is pinned by `url` + a full 40-char commit `sha` for determinism.
 * The cache layer asserts the resolved HEAD equals `sha` after checkout and
 * FAILS LOUDLY on mismatch — a moved tag or rewritten history can never silently
 * change the harness inputs (spec-09 §2).
 *
 * SHA provenance
 * --------------
 * The `sha` values below are the COMMIT each release `tag` points to, resolved via
 * `git ls-remote` (annotated tags peeled to their commit). The cache layer's
 * HEAD-assertion remains the backstop: if a pinned commit ever fails to match, that
 * repo fails loudly (it never passes silently). Bump a `sha` only when bumping its
 * `tag`, and regenerate that repo's overview snapshot.
 *
 * License discipline: only permissive (MIT / Apache-2.0 / BSD) repos. Source is
 * never vendored into OpenLore — it is fetched at run time into the cache.
 */

export interface FixtureRepo {
  /** Stable short id, e.g. "ts-commander". Used as the cache key and report row. */
  id: string;
  /** Git clone URL (https). */
  url: string;
  /** Pinned full 40-char commit SHA (lowercase hex). */
  sha: string;
  /** Release tag the SHA was pinned from (documentation only; not used for fetch). */
  tag: string;
  /** Primary language family this repo exercises. */
  primaryLanguage: string;
  /** SPDX license id — permissive only. */
  license: string;
  /** Optional hints the arg-deriver prefers when present. */
  hints?: { knownFunction?: string; knownFile?: string };
  /** Tool names that MUST return non-trivial data on this repo (silent-empty guard). */
  expectNonEmpty?: string[];
}

/**
 * The curated set. Kept intentionally small (low-thousands of lines each) and
 * shallow-clonable. Covers TS/JS, Python, Go, Rust, C, and Ruby in the first PR;
 * remaining languages are TODO(spec-09-followup) markers below.
 */
export const FIXTURE_REPOS: FixtureRepo[] = [
  {
    id: 'ts-commander',
    url: 'https://github.com/tj/commander.js.git',
    sha: '970ecae402b253de691e6a9066fea22f38fe7431', // commit for tag v12.1.0 (confirmed via git ls-remote)
    tag: 'v12.1.0',
    primaryLanguage: 'typescript',
    license: 'MIT',
    hints: { knownFile: 'lib/command.js' },
    expectNonEmpty: ['orient', 'get_architecture_overview', 'search_code'],
  },
  {
    id: 'py-click',
    url: 'https://github.com/pallets/click.git',
    sha: '874ca2bc1c30d93a4ac6e36a15ed685eafe89097', // commit for tag 8.1.7 (confirmed via git ls-remote)
    tag: '8.1.7',
    primaryLanguage: 'python',
    license: 'BSD-3-Clause',
    hints: { knownFile: 'src/click/core.py' },
    expectNonEmpty: ['orient', 'get_architecture_overview'],
  },
  {
    id: 'go-pkg-errors',
    url: 'https://github.com/pkg/errors.git',
    sha: '614d223910a179a466c1767a985424175c39b465', // commit for tag v0.9.1 (confirmed via git ls-remote)
    tag: 'v0.9.1',
    primaryLanguage: 'go',
    license: 'BSD-2-Clause',
    hints: { knownFile: 'errors.go' },
    expectNonEmpty: ['orient', 'get_architecture_overview'],
  },
  {
    id: 'rust-bitflags',
    url: 'https://github.com/bitflags/bitflags.git',
    sha: '13513699141432af1dea2a6208e99e7bf21958db', // commit for tag 2.6.0 (confirmed via git ls-remote)
    tag: '2.6.0',
    primaryLanguage: 'rust',
    license: 'MIT OR Apache-2.0',
    hints: { knownFile: 'src/lib.rs' },
    expectNonEmpty: ['orient', 'get_architecture_overview'],
  },
  {
    id: 'c-sds',
    url: 'https://github.com/antirez/sds.git',
    sha: 'f74b9b785b63c6d8ea312d7e7864df5267149c85', // commit for tag 2.0.0 (confirmed via git ls-remote)
    tag: '2.0.0',
    primaryLanguage: 'c',
    license: 'BSD-2-Clause',
    hints: { knownFile: 'sds.c' },
    expectNonEmpty: ['orient', 'get_architecture_overview'],
  },
  {
    id: 'ruby-rack',
    url: 'https://github.com/rack/rack.git',
    sha: '0eabeb73b3fb590e187dacfd9a890fbb7ffb9477', // commit for tag v3.1.8 (confirmed via git ls-remote)
    tag: 'v3.1.8',
    primaryLanguage: 'ruby',
    license: 'MIT',
    hints: { knownFile: 'lib/rack.rb' },
    expectNonEmpty: ['orient', 'get_architecture_overview'],
  },
  {
    id: 'java-commons-cli',
    url: 'https://github.com/apache/commons-cli.git',
    sha: '698b238276c0e22e97e4aec703a0b00201d29666', // commit for tag rel/commons-cli-1.9.0 (confirmed via git ls-remote)
    tag: 'rel/commons-cli-1.9.0',
    primaryLanguage: 'java',
    license: 'Apache-2.0',
    hints: { knownFile: 'src/main/java/org/apache/commons/cli/CommandLine.java' },
    expectNonEmpty: ['orient', 'get_architecture_overview'],
  },
  // Kotlin (change: add-kotlin-reference-corpus-conformance, issue #546). One repository per
  // project shape. They are not a CI gate; a Kotlin pull request reports its before/after counts
  // from them. Pinned to the default-branch commit resolved with `git ls-remote` on 2026-10-10.
  {
    id: 'kotlin-spring-boot',
    url: 'https://github.com/spring-guides/tut-spring-boot-kotlin.git',
    sha: 'a599cbd44f5ec108c402e9967309ead7008b2212',
    tag: 'main@2026-10-10',
    primaryLanguage: 'kotlin',
    license: 'Apache-2.0',
    expectNonEmpty: ['orient', 'get_architecture_overview'],
  },
  {
    id: 'kotlin-ktor',
    url: 'https://github.com/ktorio/ktor-samples.git',
    sha: '1c9df7cf102d638eadaf545fcce4c0ec5ccad334',
    tag: 'main@2026-10-10',
    primaryLanguage: 'kotlin',
    license: 'Apache-2.0',
    expectNonEmpty: ['orient', 'get_architecture_overview'],
  },
  {
    id: 'kotlin-android',
    url: 'https://github.com/android/sunflower.git',
    sha: '2a357a31551bb53f3fe80382a9ce6d30bcc8b960',
    tag: 'main@2026-10-10',
    primaryLanguage: 'kotlin',
    license: 'Apache-2.0',
    expectNonEmpty: ['orient', 'get_architecture_overview'],
  },
  {
    id: 'kotlin-multiplatform',
    url: 'https://github.com/Kotlin/kotlinx-datetime.git',
    sha: 'c2175995417a2a9d291a3de5d7b65fb5c1c408b2',
    tag: 'master@2026-10-10',
    primaryLanguage: 'kotlin',
    license: 'Apache-2.0',
    expectNonEmpty: ['orient', 'get_architecture_overview'],
  },
  // TODO(spec-09-followup): add swift / c# / php / scala / elixir / bash repos.
];

/** A 40-char lowercase-hex git SHA. */
export const SHA_RE = /^[0-9a-f]{40}$/;

/** The all-zero placeholder SHA used until a networked run confirms the real one. */
export const PLACEHOLDER_SHA = '0000000000000000000000000000000000000000';
