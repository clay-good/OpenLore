/**
 * Framework route handlers as liveness roots, joined from the route inventory
 * (change: root-framework-routes).
 *
 * `get_route_inventory` and `find_dead_code` read the same build and must not
 * contradict each other. The liveness roots in `reachability.ts` are built only
 * from graph EDGES (`http_endpoint`, `deploys_symbol`, `implements_endpoint`, and
 * synthesized `route-handler` edges), and a framework-decorator route whose
 * contract is not declared anywhere (`contractSource: "none"`) produces none of
 * them — so a `@Get('broadcast')` handler that only Nest invokes read as
 * high-confidence dead while the inventory listed it as a route.
 *
 * `route-inventory.json` is already on disk from `analyze`, so this is a JOIN, not
 * new analysis: each inventoried route is resolved to a graph node by file +
 * handler name.
 *
 * HONEST BY CONSTRUCTION — a root attributed to the wrong node is worse than a
 * disclosed unresolved handler, because it makes real dead code look live. So a
 * handler is a root ONLY when it pins to exactly one declaration in that file.
 * Every other outcome (several declarations, none, a file not in the index, an
 * unnamed handler, a path outside the repository, a route past the cap) is
 * counted and named in {@link RouteRootsNotAssessed}, never guessed — because an
 * inventoried route whose handler cannot be pinned leaves real code looking dead.
 */

import { posix } from 'node:path';
import { join } from 'node:path';
import { emittedText } from '../generated-file-guard.js';
import { ANALYSIS_ARTIFACT_MAX_BYTES, readArtifactBounded } from '../../../utils/bounded-artifact-read.js';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_ROUTE_INVENTORY } from '../../../constants.js';

/** Routes joined in one answer. A repository-controlled count, so it is bounded and the cap disclosed. */
export const MAX_ROUTES_JOINED = 50_000;
/** Longest handler name matched. A longer one cannot be a declaration name, so it is not matched. */
export const MAX_HANDLER_NAME_CHARS = 256;
/** Unresolved routes listed individually; the rest are counted. */
export const MAX_UNRESOLVED_LISTED = 10;

/** Why an inventoried route kept no function live. A closed set. */
export type RouteRootRefusal =
  /** The route names no handler, or a name too long to be a declaration. */
  | 'handler-not-named'
  /** The route's file is absolute, or escapes the repository root. */
  | 'outside-repository'
  /** No indexed function lives in that file (not parsed, excluded, or deleted since). */
  | 'file-not-indexed'
  /** The file is indexed but holds no declaration of that name. */
  | 'handler-not-in-file'
  /** Several declarations of that name in that file — none is selected. */
  | 'ambiguous'
  /** Past {@link MAX_ROUTES_JOINED}. */
  | 'over-cap';

export interface RouteRootsNotAssessed {
  total: number;
  byReason: Partial<Record<RouteRootRefusal, number>>;
  items: Array<{ method: string; path: string; framework: string; file: string; handler: string; reason: RouteRootRefusal }>;
  note: string;
}

export interface RouteInventoryRoots {
  /** Node ids an inventoried route pins to exactly one declaration — liveness roots. */
  rootIds: Set<string>;
  /**
   * Node ids an inventoried handler NAMES but could not be pinned to (the several
   * same-named declarations of an `ambiguous` route). Not roots — but the inventory
   * says one of them serves a route, so none may be asserted high-confidence dead
   * and none may be told it is "not a route handler".
   */
  namedButUnresolvedIds: Set<string>;
  /** Routes read from the artifact (0 when it is absent or unreadable). */
  routesRead: number;
  /** Resolved roots per inventory `framework`, for the roots receipt. */
  byFramework: Record<string, number>;
  /** Present when a route kept no function live. */
  notAssessed?: RouteRootsNotAssessed;
  /**
   * Present when the artifact could not be read as a route inventory: the answer then
   * degrades to the edge-only roots it had before this join, and says so.
   */
  artifactBoundary?: string;
}

/** A graph node, as much of it as the join reads. */
export interface JoinableNode {
  id: string;
  name: string;
  filePath: string;
}

const EMPTY: RouteInventoryRoots = {
  rootIds: new Set(), namedButUnresolvedIds: new Set(), routesRead: 0, byFramework: {},
};

/** One route, as far as the join trusts the (repository-controlled) artifact. */
interface RawRoute { method: string; path: string; framework: string; file: string; handler: string }

/**
 * A graph file path and an inventory file path in ONE spelling: forward slashes, no
 * `./` prefix. Both sides are repo-relative, so this is the whole normalization —
 * there is deliberately no suffix or basename fallback, because a basename match is
 * exactly the guess that attributes a root to the wrong node.
 */
export function routeFileKey(filePath: string): string {
  return filePath.replaceAll('\\', '/').replace(/^\.\//, '');
}

/** A repo-relative path that stays inside the repository. */
function insideRepo(key: string): boolean {
  if (key === '' || key.startsWith('/') || /^[A-Za-z]:/.test(key)) return false;
  return !posix.normalize(key).startsWith('..');
}

/**
 * Resolve the inventory's handlers against the graph. O(nodes + routes): the file →
 * name → ids index is built once, and each route is a constant-time lookup.
 */
export function buildRouteInventoryRoots(routes: readonly RawRoute[], nodes: readonly JoinableNode[]): RouteInventoryRoots {
  const rootIds = new Set<string>();
  const namedButUnresolvedIds = new Set<string>();
  const byFramework: Record<string, number> = {};
  const byReason: Partial<Record<RouteRootRefusal, number>> = {};
  const items: RouteRootsNotAssessed['items'] = [];

  const byFile = new Map<string, Map<string, string[]>>();
  for (const n of nodes) {
    const key = routeFileKey(n.filePath);
    let names = byFile.get(key);
    if (!names) byFile.set(key, (names = new Map()));
    const ids = names.get(n.name);
    if (ids) ids.push(n.id);
    else names.set(n.name, [n.id]);
  }

  const refuse = (r: RawRoute, reason: RouteRootRefusal): void => {
    byReason[reason] = (byReason[reason] ?? 0) + 1;
    if (items.length < MAX_UNRESOLVED_LISTED) {
      items.push({
        method: emittedText(r.method), path: emittedText(r.path), framework: emittedText(r.framework),
        file: emittedText(r.file), handler: emittedText(r.handler), reason,
      });
    }
  };

  for (const [i, r] of routes.entries()) {
    if (i >= MAX_ROUTES_JOINED) { refuse(r, 'over-cap'); continue; }
    if (r.handler === '' || r.handler.length > MAX_HANDLER_NAME_CHARS) { refuse(r, 'handler-not-named'); continue; }
    const key = routeFileKey(r.file);
    if (!insideRepo(key)) { refuse(r, 'outside-repository'); continue; }
    const names = byFile.get(key);
    if (!names) { refuse(r, 'file-not-indexed'); continue; }
    const ids = names.get(r.handler);
    if (!ids || ids.length === 0) { refuse(r, 'handler-not-in-file'); continue; }
    if (ids.length > 1) {
      for (const id of ids) namedButUnresolvedIds.add(id);
      refuse(r, 'ambiguous');
      continue;
    }
    rootIds.add(ids[0]);
    byFramework[r.framework] = (byFramework[r.framework] ?? 0) + 1;
  }

  const total = Object.values(byReason).reduce((a, b) => a + b, 0);
  return {
    rootIds, namedButUnresolvedIds, routesRead: routes.length, byFramework,
    ...(total > 0 ? {
      notAssessed: {
        total, byReason, items,
        note: 'An inventoried route whose handler pins to exactly one declaration is a liveness root. These routes did NOT pin to one, so no function was rooted for them and code that really does serve a route may be listed as a candidate here. Nothing was guessed: a root attributed to the wrong declaration would make real dead code look live.',
      },
    } : {}),
  };
}

/**
 * Read `route-inventory.json` and resolve its handlers. An absent, oversized,
 * truncated, or non-JSON artifact degrades to the edge-only roots WITH a boundary —
 * it never throws and never silently reports "no routes".
 */
export async function loadRouteInventoryRoots(absDir: string, nodes: readonly JoinableNode[]): Promise<RouteInventoryRoots> {
  const path = join(absDir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_ROUTE_INVENTORY);
  const read = await readArtifactBounded(path, ANALYSIS_ARTIFACT_MAX_BYTES).catch(() => null);
  if (!read) {
    return { ...EMPTY, rootIds: new Set(), namedButUnresolvedIds: new Set(), byFramework: {},
      artifactBoundary: `\`${ARTIFACT_ROUTE_INVENTORY}\` is absent or could not be read, so framework route handlers were not rooted from the inventory and a decorator route's handler can appear dead. Run \`openlore analyze\`.` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return { ...EMPTY, rootIds: new Set(), namedButUnresolvedIds: new Set(), byFramework: {},
      artifactBoundary: `\`${ARTIFACT_ROUTE_INVENTORY}\` is not valid JSON (truncated or corrupt), so framework route handlers were not rooted from the inventory and a decorator route's handler can appear dead. Re-run \`openlore analyze\`.` };
  }
  const routesRaw = (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed))
    ? (parsed as { routes?: unknown }).routes
    : undefined;
  if (!Array.isArray(routesRaw)) {
    return { ...EMPTY, rootIds: new Set(), namedButUnresolvedIds: new Set(), byFramework: {},
      artifactBoundary: `\`${ARTIFACT_ROUTE_INVENTORY}\` does not hold a route list, so framework route handlers were not rooted from the inventory and a decorator route's handler can appear dead. Re-run \`openlore analyze\`.` };
  }

  // Every field is repository-controlled: a non-string is read as absent, never coerced.
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const routes: RawRoute[] = routesRaw.map((r): RawRoute => {
    const o = (r !== null && typeof r === 'object') ? r as Record<string, unknown> : {};
    return { method: str(o.method), path: str(o.path), framework: str(o.framework), file: str(o.file), handler: str(o.handler) };
  });
  return buildRouteInventoryRoots(routes, nodes);
}

/**
 * The per-candidate reason clause. Every inventory `framework` is an HTTP routing
 * framework (nestjs, express, fastify, nextjs-app, fastapi, flask, django,
 * starlette, spring, jaxrs, …), so these roots all count under
 * `rootKinds.httpHandlers`; no finer split is clearly true from this field alone.
 */
export function routeHandlerReason(): string {
  return 'the route inventory names a handler of this name in this file, but it resolves to several declarations — no root was attributed (see routeRootsNotAssessed), so this may well be live';
}
