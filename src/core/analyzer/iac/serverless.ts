/**
 * Serverless Framework extraction (change: add-iac-deploy-binding-commands).
 *
 * A `serverless.yml` declares functions the same way a SAM template does — `functions.<name>`
 * with a `<module>.<export>` handler — so each function becomes a resource carrying the `deploys`
 * binding the shared deploy binder already resolves against indexed source.
 *
 * A manifest's own `resources.Resources` block is CloudFormation written inside a Serverless file,
 * and it is read by NOBODY: dispatch is by language tag, so the CloudFormation extractor never
 * sees a file tagged `Serverless` (and its own probe requires `Resources:` at the top level, which
 * this is not). Those resources are therefore absent from the graph, not read elsewhere.
 *
 * Static only: no plugin execution, no `${...}` variable resolution, no `sls package`. A handler
 * behind a variable, a container image, or a runtime nothing binds is recorded as an unresolved
 * binding with the reason, never dropped silently. A file the YAML parser reports errors for — a
 * `---`-separated multi-document file among them, which the framework does not accept either — is
 * skipped whole, as every other ecosystem's reader skips an unparseable file.
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
 * `functions` block. A cheap corroboration so a same-named file is not misclassified — it accepts
 * the JSON spelling too (a quoted, indented key), since the framework reads `serverless.json`.
 * The file name has already been matched by {@link isServerlessPath}, so leading whitespace is no
 * risk here.
 */
export function looksLikeServerless(content: string): boolean {
  const key = (name: string) => new RegExp(`(?:^|[\\n{,])[ \\t]*["']?${name}["']?[ \\t]*:`).test(content);
  return key('service') || (key('provider') && key('functions'));
}

export function extractServerless(files: readonly InFile[]): IacGraph {
  const graph = emptyIacGraph();
  for (const file of files) {
    if (!isServerlessPath(file.path) || !looksLikeServerless(file.content)) continue;
    const lc = new LineCounter();
    let doc;
    let js: Record<string, unknown> | null;
    try {
      // `merge: true`: a shared-config anchor (`<<: *defaults`) is common in a real manifest, and
      // without it the handler it supplies reads as absent — a confident wrong reason.
      doc = parseDocument(file.content, { lineCounter: lc, uniqueKeys: false, merge: true });
      if (doc.errors.length) continue;
      // INSIDE the try: `toJS` is what throws on an excessive alias count, and an escape here
      // would abort `buildIacGraph` for the WHOLE repository — every other ecosystem's resources
      // with it, silently (change: add-serverless-and-build-output-binding).
      js = doc.toJS({ maxAliasCount: 100 }) as Record<string, unknown> | null;
    } catch {
      continue;
    }
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
    const entries = functions && typeof functions === 'object' && !Array.isArray(functions)
      ? Object.entries(functions as Record<string, unknown>) : [];
    for (const [name, body] of entries) {
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
