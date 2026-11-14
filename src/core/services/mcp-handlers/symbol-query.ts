/**
 * Qualified symbol queries shared by the symbol-taking tools. A leaf module: it imports only types,
 * so any handler can use it without an import cycle.
 */
import type { FunctionNode } from '../../analyzer/call-graph.js';

/**
 * Resolve a QUALIFIED symbol — `Class.method`, `name::path`, `Class.method::path`, or an exact node
 * id (`path::Class.method`) — to the nodes it names. Returns `null` when the query has none of those
 * shapes, so a plain name keeps its existing fuzzy lookup. `Class.method` is how the generated
 * digest prints a hub (`EdgeStore.open`), and was answered "No function matching".
 */
export function resolveQualifiedSymbol<T extends Pick<FunctionNode, 'name' | 'filePath'> & { className?: string | null; isExternal?: boolean }>(
  query: string,
  byName: (name: string) => T[],
  byId: (id: string) => T | null | undefined,
): T[] | null {
  const q = query.trim();
  const sep = q.indexOf('::');
  const qualifiedName = sep >= 0 ? q.slice(0, sep) : q;
  if (sep < 0 && !/^[\w$]+\.[\w$]+$/.test(q)) return null;
  const exactId = byId(q);
  if (exactId && !exactId.isExternal) return [exactId];
  const dot = qualifiedName.lastIndexOf('.');
  const className = dot > 0 ? qualifiedName.slice(0, dot) : undefined;
  const name = dot > 0 ? qualifiedName.slice(dot + 1) : qualifiedName;
  const path = sep >= 0 ? q.slice(sep + 2).replace(/^\.\//, '') : undefined;
  const hits = byName(name).filter(n => !n.isExternal
    && (className === undefined || n.className === className)
    && (path === undefined || n.filePath === path || n.filePath.endsWith(`/${path}`)));
  // A dotted NAME is not always `Class.method`: an infrastructure resource (`aws_s3_bucket.logs`)
  // or a member-assigned function carries the dot in its own name. Nothing under the qualified
  // reading → the caller's plain lookup decides.
  return hits.length > 0 || sep >= 0 ? hits : null;
}
