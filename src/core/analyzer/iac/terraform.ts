/**
 * Terraform / HCL extraction (spec-07, reference implementation).
 *
 * Parser choice: a tolerant, hand-rolled HCL block scanner rather than a
 * tree-sitter grammar. Rationale (per spec): `tree-sitter-hcl` is a native
 * addon with an extra build/install surface, and IaC extraction only needs
 * block boundaries + dotted-reference detection — not a full AST. A pure-JS
 * scanner keeps the dependency tree flat and install-clean, and is fully
 * deterministic. We never evaluate HCL; we only read declared blocks + refs.
 *
 * Files: *.tf, *.tf.json, *.tfvars. (The JSON variant is handled tolerantly by
 * the same reference scan; structural JSON parsing is a spec-07 follow-up.)
 */

import { dirname, posix as posixPath } from 'node:path';
import type { IacGraph, IacReference, IacResource, IacModule } from './types.js';
import { emptyIacGraph } from './types.js';

interface HclBlock {
  /** e.g. "resource", "data", "module", "variable", "output", "provider", "locals", "terraform" */
  type: string;
  /** Quoted labels after the type, e.g. ["aws_s3_bucket", "logs"]. */
  labels: string[];
  body: string;
  startLine: number;
  endLine: number;
  headerLine: string;
}

/** Built-in reference roots that are never project resources. */
const TF_BUILTIN_ROOTS = new Set(['each', 'count', 'self', 'terraform', 'path']);

export function extractTerraform(
  files: Array<{ path: string; content: string }>,
): IacGraph {
  const graph = emptyIacGraph();
  // dir → resource addresses declared there, for local-module source linking.
  const dirResources = new Map<string, IacResource[]>();
  const moduleSources: Array<{ mod: IacModule; sourceDir: string | null }> = [];

  for (const file of files) {
    if (file.path.toLowerCase().endsWith('.tf.json')) {
      ingestTfJson(file, graph, dirResources, moduleSources);
      continue;
    }
    const blocks = scanHclBlocks(file.content);
    for (const block of blocks) {
      ingestBlock(block, file.path, graph, dirResources, moduleSources);
    }
  }

  // Link local module sources → the resources declared under that directory.
  for (const { mod, sourceDir } of moduleSources) {
    if (!sourceDir) continue;
    const targets = dirResources.get(sourceDir) ?? [];
    for (const t of targets) {
      graph.references.push({
        fromAddress: mod.address,
        toAddress: t.address,
        kind: 'depends_on',
      });
      mod.members.push(t.address);
    }
  }

  return graph;
}

function ingestBlock(
  block: HclBlock,
  filePath: string,
  graph: IacGraph,
  dirResources: Map<string, IacResource[]>,
  moduleSources: Array<{ mod: IacModule; sourceDir: string | null }>,
): void {
  const push = (r: IacResource) => {
    graph.resources.push(r);
    const dir = posixPath.normalize(dirname(filePath));
    if (!dirResources.has(dir)) dirResources.set(dir, []);
    dirResources.get(dir)!.push(r);
  };

  switch (block.type) {
    case 'resource': {
      const [type, name] = block.labels;
      if (!type || !name) return;
      const address = `${type}.${name}`;
      push(makeResource(address, type, 'resource', filePath, block));
      addRefs(address, block, filePath, graph);
      return;
    }
    case 'data': {
      const [type, name] = block.labels;
      if (!type || !name) return;
      const address = `data.${type}.${name}`;
      const isRemoteState = type === 'terraform_remote_state';
      push(makeResource(address, type, 'data', filePath, block, isRemoteState));
      addRefs(address, block, filePath, graph);
      return;
    }
    case 'variable': {
      const [name] = block.labels;
      if (!name) return;
      push(makeResource(`var.${name}`, 'variable', 'variable', filePath, block));
      return;
    }
    case 'output': {
      const [name] = block.labels;
      if (!name) return;
      const address = `output.${name}`;
      push(makeResource(address, 'output', 'output', filePath, block));
      addRefs(address, block, filePath, graph);
      return;
    }
    case 'provider': {
      const [name] = block.labels;
      if (!name) return;
      graph.resources.push(
        makeResource(`provider.${name}`, 'provider', 'provider', filePath, block, true),
      );
      return;
    }
    case 'locals': {
      // Each top-level `key = …` is a separate local.
      for (const { key, line } of topLevelAssignments(block)) {
        const address = `local.${key}`;
        push({
          address,
          type: 'local',
          kind: 'value',
          filePath,
          startLine: line,
          endLine: line,
          signature: `local.${key}`,
          language: 'Terraform',
        });
      }
      addRefs(block.labels.length ? block.labels[0] : 'locals', block, filePath, graph, true);
      return;
    }
    case 'module': {
      const [name] = block.labels;
      if (!name) return;
      const address = `module.${name}`;
      const source = attrValue(block.body, 'source');
      const isLocal = !!source && (source.startsWith('./') || source.startsWith('../'));
      const isExternal = !!source && !isLocal;
      push(makeResource(address, 'module', 'module', filePath, block, isExternal));
      const mod: IacModule = {
        address,
        type: 'module',
        filePath,
        language: 'Terraform',
        isExternal: isExternal || undefined,
        members: [],
      };
      graph.modules.push(mod);
      const sourceDir =
        isLocal && source
          ? posixPath.normalize(posixPath.join(dirname(filePath), source))
          : null;
      moduleSources.push({ mod, sourceDir });
      addRefs(address, block, filePath, graph);
      return;
    }
    default:
      return; // terraform {}, moved {}, import {}, etc. — not modeled
  }
}

function makeResource(
  address: string,
  type: string,
  kind: IacResource['kind'],
  filePath: string,
  block: HclBlock,
  isExternal = false,
): IacResource {
  const meta = /\b(count|for_each)\b\s*=/.test(block.body) ? '  # (count/for_each: single node)' : '';
  return {
    address,
    type,
    kind,
    filePath,
    startLine: block.startLine,
    endLine: block.endLine,
    isExternal: isExternal || undefined,
    signature: block.headerLine.trim() + meta,
    language: 'Terraform',
  };
}

/** Scan dotted references + depends_on in a block body and emit edges. */
function addRefs(
  fromAddress: string,
  block: HclBlock,
  _filePath: string,
  graph: IacGraph,
  localsMode = false,
): void {
  const seen = new Set<string>();
  const emit = (to: string, kind: IacReference['kind'], line?: number) => {
    if (localsMode) return; // handled per-local below
    const key = `${to}\0${kind}`;
    if (seen.has(key) || to === fromAddress) return;
    seen.add(key);
    graph.references.push({ fromAddress, toAddress: to, kind, line });
  };

  // depends_on = [ a.b, module.c ]
  // Bounded: `[\s\S]*?` rescanned to EOF from every `depends_on = [` with no closer.
  const dep = block.body.match(/depends_on\s*=\s*\[([\s\S]{0,20000}?)\]/);
  if (dep) {
    for (const raw of dep[1].split(',')) {
      const ref = classifyRef(raw.trim());
      if (ref) emit(ref, 'depends_on');
    }
  }

  for (const token of scanRefTokens(block.body)) {
    const ref = classifyRef(token);
    if (ref) emit(ref, 'references');
  }
}

/** Map a dotted token to a canonical resource address, or null to drop it. */
function classifyRef(token: string): string | null {
  const segs = token.split('.');
  if (segs.length < 2) return null;
  const root = segs[0];
  if (TF_BUILTIN_ROOTS.has(root)) return null;
  if (root === 'var') return `var.${segs[1]}`;
  if (root === 'local') return `local.${segs[1]}`;
  if (root === 'module') return `module.${segs[1]}`;
  if (root === 'data') return segs.length >= 3 ? `data.${segs[1]}.${segs[2]}` : null;
  // Resource reference: <type>.<name>.<attr…>. We emit the candidate even when the
  // type has no underscore (e.g. a custom provider type); the projector drops it
  // if no declared resource owns the address, so this never invents a wrong edge.
  return `${root}.${segs[1]}`;
}

/** Extract candidate dotted tokens from a body, ignoring quoted-string noise. */
function scanRefTokens(body: string): string[] {
  const tokens: string[] = [];
  // Interpolations first (legacy ${…} and HCL2 bare refs both land in masked body).
  for (const m of body.matchAll(/\$\{([^}]*)\}/g)) {
    for (const t of m[1].matchAll(/[a-zA-Z_][\w-]*(?:\.[a-zA-Z_][\w-]*)+/g)) tokens.push(t[0]);
  }
  const masked = maskStrings(body);
  for (const t of masked.matchAll(/[a-zA-Z_][\w-]*(?:\.[a-zA-Z_][\w-]*)+/g)) {
    // Skip method/function calls like foo.bar( … ) where the token precedes '('
    tokens.push(t[0]);
  }
  return tokens;
}

/**
 * Structural parse of the Terraform JSON variant (`*.tf.json`). The same
 * top-level blocks appear as JSON objects; references live in `${…}` strings.
 */
function ingestTfJson(
  file: { path: string; content: string },
  graph: IacGraph,
  dirResources: Map<string, IacResource[]>,
  moduleSources: Array<{ mod: IacModule; sourceDir: string | null }>,
): void {
  let root: Record<string, unknown>;
  try {
    root = JSON.parse(file.content) as Record<string, unknown>;
  } catch {
    return;
  }
  if (!root || typeof root !== 'object') return;

  const dir = posixPath.normalize(dirname(file.path));
  const push = (r: IacResource) => {
    graph.resources.push(r);
    if (!dirResources.has(dir)) dirResources.set(dir, []);
    dirResources.get(dir)!.push(r);
  };
  const lineOf = (needle: string): number => {
    const idx = file.content.indexOf(`"${needle}"`);
    if (idx < 0) return 1;
    return file.content.slice(0, idx).split('\n').length;
  };
  // A block value may be a single object or an array of objects (TF JSON allows both).
  const each = (v: unknown): Array<Record<string, unknown>> =>
    Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
      : v && typeof v === 'object' ? [v as Record<string, unknown>] : [];

  const addRefsFrom = (fromAddress: string, body: unknown) => {
    const seen = new Set<string>();
    const json = JSON.stringify(body ?? {});
    for (const m of json.matchAll(/\$\{([^}]*)\}/g)) {
      for (const t of m[1].matchAll(/[a-zA-Z_][\w-]*(?:\.[a-zA-Z_][\w-]*)+/g)) {
        const ref = classifyRef(t[0]);
        if (ref && ref !== fromAddress && !seen.has(`r:${ref}`)) {
          seen.add(`r:${ref}`);
          graph.references.push({ fromAddress, toAddress: ref, kind: 'references' });
        }
      }
    }
    const dep = (body as Record<string, unknown>)?.depends_on;
    if (Array.isArray(dep)) {
      for (const d of dep) {
        const ref = typeof d === 'string' ? classifyRef(d) : null;
        if (ref && ref !== fromAddress && !seen.has(`d:${ref}`)) {
          seen.add(`d:${ref}`);
          graph.references.push({ fromAddress, toAddress: ref, kind: 'depends_on' });
        }
      }
    }
  };

  const resBlock = root.resource as Record<string, unknown> | undefined;
  for (const [type, named] of Object.entries(resBlock ?? {})) {
    for (const obj of each(named)) {
      for (const [name, body] of Object.entries(obj)) {
        const address = `${type}.${name}`;
        push({ address, type, kind: 'resource', filePath: file.path, startLine: lineOf(name), signature: `resource "${type}" "${name}"`, language: 'Terraform' });
        addRefsFrom(address, body);
      }
    }
  }
  const dataBlock = root.data as Record<string, unknown> | undefined;
  for (const [type, named] of Object.entries(dataBlock ?? {})) {
    for (const obj of each(named)) {
      for (const [name, body] of Object.entries(obj)) {
        const address = `data.${type}.${name}`;
        push({ address, type, kind: 'data', filePath: file.path, startLine: lineOf(name), signature: `data "${type}" "${name}"`, language: 'Terraform' });
        addRefsFrom(address, body);
      }
    }
  }
  for (const obj of each(root.variable)) {
    for (const name of Object.keys(obj)) {
      push({ address: `var.${name}`, type: 'variable', kind: 'variable', filePath: file.path, startLine: lineOf(name), signature: `variable "${name}"`, language: 'Terraform' });
    }
  }
  for (const obj of each(root.output)) {
    for (const [name, body] of Object.entries(obj)) {
      const address = `output.${name}`;
      push({ address, type: 'output', kind: 'output', filePath: file.path, startLine: lineOf(name), signature: `output "${name}"`, language: 'Terraform' });
      addRefsFrom(address, body);
    }
  }
  for (const obj of each(root.provider)) {
    for (const name of Object.keys(obj)) {
      graph.resources.push({ address: `provider.${name}`, type: 'provider', kind: 'provider', filePath: file.path, startLine: lineOf(name), isExternal: true, signature: `provider "${name}"`, language: 'Terraform' });
    }
  }
  for (const obj of each(root.locals)) {
    for (const key of Object.keys(obj)) {
      push({ address: `local.${key}`, type: 'local', kind: 'value', filePath: file.path, startLine: lineOf(key), signature: `local.${key}`, language: 'Terraform' });
    }
  }
  for (const obj of each(root.module)) {
    for (const [name, body] of Object.entries(obj)) {
      const address = `module.${name}`;
      const source = (body as Record<string, unknown>)?.source;
      const isLocal = typeof source === 'string' && (source.startsWith('./') || source.startsWith('../'));
      const isExternal = typeof source === 'string' && !isLocal;
      push({ address, type: 'module', kind: 'module', filePath: file.path, startLine: lineOf(name), isExternal: isExternal || undefined, signature: `module "${name}"`, language: 'Terraform' });
      const mod: IacModule = { address, type: 'module', filePath: file.path, language: 'Terraform', isExternal: isExternal || undefined, members: [] };
      graph.modules.push(mod);
      const sourceDir = isLocal && typeof source === 'string' ? posixPath.normalize(posixPath.join(dir, source)) : null;
      moduleSources.push({ mod, sourceDir });
      addRefsFrom(address, body);
    }
  }
}

/** Blank out double-quoted string literals (keeping length) to avoid false refs. */
function maskStrings(body: string): string {
  return body.replace(/"(?:[^"\\]|\\.)*"/g, (s) => ' '.repeat(s.length));
}

/** Top-level `key = …` assignments inside a block body (depth-0 only). */
function topLevelAssignments(block: HclBlock): Array<{ key: string; line: number }> {
  const out: Array<{ key: string; line: number }> = [];
  const lines = block.body.split('\n');
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (depth === 0) {
      const m = line.match(/^\s*([A-Za-z_][\w-]*)\s*=/);
      if (m) out.push({ key: m[1], line: block.startLine + 1 + i });
    }
    depth += countUnquoted(line, '{') + countUnquoted(line, '[');
    depth -= countUnquoted(line, '}') + countUnquoted(line, ']');
    if (depth < 0) depth = 0;
  }
  return out;
}

function countUnquoted(line: string, ch: string): number {
  const masked = maskStrings(line);
  let n = 0;
  for (const c of masked) if (c === ch) n++;
  return n;
}

/** Value of a simple top-level `key = "value"` attribute. */
function attrValue(body: string, key: string): string | null {
  const re = new RegExp(`(^|\\n)\\s*${key}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`);
  const m = body.match(re);
  return m ? m[2] : null;
}

/**
 * Scan top-level HCL blocks, tracking strings/comments/heredocs and brace depth.
 */
function scanHclBlocks(content: string): HclBlock[] {
  const blocks: HclBlock[] = [];
  const len = content.length;
  let i = 0;
  let line = 1;

  const lineAt = (idx: number): number => {
    let n = 1;
    for (let k = 0; k < idx && k < len; k++) if (content[k] === '\n') n++;
    return n;
  };

  while (i < len) {
    const ch = content[i];
    if (ch === '\n') { line++; i++; continue; }
    // Skip comments
    if (ch === '#' || (ch === '/' && content[i + 1] === '/')) {
      while (i < len && content[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && content[i + 1] === '*') {
      i += 2;
      while (i < len && !(content[i] === '*' && content[i + 1] === '/')) {
        if (content[i] === '\n') line++;
        i++;
      }
      i += 2;
      continue;
    }
    // Only attempt a header at a token boundary (start, or after whitespace/braces).
    const prev = i === 0 ? '\n' : content[i - 1];
    const atBoundary = /[\s{}]/.test(prev);
    const idMatch = atBoundary ? /^([A-Za-z_][\w-]*)/.exec(content.slice(i, i + 64)) : null;
    if (idMatch) {
      const headerStart = i;
      const blockStartLine = line;
      let j = i + idMatch[1].length;
      const labels: string[] = [];
      // consume labels (quoted strings or bare identifiers) until '{' or newline-without-brace
      let sawBrace = false;
      while (j < len) {
        const c = content[j];
        if (c === '{') { sawBrace = true; break; }
        if (c === '\n') break;
        if (c === '"') {
          let k = j + 1;
          let s = '';
          while (k < len && content[k] !== '"') { if (content[k] === '\\') k++; s += content[k]; k++; }
          labels.push(s);
          j = k + 1;
          continue;
        }
        if (c === '=' ) { sawBrace = false; break; } // it's an assignment, not a block
        if (/\s/.test(c)) { j++; continue; }
        // bare identifier label (rare)
        const bm = /^[A-Za-z_][\w-]*/.exec(content.slice(j, j + 64));
        if (bm) { labels.push(bm[0]); j += bm[0].length; continue; }
        j++;
      }
      if (sawBrace) {
        const headerLine = content.slice(headerStart, j).replace(/\s+/g, ' ');
        // brace-match the body
        const bodyStart = j + 1;
        let depth = 1;
        let k = bodyStart;
        let curLine = blockStartLine + countChar(content.slice(headerStart, bodyStart), '\n');
        while (k < len && depth > 0) {
          const c = content[k];
          if (c === '\n') { curLine++; k++; continue; }
          if (c === '#' || (c === '/' && content[k + 1] === '/')) {
            while (k < len && content[k] !== '\n') k++;
            continue;
          }
          if (c === '/' && content[k + 1] === '*') {
            k += 2;
            while (k < len && !(content[k] === '*' && content[k + 1] === '/')) { if (content[k] === '\n') curLine++; k++; }
            k += 2;
            continue;
          }
          if (c === '"') {
            k++;
            while (k < len && content[k] !== '"') { if (content[k] === '\\') k++; if (content[k] === '\n') curLine++; k++; }
            k++;
            continue;
          }
          // heredoc <<EOT ... EOT
          if (c === '<' && content[k + 1] === '<') {
            const hm = /^<<-?(\w+)\n/.exec(content.slice(k));
            if (hm) {
              const tag = hm[1];
              k += hm[0].length;
              const endRe = new RegExp(`\\n\\s*${tag}\\b`);
              const rest = content.slice(k);
              const em = endRe.exec(rest);
              const consumed = em ? em.index + em[0].length : rest.length;
              curLine += countChar(rest.slice(0, consumed), '\n');
              k += consumed;
              continue;
            }
          }
          if (c === '{') depth++;
          else if (c === '}') depth--;
          k++;
        }
        const bodyEnd = k - 1;
        const body = content.slice(bodyStart, bodyEnd);
        blocks.push({
          type: idMatch[1],
          labels,
          body,
          startLine: blockStartLine,
          endLine: lineAt(bodyEnd),
          headerLine,
        });
        i = k;
        line = curLine;
        continue;
      }
    }
    i++;
  }
  return blocks;
}

function countChar(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}
