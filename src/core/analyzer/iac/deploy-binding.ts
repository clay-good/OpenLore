/**
 * Deploy binding: which indexed function a function resource runs (change: add-iac-deploy-binding).
 *
 * A Lambda (Terraform `aws_lambda_function.handler`, CloudFormation/SAM `Handler` with `CodeUri`)
 * names its code as `<module>.<export>`: `src/orders.handler`, `app.lambda_handler`,
 * `pkg.module.handler`. The module is resolved literally against the indexed source files, relative
 * to the code location, the repository root, and the template's directory; the export must be a
 * function indexed in that file. The result is a `deploys_symbol` edge from the resource to the
 * function, so impact reaches the infrastructure and the function counts as deployed (live).
 *
 * Nothing is matched by similarity. A handler that is not a literal, names no indexed file (a
 * build-output path such as `dist/…`, a package outside the repository), or names no indexed
 * function in it is returned as an unresolved binding with the reason, never dropped silently.
 */

import { posix } from 'node:path';
import type { CallEdge, FunctionNode } from '../call-graph-types.js';
import type { IacGraph } from './types.js';

export interface UnresolvedDeployBinding {
  resource: string;
  file: string;
  line: number;
  handler?: string;
  reason: string;
}

const NODE_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'];
const PY_EXT = ['.py'];
const HANDLER = /^[\w./@-]+\.[A-Za-z_$][\w$]*$/;

const clean = (p: string) => posix.normalize(p.replace(/\\/g, '/')).replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');

/** The source extensions a runtime runs, or why the runtime cannot be bound. */
function runtimeExtensions(runtime: string | undefined): { ext: string[]; python?: boolean } | { reason: string } {
  if (!runtime) return { ext: [...NODE_EXT, ...PY_EXT] };
  if (/^nodejs/i.test(runtime)) return { ext: NODE_EXT };
  if (/^python/i.test(runtime)) return { ext: PY_EXT, python: true };
  return { reason: `the ${runtime} runtime is not bound (only Node.js and Python handlers are)` };
}

/** Every indexed file a module path can name, across the bases and extensions. */
function moduleFiles(module: string, bases: readonly string[], ext: readonly string[], python: boolean | undefined, files: ReadonlySet<string>): string[] {
  // Python imports `pkg.mod` from `pkg/mod.py`; a Node module path is a file path.
  const variants = python ? [module.replace(/\./g, '/')] : [...new Set([module, module.replace(/\./g, '/')])];
  const out = new Set<string>();
  for (const base of bases) {
    for (const v of variants) {
      const stem = clean(base ? `${base}/${v}` : v);
      if (stem.startsWith('..')) continue;
      for (const e of ext) {
        if (files.has(`${stem}${e}`)) out.add(`${stem}${e}`);
        if (files.has(`${stem}/index${e}`)) out.add(`${stem}/index${e}`);
      }
    }
  }
  return [...out].sort();
}

export function bindDeployHandlers(
  graph: IacGraph,
  codeNodes: readonly FunctionNode[],
): { edges: CallEdge[]; unresolved: UnresolvedDeployBinding[] } {
  const byFile = new Map<string, FunctionNode[]>();
  for (const n of codeNodes) (byFile.get(n.filePath) ?? byFile.set(n.filePath, []).get(n.filePath)!).push(n);
  const files = new Set(byFile.keys());
  const edges: CallEdge[] = [];
  const unresolved: UnresolvedDeployBinding[] = [];
  for (const r of graph.resources) {
    if (!r.deploys) continue;
    const at = { resource: r.address, file: r.filePath, line: r.startLine };
    if (r.deploys.unresolved || !r.deploys.handler) {
      unresolved.push({ ...at, reason: r.deploys.unresolved ?? 'no handler' });
      continue;
    }
    if (r.isExternal) continue;
    const handler = r.deploys.handler.trim();
    const rt = runtimeExtensions(r.deploys.runtime);
    if ('reason' in rt) { unresolved.push({ ...at, handler, reason: rt.reason }); continue; }
    if (!HANDLER.test(handler)) { unresolved.push({ ...at, handler, reason: 'not a <module>.<export> handler' }); continue; }
    const dot = handler.lastIndexOf('.');
    const [module, fn] = [handler.slice(0, dot), handler.slice(dot + 1)];
    const templateDir = posix.dirname(r.filePath.replace(/\\/g, '/'));
    const codeUri = r.deploys.codeUri !== undefined ? clean(r.deploys.codeUri) : undefined;
    let bases: string[];
    if (codeUri !== undefined) {
      // A known code location is the only place the module can be (relative to the template).
      bases = [...new Set([clean(templateDir === '.' ? codeUri || '.' : `${templateDir}/${codeUri}`), codeUri])].map(b => (b === '.' ? '' : b));
    } else if (r.language === 'CloudFormation') {
      bases = [templateDir === '.' ? '' : templateDir];
    } else {
      // Terraform without a source directory names a path inside a package built elsewhere: only a
      // module path specific enough to name one file (a directory in it) is bound.
      if (!module.includes('/')) { unresolved.push({ ...at, handler, reason: 'no code location (source_dir) and the module path names no directory' }); continue; }
      bases = ['', templateDir === '.' ? '' : templateDir];
    }
    const candidates = moduleFiles(module, [...new Set(bases)], rt.ext, rt.python, files);
    if (!candidates.length) {
      unresolved.push({ ...at, handler, reason: /^(?:dist|build|out|lib|\.aws-sam)\//.test(module) ? 'a build-output path with no indexed source' : `no indexed source file for module "${module}"${codeUri !== undefined ? ` under ${codeUri || '.'}` : ''}` });
      continue;
    }
    if (candidates.length > 1) { unresolved.push({ ...at, handler, reason: `the module matches more than one file (${candidates.slice(0, 3).join(', ')})` }); continue; }
    const file = candidates[0];
    // A Lambda handler is a top-level export: a class method of the same name is not one.
    const target = (byFile.get(file) ?? []).filter(n => n.name === fn && !n.className);
    if (target.length !== 1) {
      unresolved.push({ ...at, handler, reason: target.length ? `"${fn}" is defined more than once in ${file}` : `no top-level function "${fn}" in ${file}` });
      continue;
    }
    edges.push({
      callerId: `${r.filePath}::${r.address}`,
      calleeId: target[0].id,
      calleeName: target[0].name,
      line: r.startLine,
      confidence: 'import',
      kind: 'deploys_symbol',
    });
  }
  return { edges, unresolved };
}
