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
 * Whether `content`'s header names `specPath` as a source.
 *
 * The reference must appear in a COMMENT in the header, so a specification path mentioned in
 * ordinary code — a string constant, a fixture, a loader that reads the file at runtime — is not
 * read as a generation claim. Matched on the path as written and on its base name, since a
 * generator may emit either.
 */
export function headerNamesSpec(content: string, specPath: string): boolean {
  const head = content.length > HEADER_BYTES ? content.slice(0, HEADER_BYTES) : content;
  const lines = head.split('\n', HEADER_LINES);
  const base = specPath.slice(specPath.lastIndexOf('/') + 1);
  // A bare base name is only evidence when it is specific. `openapi.yaml` is, `api.json` is not
  // much — but requiring the full path would miss the common generator banner, so the base name
  // counts and the caller's caps bound the blast radius.
  for (const line of lines) {
    if (!COMMENT_LINE.test(line)) continue;
    if (line.includes(specPath) || line.includes(base)) return true;
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
): ReadonlyMap<string, readonly T[]> {
  const byName = new Map<string, T[]>();
  for (const [file, nodes] of codeNodesByFile) {
    // A specification never declares itself its own generated client.
    if (file === specPath) continue;
    const content = contentOf(file);
    if (content === undefined || !headerNamesSpec(content, specPath)) continue;
    for (const node of nodes) {
      const at = byName.get(node.name);
      if (at) at.push(node); else byName.set(node.name, [node]);
    }
  }
  return byName;
}
