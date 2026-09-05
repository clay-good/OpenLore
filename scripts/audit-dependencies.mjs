#!/usr/bin/env node
/**
 * Unreferenced-dependency guard (change: extend-api-for-supervising-hosts,
 * cli: OptionalFeatureDependenciesDegradeAtTheirOwnCommand).
 *
 * A package in `dependencies` that no file under `src/` imports is downloaded, installed and
 * carried by every consumer for nothing — and it is invisible in review, because a dependency is
 * only ever noticed when something fails without it. `@modelcontextprotocol/server-memory` sat in
 * `dependencies` with zero references under `src/`, dragging a second MCP server and its bin into
 * every install. This makes that class of drift fail loudly instead of accumulating.
 *
 * Scope is deliberately narrow: REQUIRED dependencies only. `optionalDependencies` are allowed to
 * be referenced indirectly (a grammar resolved by name at runtime, a viewer package resolved by
 * vite rather than by an import in our own source), so auditing them would produce false failures.
 * `devDependencies` are not shipped.
 *
 * Detection is textual on purpose — a bare specifier or a subpath of it, in an import, an
 * `import()`, or a `require()`. It cannot see a package resolved from a computed string; such a
 * package belongs in `IMPLICIT` below, with the reason written down.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Packages that are genuinely needed but are not named by any import under `src/`.
 * Each entry must carry the reason it cannot be detected. Empty is the healthy state.
 */
export const IMPLICIT = Object.freeze({});

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

/**
 * Test files are NOT sources for this audit. A package imported only by a test is a development
 * dependency, and counting tests would also let a test that merely NAMES a package (this audit's
 * own test does) vouch for it.
 */
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|\.integration\.[^/]*$/;

/** Every production source file under a directory, skipping tests and what is not hand-authored. */
export function collectSources(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectSources(path));
    } else if (SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext)) && !TEST_FILE.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

/**
 * The required dependencies that no source text references.
 *
 * @param {string[]} dependencies package names from `dependencies`
 * @param {string[]} sources file contents to search
 * @returns {string[]} the unreferenced names, sorted
 */
export function findUnreferencedDependencies(dependencies, sources) {
  const text = sources.join('\n');
  return dependencies
    .filter((name) => !(name in IMPLICIT))
    .filter((name) => {
      // The bare specifier or one of its subpaths, in quotes: `from 'pkg'`, `import('pkg/sub')`,
      // `require("pkg")`. Quoting is what distinguishes a specifier from a mention in prose.
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return !new RegExp(`['"\`]${escaped}(/[^'"\`]*)?['"\`]`).test(text);
    })
    .sort();
}

function main() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const dependencies = Object.keys(pkg.dependencies ?? {});
  const sources = collectSources(join(ROOT, 'src')).map((file) => readFileSync(file, 'utf8'));
  const unreferenced = findUnreferencedDependencies(dependencies, sources);

  if (unreferenced.length > 0) {
    console.error(
      `audit-dependencies: FAILED — ${unreferenced.length} package(s) in "dependencies" are not imported by any file under src/:\n` +
        unreferenced.map((name) => `  - ${name}`).join('\n') +
        `\n\nRemove each one, or — if it is loaded without an import — add it to IMPLICIT in scripts/audit-dependencies.mjs with the reason.`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(`audit-dependencies: OK — all ${dependencies.length} required dependencies are imported under src/.`);
}

// Only run the audit when invoked as a script; the test imports the functions above.
if (process.argv[1] && statSync(process.argv[1]).isFile() && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
