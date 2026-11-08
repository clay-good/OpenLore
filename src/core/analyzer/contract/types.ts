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

// ============================================================================
// SCHEMA PROVENANCE (change: disclose-schema-provenance)
// ============================================================================

/**
 * Whether a schema file is a GENERATED or VENDORED copy rather than something this repository
 * hand-wrote. A codegen output (`src/__generated__/schema.graphql`) or a vendored copy of another
 * service's contract was graded as this repository's own, silently — a breaking verdict on it
 * reads as "you broke your API" when the file is a build artifact or someone else's contract.
 *
 * It ANNOTATES only. A provenance verdict never drops, downgrades or excludes a schema from
 * grading: the signal is a guess at the weaker certainty, and a repository is free to hand-write
 * a file under `generated/`.
 *
 * Deliberately NOT the `generated-file-guard` classifier, for the same reason
 * `generated-client.ts` is not: that lives in the service layer, which the analyzer may not
 * import, and it answers a broader question (gitattributes, lockfiles, `.d.ts`) for the edit
 * guard.
 *
 * The header-marker ids are the guard's own, and `schema-provenance.test.ts` compares the two
 * implementations' verdicts so they cannot drift apart silently. The path patterns are the
 * guard's names too — `node_modules/`, `vendor/`, `vendored/`, `__generated__/`, `generated/`,
 * `*.generated.*` — with ONE addition the guard does not have, `third_party/`, because a vendored
 * schema tree is conventionally named that. They are matched case-insensitively here (the guard
 * is case-sensitive): on a case-insensitive checkout `Vendor/` is `vendor/`.
 */
export type SchemaProvenanceKind = 'generated' | 'vendored';

export interface SchemaProvenance {
  kind: SchemaProvenanceKind;
  /** Which rule matched: a header-marker id, or a path pattern — the guard's names. */
  matched: string;
  /**
   * `declared` — the file's own header says it is generated. `path-pattern` — only its path
   * suggests it, which is the weaker signal and is never reported as `declared`.
   */
  certainty: 'declared' | 'path-pattern';
}

/** How far into a schema file a generator header is looked for (the guard's own bounds). */
export const SCHEMA_PROVENANCE_HEAD_BYTES = 8 * 1024;
const SCHEMA_PROVENANCE_HEAD_LINES = 40;

/** A line that opens with a comment token, in the languages a schema is written in. */
const SCHEMA_COMMENT_LEAD = /^\s*(?:\/\/+!?|#+!?|\/\*+!?|\*+|--+|;+|<!--|%+)\s*/;
/** One opening line that must precede any comment in its language. */
const SCHEMA_HEADER_PREAMBLE = /^\s*(?:<\?php\b.*|<\?xml\b.*\?>\s*|['"]use strict['"];?\s*|@file:.*)$/;

/**
 * The closed list of generator header markers, by the same ids and the same shapes as
 * `GENERATED_HEADER_MARKERS`. A header matching none of these is NOT detected.
 */
export const GENERATED_SCHEMA_HEADER_MARKERS: ReadonlyArray<{ id: string; test: (line: string) => boolean }> = [
  { id: 'go-code-generated', test: line => /^\/\/ Code generated .* DO NOT EDIT\.$/.test(line) },
  {
    id: 'at-generated',
    test: line => SCHEMA_COMMENT_LEAD.test(line) && /^@generated(?:\s|\*\/|$)/.test(line.replace(SCHEMA_COMMENT_LEAD, '')),
  },
  {
    id: 'generated-do-not-edit',
    test: line => SCHEMA_COMMENT_LEAD.test(line) && /\b(?:auto-?)?generated\b/i.test(line) && /\bdo not (?:edit|modify)\b/i.test(line),
  },
  {
    id: 'auto-generated-banner',
    test: line => SCHEMA_COMMENT_LEAD.test(line)
      && /<auto-generated\b|\bauto-?generated file\b|\bthis file (?:is|was|has been) (?:automatically |auto-?)?generated\b|\b(?:auto[- ]?generated|automatically generated) by\b/i.test(line),
  },
];

/**
 * The file's leading comment block: lines up to the first one that is neither blank nor a comment
 * (the Go rule — the marker comes before the first non-comment text), within the scan bounds. A
 * marker inside a type's description, or after the declarations begin, is therefore never read.
 */
function schemaHeaderLines(head: string): string[] {
  const out: string[] = [];
  let inBlock: '*/' | '-->' | null = null;
  const lines = head.slice(0, SCHEMA_PROVENANCE_HEAD_BYTES).replace(/^\uFEFF/, '').split('\n').slice(0, SCHEMA_PROVENANCE_HEAD_LINES);
  if (lines.length && SCHEMA_HEADER_PREAMBLE.test(lines[0].replace(/\r$/, ''))) lines.shift();
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (inBlock) {
      out.push(SCHEMA_COMMENT_LEAD.test(line) ? line : `${inBlock === '-->' ? '<!--' : '*'} ${line.trimStart()}`);
      if (line.includes(inBlock)) inBlock = null;
      continue;
    }
    if (line.trim() === '') continue;
    if (!SCHEMA_COMMENT_LEAD.test(line)) break;
    out.push(line);
    const t = line.trimStart();
    if (t.startsWith('/*') && !t.slice(2).includes('*/')) inBlock = '*/';
    else if (t.startsWith('<!--') && !t.slice(4).includes('-->')) inBlock = '-->';
  }
  return out;
}

/** The first header marker that matches, by the closed list's order; null when none does. */
export function matchSchemaHeaderMarker(head: string): string | null {
  const lines = schemaHeaderLines(head);
  for (const marker of GENERATED_SCHEMA_HEADER_MARKERS) {
    if (lines.some(l => marker.test(l))) return marker.id;
  }
  return null;
}

/** Path patterns, in the guard's order and under the guard's names. */
const SCHEMA_PATH_PATTERNS: ReadonlyArray<{ kind: SchemaProvenanceKind; matched: string; test: (p: string) => boolean }> = [
  { kind: 'vendored', matched: 'node_modules/', test: p => p.includes('/node_modules/') },
  { kind: 'vendored', matched: 'vendor/', test: p => p.includes('/vendor/') },
  { kind: 'vendored', matched: 'vendored/', test: p => p.includes('/vendored/') },
  { kind: 'vendored', matched: 'third_party/', test: p => p.includes('/third_party/') || p.includes('/third-party/') },
  { kind: 'generated', matched: '*.generated.*', test: p => p.includes('.generated.') },
  { kind: 'generated', matched: '__generated__/', test: p => p.includes('/__generated__/') },
  { kind: 'generated', matched: 'generated/', test: p => p.includes('/generated/') },
];

/** The path pattern a schema path matches, at `path-pattern` certainty; null when none does. */
export function schemaPathProvenance(path: string): SchemaProvenance | null {
  // Lower-cased once: every pattern is case-insensitive, and `.includes` stays linear.
  const p = ('/' + path.replace(/\\/g, '/').replace(/^\/+/, '')).toLowerCase();
  for (const pattern of SCHEMA_PATH_PATTERNS) {
    if (pattern.test(p)) return { kind: pattern.kind, matched: pattern.matched, certainty: 'path-pattern' };
  }
  return null;
}

/**
 * The provenance of one schema file: its own header first (`declared`), then its path
 * (`path-pattern`). `head` is a BOUNDED head of the file — never the whole text. Null means
 * neither rule matched, which is "not detected", never "hand-written for certain".
 */
export function schemaProvenance(path: string, head?: string): SchemaProvenance | null {
  if (head) {
    const marker = matchSchemaHeaderMarker(head);
    if (marker) return { kind: 'generated', matched: marker, certainty: 'declared' };
  }
  return schemaPathProvenance(path);
}
