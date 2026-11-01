/**
 * CloudFormation / SAM extraction (spec-07).
 *
 * Handles JSON and YAML, including the short-form intrinsics (`!Ref`,
 * `!GetAtt`, `!Sub`, …) via a CFN-aware custom-tag set so the `yaml` parser
 * does not choke. Edges: Ref, Fn::GetAtt, Fn::Sub ${var}, DependsOn,
 * Fn::ImportValue (cross-stack → external), nested stacks (TemplateURL).
 * Pseudo-parameters (AWS::Region, …) are ignored as builtins.
 */

import { LineCounter, parseDocument, type ScalarTag, type CollectionTag } from 'yaml';
import type { IacGraph, IacReference, IacResource } from './types.js';
import { emptyIacGraph } from './types.js';

const INTRINSICS = [
  'Ref', 'GetAtt', 'Sub', 'Join', 'Select', 'Split', 'FindInMap', 'ImportValue',
  'Base64', 'GetAZs', 'Cidr', 'If', 'Equals', 'And', 'Or', 'Not', 'Condition',
  'Transform', 'Length', 'ToJsonString',
];

/** Build scalar+seq+map custom tags that unwrap `!Name` → `{ Ref|Fn::Name: value }`. */
function cfnTags(): Array<ScalarTag | CollectionTag> {
  const tags: Array<ScalarTag | CollectionTag> = [];
  for (const name of INTRINSICS) {
    const canonical = name === 'Ref' || name === 'Condition' ? name : `Fn::${name}`;
    const wrap = (value: unknown) => ({ [canonical]: value });
    tags.push({ tag: `!${name}`, resolve: (str: string) => wrap(str) } as ScalarTag);
    tags.push({
      tag: `!${name}`, collection: 'seq',
      resolve: (seq: { toJSON(): unknown }) => wrap(seq.toJSON()),
    } as CollectionTag);
    tags.push({
      tag: `!${name}`, collection: 'map',
      resolve: (map: { toJSON(): unknown }) => wrap(map.toJSON()),
    } as CollectionTag);
  }
  return tags;
}

export function extractCloudFormation(
  files: Array<{ path: string; content: string }>,
): IacGraph {
  const graph = emptyIacGraph();
  for (const file of files) {
    let doc;
    const lc = new LineCounter();
    try {
      doc = parseDocument(file.content, { customTags: cfnTags(), lineCounter: lc });
    } catch {
      continue;
    }
    const js = doc.toJS() as Record<string, unknown> | null;
    if (!js || typeof js !== 'object') continue;
    extractTemplate(js, file.path, doc, lc, graph);
  }
  return graph;
}

function extractTemplate(
  tpl: Record<string, unknown>,
  filePath: string,
  doc: ReturnType<typeof parseDocument>,
  lc: LineCounter,
  graph: IacGraph,
): void {
  const declared = new Set<string>();
  const lineOf = (path: (string | number)[]): number => {
    const node = doc.getIn(path, true) as { range?: [number, number, number] } | undefined;
    const off = node?.range?.[0];
    return off != null ? lc.linePos(off).line : 1;
  };

  const addNode = (
    address: string, type: string, kind: IacResource['kind'],
    path: (string | number)[], signature: string, isExternal = false,
  ) => {
    declared.add(address);
    graph.resources.push({
      address, type, kind, filePath,
      startLine: lineOf(path),
      signature,
      isExternal: isExternal || undefined,
      language: 'CloudFormation',
    });
  };

  const sections: Array<[string, IacResource['kind'], string]> = [
    ['Parameters', 'variable', 'Parameter'],
    ['Mappings', 'value', 'Mapping'],
    ['Conditions', 'value', 'Condition'],
  ];
  for (const [section, kind, typeLabel] of sections) {
    const obj = tpl[section];
    if (obj && typeof obj === 'object') {
      for (const id of Object.keys(obj as Record<string, unknown>)) {
        addNode(id, typeLabel, kind, [section, id], `${typeLabel}: ${id}`);
      }
    }
  }

  const resources = (tpl.Resources ?? {}) as Record<string, unknown>;
  for (const [id, body] of Object.entries(resources)) {
    if (!body || typeof body !== 'object') continue;
    const type = (body as Record<string, unknown>).Type;
    const typeStr = typeof type === 'string' ? type : 'AWS::Unknown';
    addNode(id, typeStr, 'resource', ['Resources', id], `${id} (${typeStr})`);
    // The code a function runs (change: add-iac-deploy-binding); SAM `Globals.Function` supplies defaults.
    if (typeStr === 'AWS::Lambda::Function' || typeStr === 'AWS::Serverless::Function') {
      const props = ((body as Record<string, unknown>).Properties ?? {}) as Record<string, unknown>;
      // SAM `Globals.Function` applies to `AWS::Serverless::Function` only.
      const globals = typeStr === 'AWS::Serverless::Function'
        ? (((tpl.Globals ?? {}) as Record<string, unknown>).Function ?? {}) as Record<string, unknown> : {};
      const pick = (k: string) => props[k] ?? globals[k];
      if (pick('PackageType') === 'Image' || pick('ImageUri') !== undefined) continue;
      const handler = pick('Handler');
      const codeUri = pick('CodeUri');
      const runtime = pick('Runtime');
      const code = props.Code as Record<string, unknown> | undefined;
      const r = graph.resources[graph.resources.length - 1];
      if (!r || r.address !== id || handler === undefined) continue;
      if (pick('InlineCode') !== undefined || (code && code.ZipFile !== undefined)) r.deploys = { unresolved: 'the code is inline in the template' };
      else if (typeof handler !== 'string') r.deploys = { unresolved: 'the handler is an intrinsic function' };
      else if (codeUri !== undefined && typeof codeUri !== 'string') r.deploys = { unresolved: 'the code location is not a path (an S3 location or intrinsic)' };
      else if (typeof codeUri === 'string' && /^s3:\/\//i.test(codeUri)) r.deploys = { unresolved: 'the code is in S3' };
      else if (codeUri === undefined && typeStr === 'AWS::Lambda::Function') r.deploys = { unresolved: 'the code location is not in the repository (Code is an S3 location)' };
      else r.deploys = { handler, ...(typeof codeUri === 'string' ? { codeUri } : {}), ...(typeof runtime === 'string' ? { runtime } : {}) };
    }
  }

  const outputs = (tpl.Outputs ?? {}) as Record<string, unknown>;
  for (const id of Object.keys(outputs)) {
    addNode(`Output.${id}`, 'Output', 'output', ['Outputs', id], `Output: ${id}`);
  }

  // Edges — walk each resource/output body for intrinsic references + DependsOn.
  const externalAddrs = new Set<string>();
  const ensureExternal = (address: string, type: string) => {
    if (declared.has(address) || externalAddrs.has(address)) return;
    externalAddrs.add(address);
    graph.resources.push({
      address, type, kind: 'stack', filePath, startLine: 1,
      isExternal: true, signature: address, language: 'CloudFormation',
    });
  };

  const emitRefs = (from: string, body: unknown) => {
    const refs = new Set<string>();
    const deps = new Set<string>();
    collectIntrinsics(body, refs, (importName) => {
      const addr = `ImportValue:${importName}`;
      ensureExternal(addr, 'Fn::ImportValue');
      refs.add(addr);
    });
    // DependsOn at the resource top level.
    if (body && typeof body === 'object') {
      const d = (body as Record<string, unknown>).DependsOn;
      if (typeof d === 'string') deps.add(d);
      else if (Array.isArray(d)) for (const x of d) if (typeof x === 'string') deps.add(x);
      // Nested stack: TemplateURL → external.
      const props = (body as Record<string, unknown>).Properties as Record<string, unknown> | undefined;
      if ((body as Record<string, unknown>).Type === 'AWS::CloudFormation::Stack' && props?.TemplateURL) {
        const url = typeof props.TemplateURL === 'string' ? props.TemplateURL : 'nested-stack';
        const addr = `Stack:${url}`;
        ensureExternal(addr, 'AWS::CloudFormation::Stack');
        refs.add(addr);
      }
    }
    const add = (to: string, kind: IacReference['kind']) => {
      if (to === from) return;
      if (declared.has(to) || externalAddrs.has(to)) {
        graph.references.push({ fromAddress: from, toAddress: to, kind });
      }
    };
    for (const r of refs) add(r, 'references');
    for (const d of deps) add(d, 'depends_on');
  };

  for (const [id, body] of Object.entries(resources)) emitRefs(id, body);
  for (const [id, body] of Object.entries(outputs)) emitRefs(`Output.${id}`, body);
}

/** Recursively collect Ref/GetAtt/Sub targets (logical ids), ignoring pseudo-params. */
function collectIntrinsics(node: unknown, refs: Set<string>, onImport: (name: string) => void): void {
  if (Array.isArray(node)) { for (const x of node) collectIntrinsics(x, refs, onImport); return; }
  if (!node || typeof node !== 'object') return;
  const rec = node as Record<string, unknown>;

  if (typeof rec.Ref === 'string') addLogical(rec.Ref, refs);
  if ('Fn::GetAtt' in rec) {
    const v = rec['Fn::GetAtt'];
    const target = typeof v === 'string' ? v.split('.')[0] : Array.isArray(v) ? String(v[0]) : undefined;
    if (target) addLogical(target, refs);
  }
  if ('Fn::Sub' in rec) {
    const v = rec['Fn::Sub'];
    const tmpl = typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : '';
    for (const m of tmpl.matchAll(/\$\{([^}]+)\}/g)) addLogical(m[1].split('.')[0].trim(), refs);
  }
  if ('Fn::ImportValue' in rec) {
    const v = rec['Fn::ImportValue'];
    if (typeof v === 'string') onImport(v);
  }

  for (const [k, v] of Object.entries(rec)) {
    if (k === 'DependsOn') continue; // handled at resource level
    collectIntrinsics(v, refs, onImport);
  }
}

function addLogical(name: string, refs: Set<string>): void {
  if (!name || name.startsWith('AWS::')) return; // pseudo-parameter
  refs.add(name);
}
