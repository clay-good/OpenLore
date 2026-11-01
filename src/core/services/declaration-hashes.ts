/**
 * Canonical hashes for the declarations a session reads (change: add-ledger-contract-hashes).
 *
 * The session ledger tracks code symbols by a normalized content hash, so a reformat is not a
 * change and a real edit is. An agent that was served `POST /v1/checkout` from `openapi.yaml`, or
 * an infrastructure resource, deserves the same: a note that names the ELEMENT a teammate changed,
 * not the file it lives in — and no note at all when the file was merely re-indented.
 *
 * Two element kinds, each hashed from what its reader actually parses:
 *
 * - **An OpenAPI/Swagger operation** is hashed over its parsed model with the sorted keys the
 *   reader already produces (method, path, `operationId`, deprecation, parameters, request body,
 *   success response — each carrying the reader's own Merkle hash of the schema it references).
 *   The declaration LINE is deliberately not in the hash: an operation added above does not change
 *   the one below it.
 * - **An infrastructure resource** is hashed over the normalized text of its declared span, which
 *   is where its property values live — the normalized IaC model keeps a resource's address, type,
 *   module, declaration header and references, not every property. A resource whose span the
 *   extractor did not close falls back to that parsed model, which is a weaker hash: a changed
 *   property value inside it is not seen. Both cases are whitespace-insensitive.
 *
 * Deterministic and offline: the same readers the index uses, no second grammar, no LLM.
 */

import { createHash } from 'node:crypto';
import { readOpenApi, looksLikeOpenApi } from '../analyzer/contract/openapi.js';
import { isIacLanguage } from '../analyzer/iac/types.js';
import { classifyYaml, isDockerfilePath } from '../analyzer/iac/index.js';
import { detectLanguage } from '../analyzer/language-detection.js';

/** One declaration's hash, in the shape the ledger's hasher returns. */
export interface DeclarationHash { name: string; hash: string; kind: 'contract' | 'iac' }

const sha = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);

/** JSON with every object's keys sorted, so the hash cannot depend on a reader's field order. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}
/** Whitespace-insensitive: a re-indent, a re-wrap, or CRLF is not a change. */
const normalize = (s: string): string => s.replace(/\s+/g, ' ').trim();

/**
 * The IaC language a file is, for hashing: the extension-detected one, then the content-based
 * YAML/JSON disambiguation the analyze walk uses. `null` when the file is not infrastructure.
 * (A Helm chart member, which needs the whole file set to resolve, is not classified here: its
 * `Chart.yaml` is, and a template is hashed as a whole file.)
 */
export function resolveIacLanguage(file: string, content: string): string | null {
  const detected = detectLanguage(file);
  if (isIacLanguage(detected)) return detected;
  if (isDockerfilePath(file)) return 'Dockerfile';
  if (/\.(?:ya?ml|json)$/i.test(file)) return classifyYaml(file, content);
  return null;
}

/**
 * One entry per operation a specification declares, keyed `<file>::<METHOD path>` — the same id
 * the graph projection gives the operation node. `undefined` when the file is not a readable
 * specification, so the caller can fall back to its whole-file hash rather than report nothing.
 */
export function hashContractOperations(file: string, content: string): Map<string, DeclarationHash> | undefined {
  if (!looksLikeOpenApi(content)) return undefined;
  const doc = readOpenApi(file, content);
  if (!doc || 'error' in doc) return undefined;
  const out = new Map<string, DeclarationHash>();
  for (const op of doc.operations) {
    // Everything the reader parsed about the operation EXCEPT where it sits in the file: an
    // operation added above this one does not change it.
    const fields = Object.fromEntries(Object.entries(op).filter(([k]) => k !== 'line'));
    out.set(`${file}::${op.address}`, { name: op.address, hash: sha(canonical(fields)), kind: 'contract' });
  }
  return out.size ? out : undefined;
}

/**
 * One entry per infrastructure resource a file declares, keyed `<file>::<address>` — the same id
 * the IaC projection gives the resource node. `undefined` when the file declares none.
 */
export async function hashIacResources(
  file: string,
  content: string,
  language: string,
): Promise<Map<string, DeclarationHash> | undefined> {
  if (!isIacLanguage(language)) return undefined;
  const { buildIacGraph } = await import('../analyzer/iac/index.js');
  const graph = buildIacGraph([{ path: file, content, language }]);
  const resources = graph.resources.filter(r => r.filePath === file && !r.isExternal);
  if (!resources.length) return undefined;
  const lines = content.split('\n');
  // References out of each resource, so a changed dependency is a change to the dependent.
  const refs = new Map<string, string[]>();
  for (const ref of graph.references) {
    refs.set(ref.fromAddress, [...(refs.get(ref.fromAddress) ?? []), `${ref.kind} ${ref.toAddress}`]);
  }
  const out = new Map<string, DeclarationHash>();
  for (const r of resources) {
    const span = r.endLine !== undefined && r.endLine >= r.startLine
      ? normalize(lines.slice(r.startLine - 1, r.endLine).join('\n'))
      : undefined;
    const parsed = canonical({
      address: r.address, type: r.type, kind: r.kind, module: r.module ?? null,
      signature: normalize(r.signature), deploys: r.deploys ?? null,
      references: (refs.get(r.address) ?? []).slice().sort(),
    });
    out.set(`${file}::${r.address}`, {
      name: r.displayName ?? r.address,
      hash: sha(span !== undefined ? `span:${span}` : `parsed:${parsed}`),
      kind: 'iac',
    });
  }
  return out;
}
