/**
 * Build-output mapping for deploy bindings (change: add-iac-deploy-binding-commands).
 *
 * A deployed handler usually names the BUILT file — `dist/orders.handler`, `build/index.handler` —
 * while the graph indexes the source. Without a mapping such a handler binds to nothing and the
 * resource's code reads as absent; with one, `aws_lambda_function.orders` reaches `src/orders.ts`.
 *
 * The mapping is the project's own declaration, never a guess:
 *   - TypeScript's `compilerOptions.outDir` + `rootDir`: a path under `outDir` is the same path
 *     under `rootDir` (the rule the config-wiring adapter already applies to a `bin` entry).
 *   - A package's `main` paired with `source` (the parcel/microbundle convention): the one names
 *     the output, the other names the input.
 *
 * Only the REPOSITORY ROOT's `tsconfig.json` and `package.json` are read, and an `extends` chain
 * is not followed: a monorepo whose mapping lives in `packages/api/tsconfig.json`, or a root
 * config that inherits `rootDir` from a base, has no mapping here. The unresolved binding says
 * exactly that rather than claiming the project declares none.
 *
 * An `outDir` with no `rootDir` and no `source` maps nothing: the output path says nothing about
 * where its input lives, and a same-basename file elsewhere is a similarity match, which this
 * substrate does not make. That case is disclosed as `build-output-unmapped`, the same reason the
 * config-wiring adapter gives.
 */

import { posix } from 'node:path';

export interface BuildOutputMap {
  /** Normalized `outDir`, without a trailing slash; absent when the project declares none. */
  outDir?: string;
  /** Normalized `rootDir`; absent when the project declares none. */
  rootDir?: string;
  /** Normalized `main` → `source` pair from the package manifest, when it declares both. */
  mainToSource?: { main: string; source: string };
}

const clean = (p: string): string =>
  posix.normalize(p.replace(/\\/g, '/')).replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
const stripExt = (p: string): string => p.replace(/\.[cm]?[jt]sx?$/i, '');

/** Strip `//` and `/* *\/` comments and trailing commas: a `tsconfig.json` is JSONC. */
function parseJsonc(raw: string): Record<string, unknown> | undefined {
  // A BOM is routine from some Windows editors, and `JSON.parse` refuses it — without this a
  // BOM'd `tsconfig.json` silently left every built handler unmapped.
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Only on failure, and only outside strings, so a path containing `//` survives the first pass.
    let out = '';
    let inString = false;
    let escape = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        out += c;
        if (escape) escape = false;
        else if (c === '\\') escape = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') { inString = true; out += c; continue; }
      if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
      if (c === '/' && text[i + 1] === '*') { const end = text.indexOf('*/', i + 2); i = end === -1 ? text.length : end + 1; continue; }
      // A trailing comma, dropped HERE rather than by a regex over the whole text: a `, }` inside
      // a quoted path would otherwise be edited out of the value.
      if (c === ',') {
        let j = i + 1;
        while (j < text.length && /\s/.test(text[j])) j++;
        if (text[j] === '}' || text[j] === ']') continue;
      }
      out += c;
    }
    try {
      return JSON.parse(out) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
}

/**
 * The build-output mapping a repository declares, from its root `tsconfig.json` and
 * `package.json`. An absent or unreadable config simply contributes nothing.
 */
export function readBuildOutputMap(
  files: ReadonlyMap<string, string>,
): BuildOutputMap {
  const out: BuildOutputMap = {};
  const tsconfig = files.get('tsconfig.json');
  if (tsconfig !== undefined) {
    const parsed = parseJsonc(tsconfig);
    const options = parsed && typeof parsed.compilerOptions === 'object' && parsed.compilerOptions
      ? parsed.compilerOptions as Record<string, unknown> : {};
    if (typeof options.outDir === 'string' && clean(options.outDir) && clean(options.outDir) !== '.') out.outDir = clean(options.outDir);
    if (typeof options.rootDir === 'string') out.rootDir = clean(options.rootDir);
  }
  const pkg = files.get('package.json');
  if (pkg !== undefined) {
    const parsed = parseJsonc(pkg);
    const main = parsed && typeof parsed.main === 'string' ? clean(parsed.main) : undefined;
    const source = parsed && typeof parsed.source === 'string' ? clean(parsed.source) : undefined;
    if (main && source) out.mainToSource = { main, source };
  }
  return out;
}

/**
 * The source paths the project's declared mapping says a module path came from — repository-root
 * relative, because that is where the mapping was declared. Empty when the mapping says nothing
 * about this path.
 *
 * These are kept apart from the path itself on purpose: the path is resolved relative to the
 * template's directory as well, while a mapped stem is only ever meaningful from the root. Joining
 * a root mapping to a manifest's directory bound `dist/orders` under `services/api/` to
 * `services/src/orders.ts` for a `rootDir` of `../src` — a file the root config never described.
 */
export function mappedSourceStems(module: string, map: BuildOutputMap | undefined): string[] {
  const path = clean(module);
  if (!map) return [];
  const stems: string[] = [];
  if (map.outDir && map.rootDir !== undefined && path.startsWith(`${map.outDir}/`)) {
    const rest = path.slice(map.outDir.length + 1);
    const mapped = clean(map.rootDir && map.rootDir !== '.' ? `${map.rootDir}/${rest}` : rest);
    // A `rootDir` pointing out of the repository maps to nothing indexable.
    if (!mapped.startsWith('..')) stems.push(mapped);
  }
  if (map.mainToSource && stripExt(path) === stripExt(map.mainToSource.main)) {
    const mapped = stripExt(map.mainToSource.source);
    if (!mapped.startsWith('..')) stems.push(mapped);
  }
  return [...new Set(stems)];
}

/** Whether a module path sits under a declared `outDir` that maps to no declared input. */
export function isUnmappedBuildOutput(module: string, map: BuildOutputMap | undefined): boolean {
  const path = clean(module);
  if (!map?.outDir || !path.startsWith(`${map.outDir}/`)) return false;
  if (map.rootDir !== undefined) return false;
  return !(map.mainToSource && stripExt(path) === stripExt(map.mainToSource.main));
}
