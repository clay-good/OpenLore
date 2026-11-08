/**
 * Interface-contract language tags (change: add-contract-node-projection).
 *
 * A dependency-free leaf, like `iac/types.ts`: the language-support registry, the projector,
 * and every "is this a code node?" predicate import it without pulling in a reader.
 *
 * A contract element is a DECLARATION, not a code unit. Its node rides on the same graph
 * primitives as code (so orient/search_code/get_subgraph/find_path and the SCIP + federation
 * exports see it unchanged), but it is excluded from every candidate set that ranks source code
 * — hubs, entry points, dead code, coverage gaps, change significance — and its edges never
 * change a function's fan-in or fan-out.
 */

/** Schema-format tags a contract node can carry as its `language`. */
export type ContractLanguage = 'OpenAPI' | 'Protobuf' | 'GraphQL';

/** All contract language tags (single source of truth for gating). */
export const CONTRACT_LANGUAGES: readonly ContractLanguage[] = ['OpenAPI', 'Protobuf', 'GraphQL'];

const CONTRACT_LANGUAGE_SET: ReadonlySet<string> = new Set<string>(CONTRACT_LANGUAGES);

/**
 * Whether a GraphQL schema file sits under an explicit FIXTURE path. Such a schema describes a fake
 * service: read as the contract, its `type Query` makes the real root ambiguous and unbinds every
 * resolver. Deliberately narrow — `tests/`, `e2e/` and `test/` often hold a real service's schema —
 * and applied to GraphQL only: protobuf resolves through imports, so a fixture `.proto` shadows
 * nothing and is read as before.
 */
export function isFixtureSchemaPath(path: string): boolean {
  return /(?:^|\/)(?:__tests__|__fixtures__|fixtures?|test-?data|testdata)\//i.test(path) || /\.(?:test|spec)\.(?:graphqls?|gql)$/i.test(path);
}

/** Whether a node's language tag is an interface-contract format. */
export function isContractLanguage(language: string | undefined): boolean {
  return !!language && CONTRACT_LANGUAGE_SET.has(language);
}

// ── Schema universes (change: scope-graphql-schema-universes) ───────────────
//
// GraphQL has ONE global namespace per server, so every schema file read was merged into one
// namespace per REPOSITORY. In a monorepo that is wrong in the unsound direction: several
// unrelated projects each declare `type Query`, every one of them reads as "defined in more than
// one file", and a genuine breaking change inside one of them is never graded. A schema's identity
// belongs to its own PROJECT, so both the analyze side and the certify side partition the schema
// files into universes first and resolve type and field identity WITHIN a universe.
//
// The rule is deliberately a file-presence test, never a parse: a `package.json` that is not valid
// JSON still marks its directory, so a hostile or half-written manifest cannot move the partition.

/**
 * A file whose presence makes its own directory a project root — the key of a schema universe.
 *
 * `package.json` is the npm package boundary, which is what a monorepo actually divides on. The
 * GraphQL/Relay configs are added because a schema-only project often carries one and no manifest.
 * Every form listed is a `.json` / `.yaml` file, so it is already in the specification listing both
 * sides walk: no extra scan, and a `relay.config.js`-only project simply falls back to a WIDER
 * universe, which is the same answer as before this rule existed.
 */
// Case-SENSITIVE: on a case-sensitive filesystem `PACKAGE.JSON` is not an npm manifest, and
// honoring it would NARROW a universe — the one direction that can split a real schema.
const PROJECT_ROOT_MARKER_RE = /(?:^|\/)(?:package\.json|relay\.config\.json|graphql\.config\.(?:json|ya?ml)|\.graphqlrc\.(?:json|ya?ml)|\.graphqlconfig(?:\.(?:json|ya?ml))?)$/;

/** Whether this path marks its directory as a project root (see {@link partitionSchemaUniverses}). */
export function isProjectRootMarkerPath(path: string): boolean {
  return PROJECT_ROOT_MARKER_RE.test(path.split('\\').join('/'));
}

/** Project roots honored per partition; past it a marker is ignored and the universe stays wider. */
export const MAX_SCHEMA_UNIVERSE_ROOTS = 2_000;
/** Directory levels walked up from a schema looking for its project root. */
export const MAX_SCHEMA_UNIVERSE_DEPTH = 40;

/** How a set of schema files was divided into universes. */
export interface SchemaUniversePartition {
  /** The universe a schema path belongs to: its project-root directory, `''` for the repository root. */
  universeOf: (schemaPath: string) => string;
  /** Every universe at least one schema was assigned to, sorted. */
  universes: string[];
  /**
   * Project roots past {@link MAX_SCHEMA_UNIVERSE_ROOTS}. Their directories are NOT universes, so
   * the schemas under them fell back to a wider (enclosing) universe — the pre-partition answer.
   */
  rootsOmitted: number;
  /** Schemas more than {@link MAX_SCHEMA_UNIVERSE_DEPTH} levels deep: assigned the repository root. */
  tooDeep: string[];
}

const dirOf = (p: string): string => {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
};

/**
 * A repository-relative path, forward-slashed, or `undefined` when it is not one. An absolute path,
 * a drive letter, or any `..` segment is refused rather than normalized: a schema or a marker
 * reached through a link out of the repository must not silently key a universe.
 */
const relativePath = (p: string): string | undefined => {
  const s = p.split('\\').join('/').replace(/^\.\//, '');
  if (!s || s.startsWith('/') || /^[A-Za-z]:/.test(s)) return undefined;
  return s.split('/').some(seg => seg === '..') ? undefined : s;
};

/** {@link relativePath} for a DIRECTORY, where `''` is the repository root and is valid. */
const relativePath0 = (p: string): string | undefined => {
  const s = p.split('\\').join('/').replace(/^\.\//, '').replace(/\/+$/, '');
  return s === '' ? '' : relativePath(s);
};

/**
 * Divide `schemaPaths` into universes by their nearest enclosing project root.
 *
 * `rootDirs` are project-root directories ({@link projectRootDirs}). Both revisions of a
 * base-vs-head comparison MUST be partitioned with the SAME `rootDirs`, or a manifest that appeared
 * between them would move a type from one universe to another and read as removed-and-added.
 * Shallower roots are honored first, so dropping one past the cap only ever widens a universe.
 *
 * Linear: each schema walks up at most {@link MAX_SCHEMA_UNIVERSE_DEPTH} directories, once, and the
 * answer is memoized — never recomputed per type.
 */
export function partitionSchemaUniverses(
  schemaPaths: readonly string[],
  rootDirs: readonly string[],
): SchemaUniversePartition {
  const roots = new Set<string>();
  let rootsOmitted = 0;
  const depth = (d: string) => (d === '' ? 0 : d.split('/').length);
  const ordered = rootDirs.map(relativePath0).filter((p): p is string => p !== undefined)
    .sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0));
  for (const dir of ordered) {
    if (roots.has(dir)) continue;
    if (roots.size >= MAX_SCHEMA_UNIVERSE_ROOTS) { rootsOmitted++; continue; }
    roots.add(dir);
  }
  const memo = new Map<string, string>();
  const tooDeep: string[] = [];
  const resolve = (schemaPath: string): string => {
    const hit = memo.get(schemaPath);
    if (hit !== undefined) return hit;
    const norm = relativePath(schemaPath);
    let found = '';
    if (norm !== undefined) {
      let dir = dirOf(norm);
      let steps = 0;
      for (;;) {
        if (roots.has(dir)) { found = dir; break; }
        if (dir === '') break;
        if (++steps > MAX_SCHEMA_UNIVERSE_DEPTH) { tooDeep.push(norm); break; }
        dir = dirOf(dir);
      }
    }
    memo.set(schemaPath, found);
    return found;
  };
  const universes = new Set<string>();
  for (const p of schemaPaths) universes.add(resolve(p));
  return {
    universeOf: resolve,
    universes: [...universes].sort(),
    rootsOmitted,
    tooDeep: [...new Set(tooDeep)].sort(),
  };
}

/** The project roots a listing names, deduped and sorted: the `markerPaths` both sides agree on. */
export function projectRootDirs(paths: readonly string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    if (!isProjectRootMarkerPath(p)) continue;
    const norm = relativePath(p);
    if (norm !== undefined) out.add(dirOf(norm));
  }
  return [...out].sort();
}

/** A universe named for a person: its project root, or the repository root. */
export const universeLabel = (universe: string): string => (universe === '' ? '(repository root)' : universe);
