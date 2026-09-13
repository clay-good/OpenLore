/**
 * Standard MCP tool annotations are explicit and guarded (change: adopt-mcp-protocol-conformance;
 * mcp-quality: StandardToolAnnotationsAreEmittedAndGuarded).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_DEFINITIONS, toolAnnotations, ANNOTATED_TOOL_NAMES } from './mcp.js';

const SERVICES = resolve(dirname(fileURLToPath(import.meta.url)), '../../core/services');

/**
 * The entry points through which every audited user-visible write a tool can reach flows
 * (rebuildable caches — the background index repair, the BM25 sidecar — are not user-visible state).
 */
const WRITE_ENTRY_POINTS = [
  'runAnalysis', 'updateDecisionStore', 'updateMemoryStore', 'syncApprovedDecisions', 'writeTestFiles',
  'persistCertificate', 'adoptEmptyFingerprints', 'writeFile', 'mkdir', 'spawn',
];

/** The body text of a top-level function declared in a module, or undefined. */
function functionBody(source: string, name: string): string | undefined {
  const start = source.search(new RegExp(`^export (?:async )?function ${name}\\b`, 'm'));
  if (start < 0) return undefined;
  const end = source.slice(start).search(/^\}/m);
  return end < 0 ? undefined : source.slice(start, start + end);
}

/** Tool name → the handler it dispatches to and that handler's body, from `tool-dispatch.ts`. */
function dispatchTargets(): Map<string, { handler: string; body: string | undefined }> {
  const dispatch = readFileSync(join(SERVICES, 'tool-dispatch.ts'), 'utf-8');
  const importFrom = new Map<string, string>();
  for (const m of dispatch.matchAll(/import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g)) {
    for (const raw of m[1].split(',')) {
      const ident = raw.replace(/^\s*type\s+/, '').split(/\s+as\s+/).pop()!.trim();
      if (ident) importFrom.set(ident, m[2]);
    }
  }
  const targets = new Map<string, { handler: string; body: string | undefined }>();
  const branches = [...dispatch.matchAll(/name === '([a-z_]+)'\) \{/g)];
  branches.forEach((m, i) => {
    const branch = dispatch.slice(m.index, branches[i + 1]?.index ?? dispatch.length);
    const handler = /return (?:await )?([A-Za-z]\w*)\(/.exec(branch)?.[1];
    const from = handler ? importFrom.get(handler) : undefined;
    if (!handler || !from?.startsWith('.')) return;
    const module = readFileSync(join(SERVICES, from.replace(/\.js$/, '.ts')), 'utf-8');
    targets.set(m[1], { handler, body: functionBody(module, handler) });
  });
  return targets;
}

describe('tool annotation coverage', () => {
  it('every advertised tool has an explicit read/write annotation entry', () => {
    const annotated = new Set(ANNOTATED_TOOL_NAMES);
    const missing = TOOL_DEFINITIONS.map(t => t.name).filter(name => !annotated.has(name));
    expect(missing, `tools without a TOOL_ANNOTATIONS entry: ${missing.join(', ')}`).toEqual([]);
  });

  it('carries no annotation entry for a tool that is not advertised', () => {
    const defined = new Set(TOOL_DEFINITIONS.map(t => t.name));
    expect(ANNOTATED_TOOL_NAMES.filter(name => !defined.has(name))).toEqual([]);
  });

  it('never serves fallback read-only hints for a tool without an entry', () => {
    const a = toolAnnotations('a_tool_nobody_annotated');
    expect(a.readOnlyHint).toBeUndefined();
    expect(a.destructiveHint).toBeUndefined();
    expect(a.idempotentHint).toBeUndefined();
    expect(toolAnnotations('constructor').readOnlyHint).toBeUndefined();
  });
});

describe('tool annotation accuracy against the dispatch target', () => {
  const targets = dispatchTargets();
  const writes = (body: string | undefined) =>
    body !== undefined && WRITE_ENTRY_POINTS.some(entry => new RegExp(`\\b${entry}\\(`).test(body));

  it('never declares a tool read-only when its handler calls a write entry point', () => {
    const misdeclared = TOOL_DEFINITIONS.map(t => t.name)
      .filter(name => writes(targets.get(name)?.body) && toolAnnotations(name).readOnlyHint !== false);
    expect(misdeclared, `write-reaching tools not declared as writers: ${misdeclared.join(', ')}`).toEqual([]);
  });

  it('detects the audited direct writers, so the scan is not vacuous', () => {
    for (const name of ['change_impact_certificate', 'federation_status', 'record_decision', 'remember', 'analyze_codebase']) {
      expect(targets.get(name)?.body, `no dispatch target body resolved for ${name}`).toBeDefined();
      expect(writes(targets.get(name)?.body), `${name} should reach a write entry point`).toBe(true);
    }
  });

  it('resolves a dispatch target for every advertised tool except the reviewed read-only ones', () => {
    // orient dispatches through a conditional return and search_code through a mode switch; both
    // were audited as read-only (cache writes only). A new unresolved tool must be reviewed here.
    const unresolved = TOOL_DEFINITIONS.map(t => t.name).filter(name => targets.get(name)?.body === undefined);
    expect(unresolved.sort()).toEqual(['orient', 'search_code']);
  });
});
