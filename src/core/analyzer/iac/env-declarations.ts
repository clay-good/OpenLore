/**
 * Environment-variable declaration sites in infrastructure files (change: add-iac-code-binding).
 *
 * Where a deployment SETS an env var: a Kubernetes container `env`, a compose `environment`, a
 * Dockerfile `ENV`, a Terraform/OpenTofu or CloudFormation/SAM function environment map, an ECS
 * container definition, or a GitHub Actions `env`. Each site records the key, the ecosystem, the
 * resource, the file and line, and whether a value is written there literally — NEVER the value.
 *
 * A source that sets variables this reader cannot enumerate (Kubernetes `envFrom`, compose
 * `env_file`, ECS `EnvironmentFiles`, a Terraform `dynamic "env"`, an environment map built by an
 * expression) is returned as an opaque source, so the caller can say the variable may be set there
 * instead of implying it is not.
 *
 * Pure, deterministic, and linear in the file size: one file in, sites out. No I/O, no rendering
 * (Helm), no `terraform plan`. Keys are read only where the format puts keys — never from inside a
 * value, a string, a comment, or a heredoc.
 */

import { LineCounter, parseAllDocuments, isAlias, isMap, isSeq, isScalar, type Document, type Node } from 'yaml';

export type EnvEcosystem = 'Kubernetes' | 'Docker Compose' | 'Dockerfile' | 'Terraform' | 'CloudFormation' | 'GitHub Actions';

export interface EnvDeclaration {
  name: string;
  ecosystem: EnvEcosystem;
  /** The resource that sets it: `Deployment/api/web`, `service/web`, `aws_lambda_function.orders`, `job/build`. */
  resource: string;
  file: string;
  line: number;
  /** Whether a non-empty value is written at this site as a literal (no interpolation, reference, or secret source). */
  literalValue: boolean;
}

/** A place that sets variables this reader cannot enumerate. */
export interface OpaqueEnvSource {
  ecosystem: EnvEcosystem;
  resource: string;
  file: string;
  line: number;
  reason: string;
}

export interface EnvDeclarationScan {
  declarations: EnvDeclaration[];
  opaque: OpaqueEnvSource[];
}

/** Declarations read from one file at most (a bound on hostile input, not a real-world limit). */
const MAX_PER_FILE = 10_000;
/** Interpolation or substitution markers: a value containing one is not literal. */
const INTERPOLATED = /\$\{|\$\(|\$[A-Za-z_]|\{\{/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
/** A literal is a non-empty value with no interpolation. */
const literalText = (v: string | undefined) => v !== undefined && v !== '' && !INTERPOLATED.test(v);

export function extractEnvDeclarations(file: { path: string; content: string; language: string }): EnvDeclarationScan {
  const out: EnvDeclarationScan = { declarations: [], opaque: [] };
  try {
    switch (file.language) {
      case 'Dockerfile': dockerfile(file, out); break;
      case 'Terraform': terraform(file, out); break;
      case 'Kubernetes': case 'Docker Compose': case 'CloudFormation': case 'GitHub Actions': yamlLike(file, out); break;
      default: break;
    }
  } catch {
    // A file that cannot be read yields nothing here; the caller discloses parse limits.
  }
  if (out.declarations.length > MAX_PER_FILE) out.declarations.length = MAX_PER_FILE;
  return out;
}

// ── Dockerfile ──────────────────────────────────────────────────────────────

function dockerfile(file: { path: string; content: string }, out: EnvDeclarationScan): void {
  const lines = file.content.split(/\r?\n/);
  let stage = 'Dockerfile';
  for (let i = 0; i < lines.length; i++) {
    const start = i;
    if (/^\s*#/.test(lines[i])) continue;
    // Join line continuations (parts joined once: repeated concatenation was quadratic); comment
    // lines inside one are not part of the instruction.
    const parts: string[] = [];
    let cur = lines[i];
    while (cur.trimEnd().endsWith('\\') && i + 1 < lines.length) {
      parts.push(cur.trimEnd().slice(0, -1));
      i++;
      cur = /^\s*#/.test(lines[i]) ? '\\' : lines[i];
    }
    parts.push(cur.trimEnd().endsWith('\\') ? cur.trimEnd().slice(0, -1) : cur);
    const text = parts.join(' ');
    // A heredoc body (`RUN <<EOF … EOF`) is data, not instructions. Only RUN, COPY, and ADD take
    // heredocs; `<<` inside quotes or `$(( ))` arithmetic is not one. Bodies are skipped in order.
    if (/^\s*(?:RUN|COPY|ADD)\s/i.test(text)) {
      const code = text.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '').replace(/\$\(\([^)]*\)\)/g, '');
      for (const tag of [...code.matchAll(/(?:^|\s)<<-?\s*["']?([A-Za-z_]\w*)["']?/g)].map(m => m[1])) {
        while (i + 1 < lines.length && lines[i + 1].trim() !== tag) i++;
        i++;
      }
    }
    const from = /^\s*FROM\s+(?:--\S+\s+)*\S+(?:\s+AS\s+(\S+))?/i.exec(text);
    if (from) { stage = from[1] ? `stage/${from[1]}` : 'Dockerfile'; continue; }
    const env = /^\s*ENV\s+(.*)$/i.exec(text);
    if (!env) continue;
    const body = env[1].trim();
    const add = (name: string, value: string | undefined) => {
      if (ENV_NAME.test(name)) out.declarations.push({ name, ecosystem: 'Dockerfile', resource: stage, file: file.path, line: start + 1, literalValue: literalText(value) });
    };
    if (/^[A-Za-z_][\w.-]*=/.test(body)) {
      // ENV KEY=value KEY2="value two" KEY3=escaped\ space — pairs separated by unescaped whitespace.
      const pair = /([A-Za-z_][\w.-]*)=("(?:[^"\\]|\\.)*"|'[^']*'|(?:\\.|[^\s\\])*)/y;
      let at = 0;
      while (at < body.length) {
        while (at < body.length && /\s/.test(body[at])) at++;
        pair.lastIndex = at;
        const m = pair.exec(body);
        if (!m) {
          // Not a pair: skip this word and keep reading.
          while (at < body.length && !/\s/.test(body[at])) at++;
          continue;
        }
        add(m[1], m[2].replace(/^(["'])([\s\S]*)\1$/, '$2'));
        at = pair.lastIndex;
      }
    } else {
      // Legacy form: ENV KEY value
      const legacy = /^([A-Za-z_][\w.-]*)\s+(.*)$/.exec(body);
      if (legacy) add(legacy[1], legacy[2]);
    }
  }
}

// ── Terraform / OpenTofu (HCL and JSON) ─────────────────────────────────────

/**
 * The HCL text with comments, string contents, and heredoc bodies blanked (same length, newlines
 * kept), so structure is read only from code. Quotes stay, so a quoted key keeps its position.
 */
/**
 * The index of the `"` that closes the HCL string opened at `open` (or of the newline or end that
 * cuts it short). Template interpolations (`${ … }`, `%{ … }`) may hold braces and quoted strings of
 * their own, so they are stepped over as a unit.
 */
function stringEnd(src: string, open: number): number {
  // Frames: a string (-1) or a template interpolation (its brace depth, from 0).
  const frames: number[] = [-1];
  let k = open + 1;
  while (k < src.length) {
    const ch = src[k];
    const top = frames[frames.length - 1];
    if (top === -1) {
      if (ch === '\\') { k += 2; continue; }
      if (ch === '"') { frames.pop(); if (!frames.length) return k; k++; continue; }
      if (ch === '\n' && frames.length === 1) return k;
      if ((ch === '$' || ch === '%') && src[k + 1] === '{') { frames.push(0); k += 2; continue; }
    } else if (ch === '"') frames.push(-1);
    else if (ch === '{') frames[frames.length - 1]++;
    else if (ch === '}') { if (top === 0) frames.pop(); else frames[frames.length - 1]--; }
    k++;
  }
  return k;
}

function maskHcl(src: string): string {
  const out = src.split('');
  const blank = (from: number, to: number) => { for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '; };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '#' || (c === '/' && src[i + 1] === '/')) {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"') {
      const k = stringEnd(src, i);
      blank(i + 1, Math.min(k, src.length));
      i = k + 1;
    } else if (c === '<' && src[i + 1] === '<') {
      const m = /^<<-?([A-Za-z_]\w*)\r?\n/.exec(src.slice(i, i + 80));
      if (!m) { i += 2; continue; }
      const bodyStart = i + m[0].length;
      // The terminator is the tag alone on its line.
      const endRe = new RegExp(`\\n[ \\t]*${m[1]}[ \\t]*\\r?(?=\\n|$)`, 'g');
      endRe.lastIndex = bodyStart - 1;
      const em = endRe.exec(src);
      const stop = em ? em.index + 1 : src.length;
      blank(bodyStart, stop);
      i = stop;
    } else i++;
  }
  return out.join('');
}

function terraform(file: { path: string; content: string }, out: EnvDeclarationScan): void {
  if (file.path.toLowerCase().endsWith('.json')) { yamlLike({ ...file, language: 'Terraform' }, out); return; }
  const src = file.content;
  const masked = maskHcl(src);
  // Matching braces in one pass.
  const close = new Map<number, number>();
  const stack: number[] = [];
  for (let k = 0; k < masked.length; k++) {
    if (masked[k] === '{') stack.push(k);
    else if (masked[k] === '}' && stack.length) close.set(stack.pop()!, k);
  }
  const lineStarts = [0];
  for (let k = 0; k < src.length; k++) if (src[k] === '\n') lineStarts.push(k + 1);
  const lineOf = (off: number) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= off) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
  /** Direct children of the block body (open, end): `name {` blocks and `name = ` attributes. */
  const children = (open: number, end: number) => {
    const found: Array<{ kind: 'block' | 'attr'; name: string; labels: string; at: number; open?: number; valueAt?: number }> = [];
    let k = open + 1;
    while (k < end) {
      const ch = masked[k];
      if (ch === '{') { k = (close.get(k) ?? end) + 1; continue; }
      const atBoundary = k === open + 1 || /[\s{]/.test(masked[k - 1]);
      if (!atBoundary || !/[A-Za-z_]/.test(ch)) { k++; continue; }
      const m = /^([A-Za-z_][\w-]*)((?:[ \t]+"[^"\n]*")*)[ \t]*(=(?![=>])|\{)/.exec(masked.slice(k, k + 4096));
      if (!m) {
        // Skip the rest of this word: retrying inside it was quadratic.
        k++;
        while (k < end && /[\w-]/.test(masked[k])) k++;
        continue;
      }
      {
        const opIdx = k + m[0].length - 1;
        if (m[3] === '{') { found.push({ kind: 'block', name: m[1], labels: m[2], at: k, open: opIdx }); k = (close.get(opIdx) ?? end) + 1; }
        else { found.push({ kind: 'attr', name: m[1], labels: '', at: k, valueAt: opIdx + 1 }); k = opIdx + 1; }
        continue;
      }
      k++;
    }
    return found;
  };
  const isLiteral = (from: number, to: number) => {
    // A trailing comment is blank in the mask: end the value at its last code character.
    let e = to;
    while (e > from && /\s/.test(masked[e - 1])) e--;
    const v = src.slice(from, e).trim();
    return /^"[^"\n]*"$/.test(v) && v.length > 2 && !/\$\{|%\{/.test(v);
  };
  /** The value range of an attribute: to the end of the line (masked), or the close of a `{`/`[` it opens. */
  const valueEnd = (from: number, end: number) => {
    let k = from;
    while (k < end && (masked[k] === ' ' || masked[k] === '\t')) k++;
    if (masked[k] === '{') return (close.get(k) ?? end) + 1;
    let depth = 0;
    for (; k < end; k++) {
      const ch = masked[k];
      if (ch === '{') { k = close.get(k) ?? end; continue; }
      if (ch === '[' || ch === '(') depth++;
      else if (ch === ']' || ch === ')') depth--;
      else if (depth <= 0 && (ch === '\n' || ch === ',' || ch === '}')) break;
    }
    return k;
  };

  for (const top of children(-1, masked.length)) {
    if (top.kind !== 'block' || top.name !== 'resource' || top.open === undefined) continue;
    const labels = [...top.labels.matchAll(/"/g)].length >= 4 ? labelsAt(top.at) : [];
    const resource = labels.join('.') || 'resource';
    const end = close.get(top.open) ?? masked.length;
    visit(top.open, end, resource);
  }

  /** The labels of a block header at `at`, read from the original text. */
  function labelsAt(at: number): string[] {
    const header = src.slice(at, masked.indexOf('{', at));
    return [...header.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)].map(m => m[1].replace(/\\(.)/g, '$1'));
  }

  function visit(open: number, end: number, resource: string): void {
    for (const c of children(open, end)) {
      if (out.declarations.length > MAX_PER_FILE) return;
      if (c.kind === 'block' && c.open !== undefined) {
        const cEnd = close.get(c.open) ?? end;
        if (c.name === 'environment') environment(c.open, cEnd, resource);
        else if (c.name === 'env') envBlock(c.at, c.open, cEnd, resource);
        else if (c.name === 'env_from' || (c.name === 'dynamic' && /^"(?:env|env_from|environment)"$/.test(src.slice(c.at, c.open).replace(/^dynamic\s*/, '').trim()))) {
          out.opaque.push({ ecosystem: 'Terraform', resource, file: file.path, line: lineOf(c.at), reason: c.name === 'env_from' ? 'env_from (a ConfigMap or Secret whose keys are not read here)' : `a dynamic ${src.slice(c.at, c.open).replace(/^dynamic\s*/, '').trim().replace(/"/g, '')} block` });
        } else visit(c.open, cEnd, resource);
      }
    }
  }

  /** `environment { variables = { KEY = value } }`: keys at depth 1 of the map only. */
  function environment(open: number, end: number, resource: string): void {
    for (const c of children(open, end)) {
      if (c.kind !== 'attr' || c.name !== 'variables' || c.valueAt === undefined) continue;
      let k = c.valueAt;
      while (k < end && /[ \t]/.test(masked[k])) k++;
      if (masked[k] !== '{') {
        out.opaque.push({ ecosystem: 'Terraform', resource, file: file.path, line: lineOf(c.at), reason: 'an environment map built by an expression' });
        continue;
      }
      const mapEnd = close.get(k) ?? end;
      // A `for` expression builds the map: its keys are not written here.
      if (/^\s*for\s/.test(masked.slice(k + 1, k + 64))) {
        out.opaque.push({ ecosystem: 'Terraform', resource, file: file.path, line: lineOf(c.at), reason: 'an environment map built by a for expression' });
        continue;
      }
      let p = k + 1;
      let expressionKey = false;
      while (p < mapEnd) {
        // A key is a bare identifier or a quoted string (blanked by the mask: its name is read from `src`).
        const m = /^[\s,]*(?:"([^"\n]*)"|([A-Za-z_][\w.-]*))[ \t]*=(?![=>])/.exec(masked.slice(p, p + 300));
        const quotedKey = m?.[1] !== undefined ? src.slice(p + m[0].indexOf('"') + 1, p + m[0].indexOf('"') + 1 + m[1].length) : undefined;
        if (!m || (quotedKey !== undefined && /\$\{|%\{/.test(quotedKey))) {
          // An interpolated or parenthesized key (`"${var.p}_X"`, `(var.k)`) is set but not readable.
          if (m || /^[\s,]*[("]/.test(masked.slice(p, p + 300))) expressionKey = true;
          // Not a key here: move past this element.
          const next = valueEnd(p, mapEnd);
          p = next > p ? next + 1 : p + 1;
          continue;
        }
        const quoted = m[1] !== undefined;
        const keyAt = p + (quoted ? m[0].indexOf('"') + 1 : m[0].indexOf(m[2]));
        const name = quoted ? quotedKey! : m[2];
        const vStart = p + m[0].length;
        const vEnd = valueEnd(vStart, mapEnd);
        if (ENV_NAME.test(name)) out.declarations.push({ name, ecosystem: 'Terraform', resource, file: file.path, line: lineOf(keyAt), literalValue: isLiteral(vStart, vEnd) });
        p = vEnd + 1;
      }
      if (expressionKey) out.opaque.push({ ecosystem: 'Terraform', resource, file: file.path, line: lineOf(c.at), reason: 'an environment key built by an expression' });
    }
  }

  /** The kubernetes provider's `env { name = "KEY" value = "…" }`. */
  function envBlock(at: number, open: number, end: number, resource: string): void {
    let name: string | undefined;
    let literal = false;
    for (const c of children(open, end)) {
      if (c.kind !== 'attr' || c.valueAt === undefined) continue;
      const vEnd = valueEnd(c.valueAt, end);
      if (c.name === 'name') name = /^\s*"([^"\n]*)"\s*$/.exec(src.slice(c.valueAt, vEnd))?.[1];
      else if (c.name === 'value') literal = isLiteral(c.valueAt, vEnd);
    }
    if (name && ENV_NAME.test(name)) out.declarations.push({ name, ecosystem: 'Terraform', resource, file: file.path, line: lineOf(at), literalValue: literal });
  }
}

// ── YAML / JSON ecosystems ──────────────────────────────────────────────────

type Pair = { key: unknown; value: unknown };

function yamlLike(file: { path: string; content: string; language: string }, out: EnvDeclarationScan): void {
  const lc = new LineCounter();
  const docs = parseAllDocuments(file.content, { lineCounter: lc, uniqueKeys: false, merge: true });
  if (!Array.isArray(docs)) return;
  const eco = file.language as EnvEcosystem;
  for (const doc of docs) {
    const root = (doc as Document).contents;
    if (!root) continue;
    const r = makeReader(doc as Document, lc, file.path, eco, out);
    if (file.language === 'Kubernetes') r.kubernetes(root);
    else if (file.language === 'Docker Compose') r.compose(root);
    else if (file.language === 'GitHub Actions') r.actions(root);
    else if (file.language === 'CloudFormation') r.cloudFormation(root);
    else if (file.language === 'Terraform') r.tfJson(root);
  }
}

function makeReader(doc: Document, lc: LineCounter, file: string, eco: EnvEcosystem, out: EnvDeclarationScan) {
  /** Aliases resolved (bounded), so a shared anchor counts where it is used. */
  const deref = (n: unknown): unknown => {
    let cur = n;
    for (let hop = 0; hop < 8 && isAlias(cur); hop++) cur = cur.resolve(doc);
    return isAlias(cur) ? undefined : cur;
  };
  const keyOf = (p: Pair): string | undefined => { const k = deref(p.key); return isScalar(k) && typeof k.value === 'string' ? k.value : undefined; };
  const isMerge = (p: Pair) => isScalar(p.key) && typeof p.key.value === 'symbol';
  /** A mapping's pairs with `<<` merges applied (explicit keys win). */
  const pairsMemo = new Map<unknown, Pair[]>();
  const pairsOf = (n: unknown, depth = 0): Pair[] => {
    const m = deref(n);
    if (!isMap(m) || depth > 8) return [];
    const memo = pairsMemo.get(m);
    if (memo) return memo;
    pairsMemo.set(m, []); // a merge cycle reads as empty
    const own = (m.items as Pair[]).filter(p => !isMerge(p));
    // YAML merge: explicit keys win, then the first merge source that has the key. Each list is
    // bounded by its distinct keys, and each node is expanded once.
    const byKey = new Map<string | undefined, Pair>();
    for (const p of own) byKey.set(keyOf(p), p);
    for (const p of m.items as Pair[]) {
      if (!isMerge(p)) continue;
      const v = deref(p.value);
      for (const src of isSeq(v) ? v.items : [v]) {
        for (const q of pairsOf(src, depth + 1)) { const k = keyOf(q); if (!byKey.has(k)) byKey.set(k, q); }
      }
    }
    const result = [...byKey.values()];
    pairsMemo.set(m, result);
    return result;
  };
  const get = (n: unknown, key: string): unknown => deref(pairsOf(n).find(p => keyOf(p) === key)?.value);
  const keyNode = (n: unknown, key: string): unknown => pairsOf(n).find(p => keyOf(p) === key)?.key;
  const strOf = (n: unknown): string | undefined => { const s = deref(n); return isScalar(s) && s.value !== null && s.value !== undefined ? String(s.value) : undefined; };
  const itemsOf = (n: unknown): unknown[] => { const s = deref(n); return isSeq(s) ? s.items.map(deref) : []; };
  const lineOf = (n: unknown) => {
    const r = (n as { range?: [number, number, number] } | undefined)?.range;
    return r ? lc.linePos(r[0]).line : 1;
  };
  /** A literal written value: a non-empty plain scalar, no custom tag, no interpolation. */
  const literalNode = (n: unknown): boolean => {
    const s = deref(n);
    if (!isScalar(s) || s.value === null || s.value === undefined) return false;
    const tag = (s as { tag?: string }).tag;
    if (tag && !tag.startsWith('tag:yaml.org')) return false;
    return literalText(String(s.value));
  };
  const declare = (name: string, resource: string, at: unknown, literal: boolean) => {
    if (out.declarations.length <= MAX_PER_FILE && ENV_NAME.test(name)) out.declarations.push({ name, ecosystem: eco, resource, file, line: lineOf(at), literalValue: literal });
  };
  const opaque = (resource: string, at: unknown, reason: string) => out.opaque.push({ ecosystem: eco, resource, file, line: lineOf(at), reason });
  const isNull = (n: unknown) => n === undefined || n === null || (isScalar(n) && (n.value === null || n.value === undefined));
  /** A `KEY: value` map, or an opaque source when the map is an expression. */
  const envMap = (n: unknown, resource: string, owner: unknown) => {
    const m = deref(n);
    if (isMap(m)) { for (const p of pairsOf(m)) { const k = keyOf(p); if (k) declare(k, resource, p.key, literalNode(p.value)); } }
    else if (!isNull(m)) opaque(resource, owner, 'an environment map built by an expression');
  };

  return {
    kubernetes(root: Node): void {
      // A `kind: List` holds its objects in `items`.
      if (strOf(get(root, 'kind')) === 'List') { for (const item of itemsOf(get(root, 'items'))) this.kubernetes(item as Node); return; }
      const resource = `${strOf(get(root, 'kind')) ?? 'Resource'}/${strOf(get(get(root, 'metadata'), 'name')) ?? '?'}`;
      // Every container list anywhere in the object (pods, deployments, jobs, cron jobs).
      const stack: unknown[] = [root];
      const seen = new Set<unknown>();
      while (stack.length) {
        const n = deref(stack.pop());
        if (seen.has(n)) continue;
        seen.add(n);
        if (isSeq(n)) { for (const i of n.items) stack.push(i); continue; }
        if (!isMap(n)) continue;
        for (const p of pairsOf(n)) {
          const k = keyOf(p);
          if (k === 'containers' || k === 'initContainers' || k === 'ephemeralContainers') {
            for (const c of itemsOf(p.value)) {
              const cname = strOf(get(c, 'name'));
              const where = cname ? `${resource}/${cname}` : resource;
              const env = get(c, 'env');
              if (isSeq(env)) {
                for (const e of itemsOf(env)) {
                  const name = strOf(get(e, 'name'));
                  if (name) declare(name, where, keyNode(e, 'name'), get(e, 'valueFrom') === undefined && literalNode(get(e, 'value')));
                }
              } else if (!isNull(env)) opaque(where, keyNode(c, 'env'), 'an env list that is not a literal list');
              if (get(c, 'envFrom') !== undefined) opaque(where, keyNode(c, 'envFrom'), 'envFrom (a ConfigMap or Secret whose keys are not read here)');
            }
          } else stack.push(p.value);
        }
      }
    },

    compose(root: Node): void {
      for (const s of pairsOf(get(root, 'services'))) {
        const svc = keyOf(s);
        if (!svc) continue;
        const resource = `service/${svc}`;
        const env = get(s.value, 'environment');
        if (isSeq(env)) {
          for (const item of env.items) {
            const text = strOf(item);
            if (!text) continue;
            const eq = text.indexOf('=');
            const name = eq === -1 ? text : text.slice(0, eq);
            declare(name, resource, deref(item), literalText(eq === -1 ? undefined : text.slice(eq + 1)));
          }
        } else envMap(env, resource, keyNode(s.value, 'environment'));
        if (get(s.value, 'env_file') !== undefined) opaque(resource, keyNode(s.value, 'env_file'), 'env_file (a file whose keys are not read here)');
      }
    },

    actions(root: Node): void {
      const at = (n: unknown, resource: string) => {
        if (get(n, 'env') !== undefined) envMap(get(n, 'env'), resource, keyNode(n, 'env'));
      };
      at(root, 'workflow');
      for (const j of pairsOf(get(root, 'jobs'))) {
        const job = keyOf(j);
        if (!job) continue;
        at(j.value, `job/${job}`);
        at(get(j.value, 'container'), `job/${job}/container`);
        for (const svc of pairsOf(get(j.value, 'services'))) at(svc.value, `job/${job}/service/${keyOf(svc) ?? '?'}`);
        itemsOf(get(j.value, 'steps')).forEach((st, i) => at(st, `job/${job}/step/${strOf(get(st, 'id')) ?? strOf(get(st, 'name')) ?? i + 1}`));
      }
    },

    cloudFormation(root: Node): void {
      const variables = (owner: unknown, resource: string) => {
        const env = get(owner, 'Environment');
        if (get(env, 'Variables') !== undefined) envMap(get(env, 'Variables'), resource, keyNode(env, 'Variables'));
      };
      variables(get(get(root, 'Globals'), 'Function'), 'Globals/Function');
      for (const r of pairsOf(get(root, 'Resources'))) {
        const id = keyOf(r);
        if (!id) continue;
        const props = get(r.value, 'Properties');
        variables(props, id);
        // ECS: ContainerDefinitions[].Environment[] { Name, Value } and Secrets[] { Name, ValueFrom }.
        for (const d of itemsOf(get(props, 'ContainerDefinitions'))) {
          const where = `${id}/${strOf(get(d, 'Name')) ?? '?'}`;
          for (const e of itemsOf(get(d, 'Environment'))) {
            const name = strOf(get(e, 'Name'));
            if (name) declare(name, where, keyNode(e, 'Name'), literalNode(get(e, 'Value')));
          }
          for (const e of itemsOf(get(d, 'Secrets'))) {
            const name = strOf(get(e, 'Name'));
            if (name) declare(name, where, keyNode(e, 'Name'), false);
          }
          if (get(d, 'EnvironmentFiles') !== undefined) opaque(where, keyNode(d, 'EnvironmentFiles'), 'EnvironmentFiles (files whose keys are not read here)');
        }
      }
    },

    tfJson(root: Node): void {
      for (const t of pairsOf(get(root, 'resource'))) {
        for (const r of pairsOf(t.value)) {
          const resource = `${keyOf(t)}.${keyOf(r)}`;
          const bodies = isSeq(deref(r.value)) ? itemsOf(r.value) : [deref(r.value)];
          for (const b of bodies) {
            const env = get(b, 'environment');
            for (const e of isSeq(env) ? itemsOf(env) : [env]) {
              if (get(e, 'variables') !== undefined) envMap(get(e, 'variables'), resource, keyNode(e, 'variables'));
            }
          }
        }
      }
    },
  };
}
