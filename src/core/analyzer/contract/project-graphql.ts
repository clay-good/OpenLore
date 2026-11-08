/**
 * Projection: a GraphQL schema → the existing graph primitives
 * (change: add-contract-graph-projection, GraphQL phase).
 *
 *   operation node        `Query.order` — a field of a root operation type
 *   type node             `Order` — an object, interface, input, enum, union or scalar type
 *   `references_schema`   operation → its return and argument types; type → the types it names
 *   `implements_endpoint` the function a literal resolver map names → the operation it resolves
 *
 * One schema per PROJECT, as one server sees it: the files of one project merged into one namespace,
 * `extend` folded into its definition (change: scope-graphql-schema-universes). A project is a
 * schema's nearest enclosing project root; a name two files OF ONE PROJECT define is ambiguous and
 * binds nothing. Every refusal is disclosed, as in the OpenAPI and protobuf halves.
 */

import type { CallEdge, FunctionNode } from '../call-graph-types.js';
import { readGraphql, mergeGraphqlUniverses, namedType, isBuiltInScalar, type GqlDocument, type GqlUniverseSchema } from './graphql.js';
import { partitionSchemaUniverses, universeLabel } from './types.js';
import type { ResolverMap } from './graphql-resolvers.js';
import { isImportedModule, isImportedPythonModule, type ImportTarget } from './grpc-registration.js';

/** GraphQL SCHEMA files read per build (client documents cost no slot). */
export const MAX_GRAPHQL_FILES = 500;
/** GraphQL files of any kind examined per build: a frontend holds many query documents. */
export const MAX_GRAPHQL_CANDIDATES = MAX_GRAPHQL_FILES * 4;
const MAX_GRAPHQL_OPERATIONS = 2_000;
/** Per-project GraphQL disclosures listed per build, in total: a monorepo has hundreds of projects. */
const MAX_UNIVERSE_DISCLOSURES = 50;
const MAX_GRAPHQL_TYPES = 4_000;

/** `synthesizedBy` on an edge bound through a resolver map rather than a call site. */
export const GRAPHQL_RESOLVER_BINDING = 'graphql-resolver';

export interface UnresolvedResolver {
  file: string;
  line: number;
  root: string;
  field?: string;
  reason: 'not-literal' | 'unknown-field' | 'inline-implementation' | 'ambiguous-implementation' | 'implementation-not-found';
  detail?: string;
}

export interface GraphqlProjectionInput {
  files: readonly { path: string; content: string }[];
  /** The resolver maps in the indexed source, for the schema's root type names. */
  resolverMaps: (roots: readonly string[]) => readonly ResolverMap[];
  /** The code functions of a name a resolver entry could mean. */
  resolveImplementation: (map: ResolverMap, name: string) => readonly FunctionNode[];
  /** Where an import names a function: its module, one level of re-export followed. */
  importTargets?: (fromFile: string, specifier: string, name: string, runtime: 'node' | 'python') => readonly ImportTarget[];
  /**
   * Project-root directories, from the walk's own listing (change: scope-graphql-schema-universes).
   * Schema identity resolves within the nearest enclosing root, so two unrelated projects in one
   * repository do not void each other's `type Query`. Absent, the whole repository is one universe
   * — the answer before the rule existed.
   */
  projectRoots?: readonly string[];
}

export interface GraphqlProjection {
  nodes: FunctionNode[];
  edges: CallEdge[];
  unreadSpecifications: Array<{ file: string; reason: string }>;
  /** GraphQL files that are client documents (operations and fragments), not schemas. */
  clientDocuments: string[];
  unresolvedResolvers: UnresolvedResolver[];
  /** Operations no resolver map binds, as `address (file:line)`. */
  unboundOperations: string[];
  notAssessed: string[];
  /** After-the-fact disclosures that withhold nothing. */
  notes: string[];
  truncations: Array<{ reason: 'operation-cap' | 'schema-cap' | 'graphql-file-cap'; cap: number; seen: number }>;
}

const nodeId = (file: string, name: string) => `${file}::${name}`;

const declarationNode = (file: string, name: string, line: number, signature: string): FunctionNode => ({
  id: nodeId(file, name), name, filePath: file, isAsync: false, language: 'GraphQL',
  startIndex: 0, endIndex: 0, fanIn: 0, fanOut: 0, signature, startLine: line, endLine: line,
});

export function projectGraphql(input: GraphqlProjectionInput): GraphqlProjection {
  const out: GraphqlProjection = {
    nodes: [], edges: [], unreadSpecifications: [], clientDocuments: [], unresolvedResolvers: [],
    unboundOperations: [], notAssessed: [], notes: [], truncations: [],
  };
  const docs: GqlDocument[] = [];
  let pastCap = 0;
  for (const f of [...input.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const r = readGraphql(f.path, f.content);
    if ('error' in r) out.unreadSpecifications.push({ file: f.path, reason: r.error });
    else if ('clientDocument' in r) out.clientDocuments.push(f.path);
    else if (docs.length >= MAX_GRAPHQL_FILES) pastCap++;
    else docs.push(r);
  }
  if (pastCap) {
    out.truncations.push({ reason: 'graphql-file-cap', cap: MAX_GRAPHQL_FILES, seen: docs.length + pastCap });
    out.notAssessed.push(`${pastCap} GraphQL schema file(s) past the cap of ${MAX_GRAPHQL_FILES} were not read`);
  }
  // An unread schema file may define the very type or root field a resolver names.
  if (out.unreadSpecifications.length) out.notAssessed.push(`${out.unreadSpecifications.length} GraphQL schema file(s) could not be read`);
  if (!docs.length) return out;
  const partition = partitionSchemaUniverses(docs.map(d => d.file), input.projectRoots ?? []);
  const universes = mergeGraphqlUniverses(docs, partition.universeOf);
  // The partition is stated, so the reader can check how the repository was divided.
  if (universes.length > 1) {
    const named = universes.map(u => universeLabel(u.universe));
    out.notes.push(`GraphQL schema identity was scoped to ${universes.length} project(s): ${named.slice(0, 8).join(', ')}${named.length > 8 ? `, and ${named.length - 8} more` : ''}. A type defined in two of them does not collide.`);
  }
  if (partition.rootsOmitted) out.notes.push(`${partition.rootsOmitted} project root(s) past the cap were not honored, so the schemas under them were read in a wider project.`);
  if (partition.tooDeep.length) out.notes.push(`${partition.tooDeep.length} GraphQL schema file(s) sit too deep for a project root to be looked for, so they were read in the repository root's project.`);
  const outside = [...new Set(docs.flatMap(d => d.unassessed))].sort();
  if (outside.length) out.notes.push(`GraphQL constructs outside the model were not read: ${outside.slice(0, 12).join(', ')}${outside.length > 12 ? ', …' : ''}`);

  const pushEdge = (() => {
    const seen = new Set<string>();
    return (from: FunctionNode, to: FunctionNode, kind: 'implements_endpoint' | 'references_schema', line: number, synthesizedBy?: string) => {
      const key = `${from.id}\0${to.id}\0${kind}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.edges.push({ callerId: from.id, calleeId: to.id, calleeName: to.name, line, confidence: 'import', kind, ...(synthesizedBy ? { synthesizedBy } : {}) });
    };
  })();

  /** One project's projected operations, by `Root.field`, and the schema they came from. */
  const perUniverse = new Map<string, { at: GqlUniverseSchema; operations: Map<string, FunctionNode> }>();
  /** Every projected operation by address, across projects: a resolver map outside any of them. */
  const operationsByAddress = new Map<string, Array<{ universe: string; node: FunctionNode }>>();
  /** `Root` → the field names it declares in ANY project: a field declared somewhere is not unknown. */
  const fieldsOfRoot = new Map<string, Set<string>>();
  const allRootNames = new Set<string>();
  let typesSeen = 0;
  let typesProjected = 0;
  let opsSeen = 0;
  let opsProjected = 0;
  let unlinked = 0;

  // Per-project disclosures are bounded in TOTAL, not per project: a 500-package monorepo would
  // otherwise emit thousands of lines. What the bound drops is counted, never dropped silently.
  let withheldShown = 0;
  let withheldOmitted = 0;
  let notesShown = 0;
  let notesOmitted = 0;
  const withhold = (text: string) => { if (withheldShown++ < MAX_UNIVERSE_DISCLOSURES) out.notAssessed.push(text); else withheldOmitted++; };
  const note = (text: string) => { if (notesShown++ < MAX_UNIVERSE_DISCLOSURES) out.notes.push(text); else notesOmitted++; };

  for (const at of universes) {
    const schema = at.schema;
    const where = universes.length > 1 ? ` (in ${universeLabel(at.universe)})` : '';
    // A ROOT type defined twice leaves every operation of that kind unprojected: the resolvers it
    // would bind then read as dead code, so this withholds rather than notes.
    for (const kind of ['query', 'mutation', 'subscription'] as const) {
      const name = schema.roots[kind];
      const amb = name ? schema.ambiguous.find(a => a.name === name) : undefined;
      if (amb) withhold(`the GraphQL ${kind} root type ${amb.name} is defined in more than one file (${amb.files.slice(0, 3).join(', ')})${where}, so its operations are not projected`);
      const bad = name ? schema.unassessableTypes.find(u => u.name === name) : undefined;
      if (bad) withhold(`the GraphQL ${kind} root type ${bad.name} ${bad.reason} in ${bad.files[0]}, so its operations are not projected`);
    }
    for (const kind of schema.rootConflicts) withhold(`the GraphQL ${kind} root is named differently in two files${where}, so its operations are not projected`);
    if (schema.ambiguous.length) note(`${schema.ambiguous.length} GraphQL type(s) are defined in more than one file${where} (${schema.ambiguous.slice(0, 3).map(a => a.name).join(', ')}), so nothing binds to them`);
    // Withheld for its own shape, not for being defined twice: named one by one, since this is the
    // one case where the rest of the same document IS read.
    for (const u of schema.unassessableTypes) withhold(`GraphQL type ${u.name} in ${u.files[0]}: ${u.reason}, so it is not projected`);
    if (schema.orphanExtensions.length) note(`${schema.orphanExtensions.length} \`extend\` definition(s)${where} extend a type no file read defines`);
    for (const c of schema.conflicts.slice(0, 5)) note(c);

    const rootNames = new Set(Object.values(schema.roots).filter((r): r is string => !!r));
    for (const r of rootNames) {
      allRootNames.add(r);
      let names = fieldsOfRoot.get(r);
      if (!names) { names = new Set(); fieldsOfRoot.set(r, names); }
      for (const f of schema.types.get(r)?.fields ?? []) names.add(f.name);
    }

    // ── Nodes ──
    const typeNodes = new Map<string, FunctionNode>();
    for (const t of [...schema.types.values()].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (rootNames.has(t.name)) continue; // a root type's fields are the operations
      typesSeen++;
      if (typesProjected >= MAX_GRAPHQL_TYPES) continue;
      typesProjected++;
      const kw = t.kind === 'object' ? 'type' : t.kind;
      const node = declarationNode(t.file, t.name, t.line, `${kw} ${t.name}`);
      typeNodes.set(t.name, node);
      out.nodes.push(node);
    }
    /** `Query.order` → its node, within this project. */
    const operationNodes = new Map<string, FunctionNode>();
    for (const kind of ['query', 'mutation', 'subscription'] as const) {
      const root = schema.types.get(schema.roots[kind] ?? "");
      if (!root) continue;
      for (const f of root.fields) {
        opsSeen++;
        if (opsProjected >= MAX_GRAPHQL_OPERATIONS) continue;
        opsProjected++;
        const address = `${root.name}.${f.name}`;
        const args = f.args.map(a => `${a.name}: ${a.type}${a.defaultValue !== undefined ? ` = ${a.defaultValue}` : ''}`).join(', ');
        const node = declarationNode(f.file ?? root.file, address, f.line, `${kind} ${f.name}${args ? `(${args})` : ''}: ${f.type}`);
        operationNodes.set(address, node);
        const seen = operationsByAddress.get(address);
        if (seen) seen.push({ universe: at.universe, node }); else operationsByAddress.set(address, [{ universe: at.universe, node }]);
        out.nodes.push(node);
      }
    }
    perUniverse.set(at.universe, { at, operations: operationNodes });

    // ── references_schema: a type reference resolves inside its own project ──
    const link = (from: FunctionNode | undefined, typeName: string, line: number) => {
      if (!from || isBuiltInScalar(typeName) || rootNames.has(typeName)) return;
      const to = typeNodes.get(typeName);
      if (to) pushEdge(from, to, 'references_schema', line); else unlinked++;
    };
    for (const t of schema.types.values()) {
      const isRoot = rootNames.has(t.name);
      for (const f of t.fields) {
        const from = isRoot ? operationNodes.get(`${t.name}.${f.name}`) : typeNodes.get(t.name);
        link(from, namedType(f.type), f.line);
        for (const a of f.args) link(from, namedType(a.type), a.line);
      }
      if (!isRoot) {
        for (const m of t.members) link(typeNodes.get(t.name), m, t.line);
        for (const i of t.interfaces) link(typeNodes.get(t.name), i, t.line);
      }
    }
  }
  if (withheldOmitted) out.notAssessed.push(`${withheldOmitted} further GraphQL withholding(s) past the disclosure cap of ${MAX_UNIVERSE_DISCLOSURES} were not listed`);
  if (notesOmitted) out.notes.push(`${notesOmitted} further GraphQL note(s) past the disclosure cap of ${MAX_UNIVERSE_DISCLOSURES} were not listed`);
  if (typesSeen > typesProjected) {
    out.truncations.push({ reason: 'schema-cap', cap: MAX_GRAPHQL_TYPES, seen: typesSeen });
    out.notAssessed.push(`${typesSeen - typesProjected} GraphQL type(s) past the cap were not projected`);
  }
  if (opsSeen > opsProjected) {
    out.truncations.push({ reason: 'operation-cap', cap: MAX_GRAPHQL_OPERATIONS, seen: opsSeen });
    out.notAssessed.push(`${opsSeen - opsProjected} GraphQL operation(s) past the cap were not projected`);
  }
  if (unlinked) out.notes.push(`${unlinked} GraphQL type reference(s) name a type no file read defines in the same project (or one defined twice, or past the cap), so no edge was drawn for them`);

  // ── implements_endpoint: from resolver maps ──
  const bound = new Set<string>();
  let maps: readonly ResolverMap[] = [];
  try {
    maps = input.resolverMaps([...allRootNames].filter(r => universes.some(u => u.schema.types.has(r))));
  } catch (e) {
    out.notAssessed.push(`the resolver scan failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
  }
  for (const map of [...maps].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || a.line - b.line)) {
    if (map.notLiteral) { out.unresolvedResolvers.push({ file: map.file, line: map.line, root: map.root, reason: 'not-literal', detail: map.notLiteral }); continue; }
    // The project the map's own file belongs to, so a map binds to ITS schema first. Falling back
    // to a unique match anywhere keeps a monorepo that splits its server from its schema bound, and
    // an address two projects both declare is never guessed between.
    const own = perUniverse.get(partition.universeOf(map.file));
    for (const e of map.entries) {
      const address = `${map.root}.${e.field}`;
      const elsewhere = operationsByAddress.get(address) ?? [];
      const target = own?.operations.get(address)
        ?? (elsewhere.length === 1 ? elsewhere[0].node : undefined);
      // Whether the schema declares the field at all: in the map's OWN project when it has one,
      // otherwise in any project — a field some project declares is never called unknown.
      const declared = own
        ? (own.at.schema.types.get(map.root)?.fields.some(f => f.name === e.field) ?? false)
        : (fieldsOfRoot.get(map.root)?.has(e.field) ?? false);
      if (!target) {
        if (elsewhere.length > 1) {
          out.unresolvedResolvers.push({ file: map.file, line: e.line, root: map.root, field: e.field, reason: 'ambiguous-implementation',
            detail: `${address} is declared by ${elsewhere.length} projects (${[...new Set(elsewhere.map(x => universeLabel(x.universe)))].slice(0, 3).join(', ')}) and this map is in none of them` });
          continue;
        }
        // `__resolveType` and friends are resolver plumbing, not fields.
        if (!e.field.startsWith('__') && !declared) {
          out.unresolvedResolvers.push({ file: map.file, line: e.line, root: map.root, field: e.field, reason: 'unknown-field' });
        }
        continue;
      }
      if (!e.fn) { out.unresolvedResolvers.push({ file: map.file, line: e.line, root: map.root, field: e.field, reason: 'inline-implementation' }); continue; }
      // A member of a local object, an expression, an attribute of a non-import: the literal does
      // not name a function this file defines, so no same-named function stands in for it.
      if (e.notFollowed) { out.unresolvedResolvers.push({ file: map.file, line: e.line, root: map.root, field: e.field, reason: 'implementation-not-found', detail: e.notFollowed }); continue; }
      const found = input.resolveImplementation(map, e.fn);
      // An imported function is looked for in the module it was imported FROM, and only there — a
      // same-named function in this file or anywhere else is not it. Otherwise, this file only.
      const spec = e.from ?? e.module;
      const targets = e.imported && spec !== undefined && input.importTargets ? input.importTargets(map.file, spec, e.fn, map.runtime) : undefined;
      const scope = !e.imported
        ? found.filter(n => n.filePath === map.file)
        : targets
          ? targets.flatMap(t => (t.name === e.fn ? found : input.resolveImplementation(map, t.name)).filter(n => n.filePath === t.file))
          : found.filter(n => (e.from !== undefined && isImportedModule(map.file, e.from, n.filePath))
            || (e.module !== undefined && isImportedPythonModule(map.file, e.module, n.filePath)));
      if (scope.length > 1) {
        out.unresolvedResolvers.push({ file: map.file, line: e.line, root: map.root, field: e.field, reason: 'ambiguous-implementation', detail: `more than one \`${e.fn}\`` });
        continue;
      }
      if (!scope.length) {
        out.unresolvedResolvers.push({ file: map.file, line: e.line, root: map.root, field: e.field, reason: 'implementation-not-found',
          detail: e.notFollowed ?? (!e.imported ? `\`${e.fn}\` is neither defined in ${map.file} nor imported by it`
            : targets?.length ? `\`${e.fn}\` is imported from '${spec}', which is indexed but neither defines nor directly re-exports it`
              : `\`${e.fn}\` is imported by ${map.file} from '${spec}', which is not indexed here (a package or a path alias)`) });
        continue;
      }
      pushEdge(scope[0], target, 'implements_endpoint', scope[0].startLine ?? e.line, GRAPHQL_RESOLVER_BINDING);
      bound.add(target.id);
    }
  }
  // One operation, two implementations: two servers in one repository sharing a schema file, or
  // one map not this schema's. Both edges stay — each is a literal binding — and the fact is said.
  const perOp = new Map<string, number>();
  for (const e of out.edges) if (e.kind === 'implements_endpoint') perOp.set(e.calleeId, (perOp.get(e.calleeId) ?? 0) + 1);
  const doubled = [...perOp].filter(([, n]) => n > 1).map(([id]) => id.slice(id.indexOf('::') + 2)).sort();
  if (doubled.length) out.notes.push(`${doubled.length} GraphQL operation(s) are bound by more than one resolver map (${doubled.slice(0, 3).join(', ')}${doubled.length > 3 ? ', …' : ''}): two servers, or a map that serves another schema`);
  out.unboundOperations = [...perUniverse.values()].flatMap(u => [...u.operations.values()])
    .filter(n => !bound.has(n.id)).map(n => `${n.name} (${n.filePath}:${n.startLine})`).sort();
  return out;
}
