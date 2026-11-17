/**
 * Ensures every grammar loaded via loadGrammarSoft() is declared as an
 * optionalDependency in package.json, not a hard dependency.
 *
 * loadGrammarSoft = graceful failure at runtime → the package MUST be
 * optional at install time, or npm install will fail in restricted
 * environments (corporate proxy, TLS inspection, offline) when node-gyp
 * cannot fetch build headers.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');

function extractSoftLoadedPackages(): string[] {
  const src = readFileSync(join(ROOT, 'src', 'core', 'analyzer', 'call-graph.ts'), 'utf-8');
  // Match: loadGrammarSoft('X', () => importGrammar('tree-sitter-foo'), ...)
  // `importGrammar` imports the grammar's explicit entry file rather than its
  // extension-less `"main"` (DEP0151); a bare `import(...)` is still accepted
  // here so the guard keeps working if a site is ever written that way.
  const re = /loadGrammarSoft\('[^']+',\s*\(\)\s*=>\s*(?:importGrammar|import)\('(tree-sitter-[^']+)'\)/g;
  const packages: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    packages.push(m[1]);
  }
  return [...new Set(packages)];
}

describe('grammar optional dependencies', () => {
  it('every package loaded via loadGrammarSoft is in optionalDependencies', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
    const optional = new Set<string>(Object.keys(pkg.optionalDependencies ?? {}));
    const hardDeps = new Set<string>(Object.keys(pkg.dependencies ?? {}));

    const softLoaded = extractSoftLoadedPackages();
    expect(softLoaded.length).toBeGreaterThan(0); // regex sanity check

    const violations: string[] = [];
    for (const pkg of softLoaded) {
      if (hardDeps.has(pkg) && !optional.has(pkg)) {
        violations.push(pkg);
      }
    }

    expect(
      violations,
      `These packages are loaded via loadGrammarSoft() (graceful failure) but declared ` +
      `in "dependencies" (hard install). Move them to "optionalDependencies":\n` +
      violations.map(p => `  - ${p}`).join('\n')
    ).toEqual([]);
  });

  it('extractSoftLoadedPackages detects at least the known soft-loaded grammars', () => {
    const softLoaded = extractSoftLoadedPackages();
    const known = ['tree-sitter-kotlin', 'tree-sitter-bash', 'tree-sitter-c', 'tree-sitter-c-sharp'];
    for (const k of known) {
      expect(softLoaded, `Expected ${k} to be detected as soft-loaded`).toContain(k);
    }
  });
});
