/**
 * Serverless Framework extraction (change: add-iac-deploy-binding-commands).
 *
 * A `serverless.yml` declares functions the same way a SAM template does — `functions.<name>`
 * with a `<module>.<export>` handler — so each function becomes a resource carrying the `deploys`
 * binding the shared deploy binder already resolves against indexed source. Its resources
 * (`resources.Resources.*`) are CloudFormation and are read by that extractor, not here.
 *
 * Static only: no plugin execution, no `${...}` variable resolution, no `sls package`. A handler
 * behind a variable, a container image, or a runtime nothing binds is recorded as an unresolved
 * binding with the reason, never dropped silently.
 */

import { LineCounter, parseDocument } from 'yaml';
import type { IacGraph, IacResource } from './types.js';
import { emptyIacGraph } from './types.js';

interface InFile { path: string; content: string; language?: string }

const LANG = 'Serverless';

/** A `${…}` Serverless variable: its value is resolved at deploy time, not here. */
const VARIABLE = /\$\{[^}]*\}/;

/**
 * Whether a path names a Serverless service manifest. The framework reads exactly these names
 * (plus `--config`, which is not in the repository's own layout).
 */
export function isServerlessPath(path: string): boolean {
  const base = path.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
  return base === 'serverless.yml' || base === 'serverless.yaml' || base === 'serverless.json';
}

/**
 * Whether a file's text declares a Serverless service: a `service` key, or a `provider` with a
 * `functions` block. A cheap corroboration so a same-named file is not misclassified.
 */
export function looksLikeServerless(content: string): boolean {
  return /(^|\n)service[ \t]*:/.test(content)
    || (/(^|\n)provider[ \t]*:/.test(content) && /(^|\n)functions[ \t]*:/.test(content));
}

export function extractServerless(files: readonly InFile[]): IacGraph {
  const graph = emptyIacGraph();
  for (const file of files) {
    if (!isServerlessPath(file.path) || !looksLikeServerless(file.content)) continue;
    const lc = new LineCounter();
    let doc;
    try {
      doc = parseDocument(file.content, { lineCounter: lc, uniqueKeys: false });
      if (doc.errors.length) continue;
    } catch {
      continue;
    }
    const js = doc.toJS({ maxAliasCount: 100 }) as Record<string, unknown> | null;
    if (!js || typeof js !== 'object') continue;
    const lineOf = (path: (string | number)[]): number => {
      const node = doc.getIn(path, true) as { range?: [number, number, number] } | undefined;
      const off = node?.range?.[0];
      return off != null ? lc.linePos(off).line : 1;
    };

    const provider = (js.provider ?? {}) as Record<string, unknown>;
    const service = typeof js.service === 'string' ? js.service
      : typeof (js.service as Record<string, unknown> | undefined)?.name === 'string'
        ? String((js.service as Record<string, unknown>).name) : undefined;
    // The service manifest itself, so a function groups under something nameable.
    graph.resources.push({
      address: `${file.path}::service`,
      displayName: service ? `service.${service}` : 'service',
      type: 'serverless:service',
      kind: 'stack',
      filePath: file.path,
      startLine: typeof js.service === 'string' ? lineOf(['service']) : 1,
      signature: `service: ${service ?? '(unnamed)'}`,
      language: LANG,
    });

    const providerRuntime = typeof provider.runtime === 'string' ? provider.runtime : undefined;
    const functions = js.functions;
    if (!functions || typeof functions !== 'object' || Array.isArray(functions)) continue;
    for (const [name, body] of Object.entries(functions as Record<string, unknown>)) {
      const fn = (body ?? {}) as Record<string, unknown>;
      const startLine = lineOf(['functions', name]);
      const resource: IacResource = {
        address: `${file.path}::function.${name}`,
        displayName: `function.${name}`,
        type: 'serverless:function',
        kind: 'resource',
        filePath: file.path,
        startLine,
        module: `${file.path}::service`,
        signature: `functions.${name}`,
        language: LANG,
      };
      const runtime = typeof fn.runtime === 'string' ? fn.runtime : providerRuntime;
      const handler = fn.handler;
      if (fn.image !== undefined) {
        resource.deploys = { unresolved: 'the function runs a container image, not source in this repository' };
      } else if (handler === undefined) {
        resource.deploys = { unresolved: 'the function declares no handler' };
      } else if (typeof handler !== 'string') {
        resource.deploys = { unresolved: 'the handler is not a literal' };
      } else if (VARIABLE.test(handler)) {
        resource.deploys = { unresolved: 'the handler is built from a Serverless variable' };
      } else {
        resource.deploys = { handler, ...(runtime ? { runtime } : {}) };
      }
      graph.resources.push(resource);
      graph.references.push({ fromAddress: resource.address, toAddress: `${file.path}::service`, kind: 'depends_on', line: startLine });
    }
    graph.modules.push({
      address: `${file.path}::service`,
      displayName: service ? `service.${service}` : 'service',
      type: 'serverless:service',
      filePath: file.path,
      members: graph.resources.filter(r => r.module === `${file.path}::service`).map(r => r.address),
      language: LANG,
    });
  }
  return graph;
}
