/**
 * Explicit entry-file resolution for the native tree-sitter grammar packages.
 *
 * Every `tree-sitter-*` grammar we load declares `"main": "bindings/node"` — a
 * DIRECTORY, with no extension — and no `"exports"` field. Node's ESM resolver
 * still honors that legacy form, but it emits a deprecation warning for it:
 *
 *     (node:NNN) [DEP0151] DeprecationWarning: Package …/tree-sitter-c-sharp/
 *     has a "main" field set to "bindings/node", excluding the full filename and
 *     extension to the resolved file at "bindings/node/index.js", imported from
 *     …/dist/core/analyzer/call-graph.js
 *
 * That warning goes straight to the user's stderr, once per grammar per
 * process — on a polyglot repository, seven or more unreadable lines in the
 * middle of `openlore analyze`'s report. It is triggered by OUR import, so it is
 * ours to fix, and the fix is the one Node itself names: import the resolved
 * entry FILE rather than the package's legacy `main`.
 *
 * We get that path from the CommonJS resolver (`createRequire(...).resolve`),
 * which performs the same extension/index lookup without complaint, and import
 * the file URL. No Node warning is suppressed, no dependency is added, and no
 * dependency version changes — the same module object is loaded either way.
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const requireFromHere = createRequire(import.meta.url);

/**
 * The absolute path of a grammar package's real entry file, or `null` when the
 * package is not installed (the common case — grammars are optional
 * dependencies) or cannot be resolved from here.
 */
export function resolveGrammarEntry(specifier: string): string | null {
  try {
    return requireFromHere.resolve(specifier);
  } catch {
    return null;
  }
}

type GrammarImporter = (
  specifier: string,
  loadReal: (specifier: string) => Promise<GrammarModule>,
) => Promise<unknown>;

let importOverrideForTests: GrammarImporter | null = null;

/**
 * Test seam: route every grammar import through `importer`, so a test can
 * simulate a grammar that is not installed. `loadReal` performs the real load
 * (it does NOT re-enter the override), so a test can fail one grammar and let
 * every other one through. Pass `null` to restore.
 *
 * Needed because grammars are no longer imported by bare specifier, so a
 * specifier-keyed module mock no longer intercepts them.
 */
export function __setGrammarImporterForTests(importer: GrammarImporter | null): void {
  importOverrideForTests = importer;
}

/**
 * Import a native tree-sitter grammar package by its explicit entry file.
 *
 * Returns the same module namespace a bare `import(specifier)` would, so
 * callers keep reading `m.default`. When the entry file cannot be resolved the
 * bare specifier is imported so the caller still sees the real resolution error
 * (the soft grammar loaders turn that into a graceful degradation).
 */
export async function importGrammar(specifier: string): Promise<GrammarModule> {
  if (importOverrideForTests) {
    return (await importOverrideForTests(specifier, loadGrammarModule)) as GrammarModule;
  }
  return loadGrammarModule(specifier);
}

async function loadGrammarModule(specifier: string): Promise<GrammarModule> {
  const entry = resolveGrammarEntry(specifier);
  if (entry) {
    return (await import(pathToFileURL(entry).href)) as GrammarModule;
  }
  return (await import(specifier)) as GrammarModule;
}

/**
 * A grammar package's module namespace: a default export (the grammar, or a
 * record of dialect grammars for the multi-dialect packages) plus whatever else
 * the package attaches.
 */
export type GrammarModule = { default: object } & Record<string, unknown>;
