/**
 * The request body a client call site sends, when it is written as a literal (change:
 * add-contract-graph-projection, LiteralPayloadsAreCheckedAgainstRequiredProperties).
 *
 * From the call's offset, the argument list is scanned with string, template, and comment
 * awareness (no parser): `fetch(url, { body: JSON.stringify({ … }) })`, `fetch(url, { body: { … } })`,
 * and `axios.post|put|patch(url, { … })`, or `JSON.stringify({ … })` there. The body's top-level keys
 * are listed only when every member is a plain or quoted key or a shorthand; a spread, a computed
 * key, or any other body is "not literal", never "conforming".
 */

export type BodyRead =
  | { kind: 'literal'; keys: string[] }
  | { kind: 'not-literal'; reason: string }
  | { kind: 'absent' };

/** The longest argument list scanned. */
const MAX_SCAN = 20_000;

/** Index just past the string, template, or comment opening at `i`, or -1 when none opens there. */
function skipQuoted(text: string, i: number): number {
  const c = text[i];
  if (c === '/' && text[i + 1] === '/') { const e = text.indexOf('\n', i); return e === -1 ? text.length : e; }
  if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); return e === -1 ? text.length : e + 2; }
  if (c !== '"' && c !== "'" && c !== '`') return -1;
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === '\\') { j++; continue; }
    if (c === '`' && text[j] === '$' && text[j + 1] === '{') {
      const end = matchClose(text, j + 1);
      if (end === -1) return text.length;
      j = end;
      continue;
    }
    if (text[j] === c) return j + 1;
  }
  return text.length;
}

/** Index of the bracket closing the one at `open`, or -1. */
function matchClose(text: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const stack = [pairs[text[open]]];
  const end = Math.min(text.length, open + MAX_SCAN);
  for (let i = open + 1; i < end; i++) {
    const q = skipQuoted(text, i);
    if (q !== -1) { i = q - 1; continue; }
    const ch = text[i];
    if (pairs[ch]) stack.push(pairs[ch]);
    else if (ch === stack[stack.length - 1]) { stack.pop(); if (!stack.length) return i; }
  }
  return -1;
}

/** The top-level comma-separated parts of `text` (between brackets), trimmed. */
function splitTop(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const q = skipQuoted(text, i);
    if (q !== -1) { i = q - 1; continue; }
    const ch = text[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) { parts.push(text.slice(start, i).trim()); start = i + 1; }
  }
  const last = text.slice(start).trim();
  if (last) parts.push(last);
  return parts;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

/** The keys of an object literal `{ … }`, or why they cannot be listed. */
function objectKeys(expr: string): BodyRead {
  const t = expr.trim();
  if (!t.startsWith('{') || matchClose(t, 0) !== t.length - 1) return { kind: 'not-literal', reason: 'the body is not an object literal' };
  const keys: string[] = [];
  for (const member of splitTop(t.slice(1, -1))) {
    if (member.startsWith('...')) return { kind: 'not-literal', reason: 'the body spreads another object' };
    if (IDENT.test(member)) { keys.push(member); continue; } // shorthand
    const m = /^(?:([A-Za-z_$][\w$]*)|'([^'\\]*)'|"([^"\\]*)")\s*(?::|\()/.exec(member);
    if (!m) return { kind: 'not-literal', reason: 'the body has a computed or unusual key' };
    keys.push(m[1] ?? m[2] ?? m[3]);
  }
  return { kind: 'literal', keys };
}

/** A body expression: an object literal, or `JSON.stringify` of one. */
function bodyExpression(expr: string): BodyRead {
  const t = expr.trim();
  const s = /^JSON\.stringify\s*\(/.exec(t);
  if (s) {
    const open = t.indexOf('(', s.index);
    const close = matchClose(t, open);
    if (close !== t.length - 1) return { kind: 'not-literal', reason: 'the body is not JSON.stringify of a literal' };
    const args = splitTop(t.slice(open + 1, close));
    return args.length ? objectKeys(args[0]) : { kind: 'not-literal', reason: 'JSON.stringify has no argument' };
  }
  return objectKeys(t);
}

/**
 * The body of the client call starting at `offset` in `text`. `client` is the extractor's
 * (`fetch`, `axios`); any other client is not assessed.
 */
export function readCallBody(text: string, offset: number, client: string): BodyRead {
  const open = text.indexOf('(', offset);
  if (open === -1 || open - offset > 200) return { kind: 'not-literal', reason: 'the call could not be located' };
  const close = matchClose(text, open);
  if (close === -1) return { kind: 'not-literal', reason: 'the call could not be read' };
  const callee = text.slice(offset, open);
  const args = splitTop(text.slice(open + 1, close));
  if (client === 'fetch') {
    if (args.length < 2) return { kind: 'absent' };
    const opts = objectKeys(args[1]);
    if (opts.kind !== 'literal') return { kind: 'not-literal', reason: 'the fetch options are not an object literal' };
    if (!opts.keys.includes('body')) return { kind: 'absent' };
    const inner = args[1].trim().slice(1, -1);
    const member = splitTop(inner).find(m => /^(?:body|'body'|"body")\s*:/.test(m));
    if (!member) return { kind: 'not-literal', reason: 'the body is a shorthand reference' };
    return bodyExpression(member.slice(member.indexOf(':') + 1));
  }
  if (client === 'axios' && /\.(?:post|put|patch)\s*$/.test(callee)) {
    return args.length < 2 ? { kind: 'absent' } : bodyExpression(args[1]);
  }
  return { kind: 'not-literal', reason: `a ${client} call's body is not read` };
}
