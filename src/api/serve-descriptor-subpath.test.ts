/**
 * Guard for the `openlore/serve-descriptor` subpath (change: extend-api-for-supervising-hosts).
 *
 * The subpath exists for ONE reason: a supervising host must be able to share the descriptor
 * validator without loading the analyzer into the process that serves every workspace
 * (mcp-security: ServeDescriptorValidatedAtEveryReader, "Importing the contract does not load the
 * analyzer"). That property is invisible at the call site and dies to a single innocuous static
 * import, so it is pinned here.
 *
 * This walks the TRANSITIVE STATIC import graph of the entry point. For ESM, static imports are
 * exactly what gets eagerly evaluated on import, so the static graph IS the loaded module set —
 * and unlike a runtime probe it needs no build, so it runs in the normal suite and fails in review
 * rather than at publish. The runtime counterpart, which imports the BUILT subpath in a child
 * process and asserts the same thing against `dist/`, lives in `scripts/api-consumer-smoke.mjs`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..');
const ENTRY = join(HERE, 'serve-descriptor.ts');

/** Static `import ... from '<spec>'` / `export ... from '<spec>'` specifiers, in source order. */
function staticSpecifiers(file: string): string[] {
  const source = readFileSync(file, 'utf-8');
  return [...source.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map(m => m[1]);
}

/** Resolve a relative `./x.js` specifier back to the `.ts` source it is emitted from. */
function resolveLocal(spec: string, fromFile: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [base.replace(/\.js$/, '.ts'), `${base}.ts`, base]) {
    if (candidate.endsWith('.ts') && existsSync(candidate)) return candidate;
  }
  return null;
}

function staticGraph(entry: string): { files: Set<string>; external: Set<string> } {
  const files = new Set<string>();
  const external = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    for (const spec of staticSpecifiers(file)) {
      const local = resolveLocal(spec, file);
      if (local) stack.push(local);
      else external.add(spec);
    }
  }
  return { files, external };
}

describe('openlore/serve-descriptor subpath', () => {
  it('never reaches the analyzer or a parser through static imports', () => {
    const { files } = staticGraph(ENTRY);
    const reached = [...files].map(f => relative(SRC, f).replace(/\\/g, '/'));
    const forbidden = reached.filter(f =>
      f.startsWith('core/analyzer/')
      || f.includes('call-graph')
      || f.includes('tree-sitter')
      || f.includes('vector-index'),
    );
    expect(forbidden, `subpath must not reach the analyzer; found: ${forbidden.join(', ')}`).toEqual([]);
  });

  it('depends on node builtins only — no third-party package', () => {
    const { external } = staticGraph(ENTRY);
    const thirdParty = [...external].filter(spec => !spec.startsWith('node:'));
    expect(
      thirdParty,
      `the descriptor contract is dependency-light by contract; found third-party: ${thirdParty.join(', ')}`,
    ).toEqual([]);
  });

  it('does not re-export through the analyzer-loading api barrel', () => {
    // `src/api/index.ts` statically re-exports openloreAnalyze. Sourcing the subpath from it would
    // typecheck, pass every behavioural test, and silently reintroduce the analyzer.
    const { files } = staticGraph(ENTRY);
    const viaBarrel = [...files].some(f => relative(SRC, f).replace(/\\/g, '/') === 'api/index.ts');
    expect(viaBarrel, 'serve-descriptor entry must not import src/api/index.ts').toBe(false);
  });
});
