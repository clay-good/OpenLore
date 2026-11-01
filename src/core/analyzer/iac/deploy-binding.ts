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

const SOURCE_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.py'];
const HANDLER = /^[\w./@-]+\.[A-Za-z_$][\w$]*$/;

const clean = (p: string) => posix.normalize(p.replace(/\\/g, '/')).replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');

/** The indexed file a module path names, trying each base and source extension. */
function moduleFile(module: string, bases: readonly string[], files: ReadonlySet<string>): string | undefined {
  const variants = [...new Set([module, module.replace(/\./g, '/')])];
  for (const base of bases) {
    for (const v of variants) {
      const stem = clean(base ? `${base}/${v}` : v);
      if (stem.startsWith('..')) continue;
      for (const ext of SOURCE_EXT) {
        if (files.has(`${stem}${ext}`)) return `${stem}${ext}`;
        if (files.has(`${stem}/index${ext}`)) return `${stem}/index${ext}`;
      }
    }
  }
  return undefined;
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
    if (!r.deploys || r.isExternal) continue;
    const at = { resource: r.address, file: r.filePath, line: r.startLine };
    if (r.deploys.unresolved || !r.deploys.handler) {
      unresolved.push({ ...at, reason: r.deploys.unresolved ?? 'no handler' });
      continue;
    }
    const handler = r.deploys.handler.trim();
    if (!HANDLER.test(handler)) { unresolved.push({ ...at, handler, reason: 'not a <module>.<export> handler' }); continue; }
    const dot = handler.lastIndexOf('.');
    const [module, fn] = [handler.slice(0, dot), handler.slice(dot + 1)];
    const templateDir = posix.dirname(r.filePath.replace(/\\/g, '/'));
    const codeUri = r.deploys.codeUri ? clean(r.deploys.codeUri) : undefined;
    // CloudFormation/SAM paths are relative to the template; a Terraform handler names a path inside
    // the deployed package, whose source is usually at the repository root or beside the module.
    const bases = [...new Set([
      ...(codeUri !== undefined ? [clean(templateDir === '.' ? codeUri : `${templateDir}/${codeUri}`), codeUri] : []),
      '',
      templateDir === '.' ? '' : templateDir,
    ])];
    const file = moduleFile(module, bases, files);
    if (!file) {
      unresolved.push({ ...at, handler, reason: /^(?:dist|build|out|lib|\.aws-sam)\//.test(module) ? 'a build-output path with no indexed source' : `no indexed source file for module "${module}"` });
      continue;
    }
    const target = (byFile.get(file) ?? []).filter(n => n.name === fn);
    if (target.length !== 1) {
      unresolved.push({ ...at, handler, reason: target.length ? `"${fn}" is defined more than once in ${file}` : `no indexed function "${fn}" in ${file}` });
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
