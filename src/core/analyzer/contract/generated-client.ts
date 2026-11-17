/**
 * Which modules declare a specification as the source they were generated from
 * (change: add-contract-graph-projection).
 *
 * A generated API client builds its URL from a base variable —
 * `fetch(`${BASE}/orders/${id}`)` — so the HTTP projection sees no literal path and binds
 * nothing: the operation it calls reads as consumed by no one, which is false. Its method name,
 * though, IS the `operationId`, and that is an exact identifier rather than a resemblance.
 *
 * The signal used here is the module's own HEADER NAMING THE SPECIFICATION, not "does this look
 * generated". That matters for soundness: binding by name alone would tie a hand-written
 * `getOrder` to an operation it has nothing to do with, and a wrong edge is worse than a missing
 * one. A file that says in its first lines that it comes from `api/openapi.yaml` is claiming
 * exactly the relationship the binding needs — whether a generator or a person wrote the claim.
 *
 * Deliberately NOT the `generated-file-guard` classifier: that lives in the service layer, which
 * the analyzer may not import, and it answers a broader question (gitattributes, lockfiles, path
 * patterns) for the edit guard. This asks one narrow thing of text the builder already holds.
 */

/** How far into a file a source-naming header is looked for. */
const HEADER_LINES = 40;
const HEADER_BYTES = 8 * 1024;

/** A line that opens with a comment token, in the languages a generated client is written in. */
const COMMENT_LINE = /^\s*(?:\/\/+!?|#+!?|\/\*+!?|\*+|--+|;+|<!--|%+)/;

/**
 * A marker that makes a line a GENERATION CLAIM rather than a mention.
 *
 * Without this, "// See api/openapi.yaml for the wire contract these mirror." on a hand-written
 * module bound its functions to that document's operations — the exact wrong edge this rule
 * exists to avoid. A prose reference to a specification is not a statement that the file was
 * produced from it.
 */
const GENERATION_CLAIM = /@generated\b|\bauto-?generated\b|\bgenerated (?:by|from|with)\b|\bcode generated\b|\bdo not (?:edit|modify)\b|\bopenapi[- ]?generator\b|\bswagger[- ]?codegen\b/i;

/**
 * Whether `specPath` appears in `content`'s header as a path, on path boundaries.
 *
 * A plain `includes` of the base name let one specification's header match ANOTHER
 * specification whose base name is a substring of it: with `api/openapi.yaml` and
 * `third-party/stripe/openapi.yaml` — `openapi.yaml` is far and away the common filename — a
 * client whose header named the first bound to the operations of BOTH, and the graph then
 * asserted the repository called Stripe. The reference must END at the path, and begin at a
 * separator, so `api/openapi.yaml` matches `.../api/openapi.yaml` and never
 * `third-party/stripe/openapi.yaml`.
 */
function namesPath(line: string, specPath: string): boolean {
  let from = 0;
  for (;;) {
    const at = line.indexOf(specPath, from);
    if (at < 0) return false;
    const before = at === 0 ? '' : line[at - 1];
    const rest = line.slice(at + specPath.length);
    // Not preceded by a path character, so a longer path ending in this one does not count.
    // Not CONTINUED by one either — `openapi.yaml.bak` is a different file — but a trailing
    // `.` that ends a sentence is punctuation, not a path: "generated from openapi.yaml. DO NOT
    // EDIT." is the Go convention's own wording and must match.
    const continues = /^[\w/\\-]/.test(rest) || /^\.\w/.test(rest);
    if (!/[\w./\\-]/.test(before) && !continues) return true;
    from = at + 1;
  }
}

/**
 * Whether `content`'s header declares `specPath` as the source it was generated from.
 *
 * Three conditions, each closing a wrong edge found by review:
 *   1. the reference is in a COMMENT in the header — a path in ordinary code (a loader that
 *      reads the specification at runtime, a string constant, a fixture path) is not a claim;
 *   2. the same line carries a GENERATION marker — a prose mention is not a claim;
 *   3. the reference matches on path boundaries — one specification's header never names another
 *      whose base name is a substring of it.
 */
export function headerNamesSpec(content: string, specPath: string): boolean {
  const head = content.length > HEADER_BYTES ? content.slice(0, HEADER_BYTES) : content;
  const lines = head.split('\n', HEADER_LINES);
  const base = specPath.slice(specPath.lastIndexOf('/') + 1);
  for (const line of lines) {
    if (!COMMENT_LINE.test(line)) continue;
    if (!GENERATION_CLAIM.test(line)) continue;
    // The full path always counts. The bare base name counts only on a path boundary, and the
    // caller decides whether it is unambiguous across the specifications it read.
    if (namesPath(line, specPath) || namesPath(line, base)) return true;
  }
  return false;
}

/**
 * For one specification, the functions of every module whose header names it, indexed by
 * function name.
 *
 * Returns an empty map when no module names it — the overwhelmingly common case, which costs one
 * header slice per candidate file and no parsing.
 */
export function generatedClientFunctionsFor<T extends { name: string; filePath: string }>(
  specPath: string,
  codeNodesByFile: ReadonlyMap<string, readonly T[]>,
  contentOf: (file: string) => string | undefined,
  /** Whether a file is a test, excluded below. Injected so this module stays dependency-free. */
  isTest: (file: string) => boolean = () => false,
): ReadonlyMap<string, readonly T[]> {
  const byName = new Map<string, T[]>();
  for (const [file, nodes] of codeNodesByFile) {
    // A specification never declares itself its own generated client.
    if (file === specPath) continue;
    // Nor does a test or fixture module. One whose header mentions the specification for
    // conformance bound its own helpers to the operations — and a short `operationId` such as
    // `list` collides readily.
    if (isTest(file)) continue;
    const content = contentOf(file);
    if (content === undefined || !headerNamesSpec(content, specPath)) continue;
    for (const node of nodes) {
      const at = byName.get(node.name);
      if (at) at.push(node); else byName.set(node.name, [node]);
    }
  }
  return byName;
}
