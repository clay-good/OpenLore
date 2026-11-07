/**
 * Protocol Buffers v3 reader (change: add-contract-graph-projection, protobuf phase).
 *
 * Reads one `.proto` file into a normalized element model: services and their RPCs, messages
 * (nested ones under their full name), fields with their numbers, labels and types, enums with
 * their values, and the `reserved` ranges and names of each. Deterministic and offline: a small
 * hand-written tokenizer, no grammar, no `protoc`, no network.
 *
 * Only proto3 is read. A file with no `syntax` statement is proto2 by the language's own rule,
 * and an `edition` file follows other rules again; both are UNREAD with that reason, never read as
 * declaring nothing. An element the model does not cover (`extend`, `extensions`) is listed in
 * `unassessed`. Type names are resolved across every file read by {@link resolveProtoTypes}, with
 * protobuf's own scoping rule — never by similarity.
 */

import { createHash } from 'node:crypto';
import { MAX_SPEC_BYTES } from './openapi.js';

/** Whether a path is a protobuf definition file. */
export const isProtobufPath = (path: string): boolean => /\.proto$/i.test(path);

/** The largest field number protobuf allows; `max` in a `reserved` range. */
const MAX_FIELD_NUMBER = 536_870_911;
/** The largest enum value (an int32); `max` in an enum's `reserved` range. */
const MAX_ENUM_VALUE = 2_147_483_647;
/** Nesting depth of messages read at most: deeper is unreadable, never a stack overflow. */
const MAX_NESTING = 64;

const SCALARS: ReadonlySet<string> = new Set([
  'double', 'float', 'int32', 'int64', 'uint32', 'uint64', 'sint32', 'sint64',
  'fixed32', 'fixed64', 'sfixed32', 'sfixed64', 'bool', 'string', 'bytes',
]);

/** Whether a field type is a scalar (never a reference to a message or enum). */
export const isProtoScalar = (type: string): boolean => SCALARS.has(type);

export type ProtoLabel = 'singular' | 'optional' | 'repeated' | 'map';

/** A type name as written, with the scope it was written in — resolved later, across files. */
export interface ProtoTypeRef { written: string; scope: string }

export interface ProtoField {
  name: string;
  number: number;
  label: ProtoLabel;
  /** The type as written: a scalar, a (possibly qualified) message or enum name, or `map<K, V>`. */
  type: string;
  /** For a message or enum type (or a map's value type): what to resolve. */
  ref?: ProtoTypeRef;
  /** The full name it resolved to (`pkg.Order`), set by {@link resolveProtoTypes}. */
  resolved?: string;
  /** The `oneof` it belongs to. */
  oneof?: string;
  deprecated: boolean;
  /** A hash of the field options the rule table does not compare (`json_name`, `packed`, …). */
  optionsHash: string;
  line: number;
}

export interface ProtoReserved {
  /** Inclusive number ranges. */
  ranges: Array<[number, number]>;
  names: string[];
}

export interface ProtoMessage {
  kind: 'message';
  /** The full name, package included, no leading dot: `pkg.Outer.Inner`. */
  name: string;
  /** The name as declared: `Inner`. */
  simpleName: string;
  line: number;
  fields: ProtoField[];
  reserved: ProtoReserved;
  /** A hash of the message's own options. */
  optionsHash: string;
}

export interface ProtoEnumValue { name: string; number: number; deprecated: boolean; optionsHash: string; line: number }

export interface ProtoEnum {
  kind: 'enum';
  name: string;
  simpleName: string;
  line: number;
  values: ProtoEnumValue[];
  reserved: ProtoReserved;
  optionsHash: string;
}

export interface ProtoRpc {
  /** The gRPC method path: `/pkg.Service/Method`. Unique per RPC, and what a client puts on the wire. */
  address: string;
  /** The full service name: `pkg.Service`. */
  service: string;
  name: string;
  request: ProtoTypeRef;
  response: ProtoTypeRef;
  /** Full names, set by {@link resolveProtoTypes} when they resolve. */
  requestType?: string;
  responseType?: string;
  clientStreaming: boolean;
  serverStreaming: boolean;
  deprecated: boolean;
  optionsHash: string;
  line: number;
}

export interface ProtoService { name: string; simpleName: string; line: number; rpcs: ProtoRpc[]; optionsHash: string }

export interface ProtoDocument {
  file: string;
  format: 'protobuf-3';
  package: string;
  imports: string[];
  /** The imports written `import public`: re-exported to whoever imports this file. */
  publicImports: string[];
  services: ProtoService[];
  messages: ProtoMessage[];
  enums: ProtoEnum[];
  /** Element classes present in the file but outside the model (`extend`, `extensions`). */
  unassessed: string[];
}

/** Reserved ranges sorted and merged (touching ranges joined), so membership is a binary search. */
export function mergeRanges(ranges: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: Array<[number, number]> = [];
  for (const [lo, hi] of sorted) {
    const last = out[out.length - 1];
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else out.push([lo, hi]);
  }
  return out;
}

/** Whether `n` is in merged ranges. */
export function inRanges(merged: ReadonlyArray<readonly [number, number]>, n: number): boolean {
  let lo = 0;
  let hi = merged.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (n < merged[mid][0]) hi = mid - 1;
    else if (n > merged[mid][1]) lo = mid + 1;
    else return true;
  }
  return false;
}

// ── Tokenizer ──────────────────────────────────────────────────────────────

interface Tok { t: 'id' | 'num' | 'str' | 'sym'; v: string; line: number }

class ProtoSyntaxError extends Error {}

function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let line = 1;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') { i++; continue; }
    if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) throw new ProtoSyntaxError(`line ${line}: unterminated comment`);
      for (let k = i; k < end; k++) if (text[k] === '\n') line++;
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const start = line;
      let j = i + 1;
      let v = '';
      while (j < n && text[j] !== c) {
        if (text[j] === '\n') throw new ProtoSyntaxError(`line ${start}: unterminated string`);
        if (text[j] === '\\' && j + 1 < n) {
          // Decoded as protoc decodes them, so `"\x61"` and `"a"` are the same reserved name.
          const e = text[j + 1];
          const hex = /^[xX]([0-9a-fA-F]{1,2})/.exec(text.slice(j + 1, j + 4));
          const oct = /^[0-7]{1,3}/.exec(text.slice(j + 1, j + 4));
          const uni = /^u([0-9a-fA-F]{4})/.exec(text.slice(j + 1, j + 6)) ?? /^U([0-9a-fA-F]{8})/.exec(text.slice(j + 1, j + 10));
          if (hex) { v += String.fromCharCode(parseInt(hex[1], 16)); j += 1 + hex[0].length; continue; }
          if (oct) { v += String.fromCharCode(parseInt(oct[0], 8)); j += 1 + oct[0].length; continue; }
          if (uni) { const cp = parseInt(uni[1], 16); v += cp <= 0x10ffff ? String.fromCodePoint(cp) : '\ufffd'; j += 1 + uni[0].length; continue; }
          const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v' };
          v += simple[e] ?? e;
          j += 2;
          continue;
        }
        v += text[j++];
      }
      if (j >= n) throw new ProtoSyntaxError(`line ${start}: unterminated string`);
      out.push({ t: 'str', v, line: start });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(text[j])) j++;
      out.push({ t: 'id', v: text.slice(i, j), line });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(text[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < n && /[\w.+-]/.test(text[j]) && !((text[j] === '+' || text[j] === '-') && !/[eE]/.test(text[j - 1]))) j++;
      out.push({ t: 'num', v: text.slice(i, j), line });
      i = j;
      continue;
    }
    // A leading dot makes a fully-qualified type name: `.pkg.Order`.
    if (c === '.' && /[A-Za-z_]/.test(text[i + 1] ?? '')) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(text[j])) j++;
      out.push({ t: 'id', v: text.slice(i, j), line });
      i = j;
      continue;
    }
    out.push({ t: 'sym', v: c, line });
    i++;
  }
  return out;
}

const sha = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 16);

/** Parse an integer literal as protobuf writes one (decimal, hex, octal), or `undefined`. */
function intValue(v: string): number | undefined {
  let x: number;
  if (/^0[xX][0-9a-fA-F]+$/.test(v)) x = parseInt(v.slice(2), 16);
  else if (/^0[0-7]+$/.test(v)) x = parseInt(v.slice(1), 8);
  else if (/^(?:0|[1-9][0-9]*)$/.test(v)) x = Number(v);
  else return undefined;
  return Number.isSafeInteger(x) ? x : undefined;
}

// ── Parser ─────────────────────────────────────────────────────────────────

/**
 * Parse one file. Returns an `error` when it cannot be read as proto3 — a syntax error, proto2,
 * editions, or a file past the size cap. A `.proto` file is always a specification, so there is
 * no "not a document" outcome.
 */
export function readProtobuf(file: string, text: string): ProtoDocument | { file: string; error: string } {
  if (text.length > MAX_SPEC_BYTES) return { file, error: `larger than ${MAX_SPEC_BYTES / 1024 / 1024} MB` };
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    return parse(file, tokenize(text));
  } catch (e) {
    return { file, error: e instanceof Error ? e.message.split('\n')[0] : String(e) };
  }
}

function parse(file: string, toks: Tok[]): ProtoDocument {
  let p = 0;
  const peek = (k = 0): Tok | undefined => toks[p + k];
  const fail = (msg: string, t: Tok | undefined = peek()): never => {
    throw new ProtoSyntaxError(`line ${t?.line ?? toks[toks.length - 1]?.line ?? 1}: ${msg}`);
  };
  const next = (): Tok => toks[p++] ?? fail('unexpected end of file');
  const isSym = (v: string, k = 0) => peek(k)?.t === 'sym' && peek(k)?.v === v;
  const isId = (v: string, k = 0) => peek(k)?.t === 'id' && peek(k)?.v === v;
  const expectSym = (v: string): Tok => (isSym(v) ? next() : fail(`expected \`${v}\`, found \`${peek()?.v ?? 'end of file'}\``));
  const ident = (what: string): Tok => {
    const t = peek()?.t === 'id' ? next() : fail(`expected ${what}, found \`${peek()?.v ?? 'end of file'}\``);
    if (/\.\.|\.$/.test(t.v)) fail(`\`${t.v}\` is not a valid name`, t);
    return t;
  };
  /** One string literal, adjacent literals joined as protoc joins them (`"proto" "3"`). */
  const stringLit = (what: string): Tok => {
    const t = next();
    if (t.t !== 'str') fail(`expected ${what}`, t);
    let v = t.v;
    while (peek()?.t === 'str') v += next().v;
    return { ...t, v };
  };
  /** A name with no dots (a message, field, service, or RPC name). */
  const simpleIdent = (what: string): Tok => {
    const t = ident(what);
    if (t.v.includes('.')) fail(`expected ${what}, found \`${t.v}\``, t);
    return t;
  };

  /**
   * Skip one option statement's value up to and including its `;`, balancing braces and
   * brackets (an aggregate value `{ a: 1 }` can hold anything). Returns the skipped text.
   */
  const skipToSemicolon = (): string => {
    let depth = 0;
    const parts: string[] = [];
    for (;;) {
      const t = next();
      if (t.t === 'sym' && (t.v === '{' || t.v === '[' || t.v === '(')) depth++;
      else if (t.t === 'sym' && (t.v === '}' || t.v === ']' || t.v === ')')) {
        if (--depth < 0) fail(`unbalanced \`${t.v}\``, t);
      } else if (t.t === 'sym' && t.v === ';' && depth === 0) return parts.join(' ');
      parts.push(`${t.t}:${t.v}`);
    }
  };
  /** Skip a balanced `{ … }` block, the opening brace next. */
  const skipBlock = (): void => {
    expectSym('{');
    let depth = 1;
    while (depth > 0) {
      const t = next();
      if (t.t === 'sym' && t.v === '{') depth++;
      else if (t.t === 'sym' && t.v === '}') depth--;
    }
  };
  /** `option name = value;` with `option` already consumed: whether it says `deprecated = true`, and its text. */
  const optionStatement = (): { deprecated: boolean; text: string } => {
    const text = skipToSemicolon();
    return { deprecated: /^id:deprecated sym:= id:true$/.test(text), text };
  };
  /** Field or enum-value options `[a = 1, deprecated = true]`, the `[` next. */
  const bracketOptions = (): { deprecated: boolean; rest: string[] } => {
    expectSym('[');
    const items: string[][] = [[]];
    let depth = 0;
    for (;;) {
      const t = next();
      if (t.t === 'sym' && (t.v === '{' || t.v === '[' || t.v === '(')) depth++;
      else if (t.t === 'sym' && (t.v === '}' || t.v === ')')) depth--;
      else if (t.t === 'sym' && t.v === ']') {
        if (depth === 0) break;
        depth--;
      } else if (t.t === 'sym' && t.v === ',' && depth === 0) { items.push([]); continue; }
      items[items.length - 1].push(`${t.t}:${t.v}`);
    }
    const texts = items.map(i => i.join(' ')).filter(Boolean);
    return { deprecated: texts.includes('id:deprecated sym:= id:true'), rest: texts.filter(t => !/^id:deprecated sym:=/.test(t)).sort() };
  };
  const intLiteral = (what: string): number => {
    const neg = isSym('-') ? (next(), true) : false;
    const t = next();
    const v = t.t === 'num' ? intValue(t.v) : undefined;
    if (v === undefined) fail(`expected ${what}, found \`${t.v}\``, t);
    return neg ? -v! : v!;
  };
  const reservedStatement = (into: ProtoReserved, max: number): void => {
    for (;;) {
      if (peek()?.t === 'str') into.names.push(stringLit('a reserved name').v);
      else {
        const lo = intLiteral('a field number');
        let hi = lo;
        if (isId('to')) {
          next();
          if (isId('max')) { next(); hi = max; } else hi = intLiteral('a field number');
        }
        if (hi < lo) fail(`reserved range ${lo} to ${hi} is empty`);
        into.ranges.push([lo, hi]);
      }
      if (isSym(',')) { next(); continue; }
      expectSym(';');
      return;
    }
  };

  // ── File header ──
  while (isSym(';')) next();
  if (isId('edition')) fail('protobuf editions are not read; only proto3 is');
  if (!isId('syntax')) fail('no `syntax` statement, so the file is proto2; only proto3 is read');
  next();
  expectSym('=');
  const syntax = stringLit('a syntax string');
  if (syntax.v !== 'proto3') fail(`\`syntax = "${syntax.v}"\` is not read; only proto3 is`, syntax);
  expectSym(';');

  // `package` applies to the whole file wherever it is written, so it is found before any
  // declaration is named: a message above it is still `pkg.Message`.
  let pkg = '';
  {
    let depth = 0;
    for (let k = p; k < toks.length; k++) {
      const t = toks[k];
      if (t.t === 'sym' && t.v === '{') depth++;
      else if (t.t === 'sym' && t.v === '}') depth--;
      else if (depth === 0 && t.t === 'id' && t.v === 'package' && toks[k + 1]?.t === 'id' && toks[k + 2]?.t === 'sym' && toks[k + 2].v === ';') {
        if (pkg) fail('a second `package` statement', t);
        pkg = toks[k + 1].v;
      }
    }
  }
  let packageSeen = false;
  const imports: string[] = [];
  const publicImports: string[] = [];
  const services: ProtoService[] = [];
  const messages: ProtoMessage[] = [];
  const enums: ProtoEnum[] = [];
  const unassessed = new Set<string>();
  const full = (scope: string, name: string) => (scope ? `${scope}.${name}` : name);

  const typeRef = (scope: string): ProtoTypeRef => ({ written: ident('a type name').v, scope });

  const enumBody = (scope: string, nameTok: Tok): void => {
    const e: ProtoEnum = { kind: 'enum', name: full(scope, nameTok.v), simpleName: nameTok.v, line: nameTok.line, values: [], reserved: { ranges: [], names: [] }, optionsHash: '' };
    const options: string[] = [];
    const valueNames = new Set<string>();
    expectSym('{');
    while (!isSym('}')) {
      if (isSym(';')) { next(); continue; }
      if (isId('option')) { next(); options.push(optionStatement().text); continue; }
      if (isId('reserved') && (peek(1)?.t === 'num' || peek(1)?.t === 'str' || isSym('-', 1))) { next(); reservedStatement(e.reserved, MAX_ENUM_VALUE); continue; }
      const name = simpleIdent('an enum value name');
      if (valueNames.has(name.v)) fail(`enum value \`${name.v}\` declared twice in ${e.name}`, name);
      valueNames.add(name.v);
      expectSym('=');
      const number = intLiteral('an enum value number');
      const opts = isSym('[') ? bracketOptions() : { deprecated: false, rest: [] };
      expectSym(';');
      if (number < -2147483648 || number > MAX_ENUM_VALUE) fail(`enum value ${number} is out of the int32 range`, name);
      e.values.push({ name: name.v, number, deprecated: opts.deprecated, optionsHash: sha(opts.rest.join('\n')), line: name.line });
    }
    expectSym('}');
    e.optionsHash = sha(options.sort().join('\n'));
    enums.push(e);
  };

  const messageBody = (scope: string, nameTok: Tok, depth: number): void => {
    if (depth > MAX_NESTING) fail(`messages nested deeper than ${MAX_NESTING}`, nameTok);
    const name = full(scope, nameTok.v);
    const m: ProtoMessage = { kind: 'message', name, simpleName: nameTok.v, line: nameTok.line, fields: [], reserved: { ranges: [], names: [] }, optionsHash: '' };
    messages.push(m);
    const options: string[] = [];
    const numbers = new Set<number>();
    const names = new Set<string>();
    const field = (label: ProtoLabel, oneof?: string): void => {
      let type: string;
      let ref: ProtoTypeRef | undefined;
      if (label === 'map') {
        next(); // map
        expectSym('<');
        const k = ident('a map key type').v;
        expectSym(',');
        const vTok = ident('a map value type');
        expectSym('>');
        type = `map<${k}, ${vTok.v}>`;
        if (!isProtoScalar(vTok.v)) ref = { written: vTok.v, scope: name };
      } else {
        const t = ident('a field type');
        if (t.v === 'group') fail('`group` is proto2 only', t);
        type = t.v;
        if (!isProtoScalar(t.v)) ref = { written: t.v, scope: name };
      }
      const fname = simpleIdent('a field name');
      expectSym('=');
      const number = intLiteral('a field number');
      if (number < 1 || number > MAX_FIELD_NUMBER) fail(`field number ${number} is out of range`, fname);
      if (number >= 19_000 && number <= 19_999) fail(`field number ${number} is reserved for the protobuf implementation`, fname);
      const opts = isSym('[') ? bracketOptions() : { deprecated: false, rest: [] };
      expectSym(';');
      // protoc refuses both; a model holding either could not say which field a number means.
      if (numbers.has(number)) fail(`field number ${number} used twice in ${name}`, fname);
      if (names.has(fname.v)) fail(`field \`${fname.v}\` declared twice in ${name}`, fname);
      numbers.add(number);
      names.add(fname.v);
      m.fields.push({
        name: fname.v, number, label, type, ...(ref ? { ref } : {}), ...(oneof ? { oneof } : {}),
        deprecated: opts.deprecated, optionsHash: sha(opts.rest.join('\n')), line: fname.line,
      });
    };
    const startsNested = (kw: string) => isId(kw) && peek(1)?.t === 'id' && isSym('{', 2);
    expectSym('{');
    while (!isSym('}')) {
      if (isSym(';')) { next(); continue; }
      if (startsNested('message')) { next(); messageBody(name, simpleIdent('a message name'), depth + 1); continue; }
      if (startsNested('enum')) { next(); enumBody(name, simpleIdent('an enum name')); continue; }
      if (isId('extend') && peek(1)?.t === 'id' && isSym('{', 2)) { next(); next(); unassessed.add('extend'); skipBlock(); continue; }
      if (isId('option')) { next(); options.push(optionStatement().text); continue; }
      if (isId('reserved') && (peek(1)?.t === 'num' || peek(1)?.t === 'str')) { next(); reservedStatement(m.reserved, MAX_FIELD_NUMBER); continue; }
      if (isId('extensions') && peek(1)?.t === 'num') { next(); unassessed.add('extensions'); skipToSemicolon(); continue; }
      if (startsNested('oneof')) {
        next();
        const oneof = simpleIdent('a oneof name').v;
        expectSym('{');
        while (!isSym('}')) {
          if (isSym(';')) { next(); continue; }
          if (isId('option')) { next(); options.push(`oneof ${oneof}: ${optionStatement().text}`); continue; }
          field('singular', oneof);
        }
        expectSym('}');
        continue;
      }
      if (isId('map') && isSym('<', 1)) { field('map'); continue; }
      if (isId('required') && peek(1)?.t === 'id' && peek(2)?.t === 'id') fail('`required` is proto2 only');
      if ((isId('repeated') || isId('optional')) && peek(1)?.t === 'id' && peek(2)?.t === 'id') {
        const label = next().v as 'repeated' | 'optional';
        field(label);
        continue;
      }
      field('singular');
    }
    expectSym('}');
    // protoc refuses a field on a number or name its own message reserves.
    const reservedNames = new Set(m.reserved.names);
    const reservedRanges = mergeRanges(m.reserved.ranges);
    for (const f of m.fields) {
      if (reservedNames.has(f.name) || inRanges(reservedRanges, f.number)) {
        fail(`field \`${f.name}\` = ${f.number} uses a number or name ${name} reserves`, { t: 'id', v: f.name, line: f.line });
      }
    }
    m.optionsHash = sha(options.sort().join('\n'));
  };

  const serviceBody = (nameTok: Tok): void => {
    const sname = full(pkg, nameTok.v);
    const s: ProtoService = { name: sname, simpleName: nameTok.v, line: nameTok.line, rpcs: [], optionsHash: '' };
    const serviceOptions: string[] = [];
    services.push(s);
    const rpcNames = new Set<string>();
    expectSym('{');
    while (!isSym('}')) {
      if (isSym(';')) { next(); continue; }
      if (isId('option')) { next(); serviceOptions.push(optionStatement().text); continue; }
      if (!isId('rpc')) fail(`expected \`rpc\` in service ${nameTok.v}, found \`${peek()?.v ?? 'end of file'}\``);
      next();
      const rname = simpleIdent('an RPC name');
      if (rpcNames.has(rname.v)) fail(`rpc \`${rname.v}\` declared twice in ${sname}`, rname);
      rpcNames.add(rname.v);
      const side = (): { ref: ProtoTypeRef; streaming: boolean } => {
        expectSym('(');
        const streaming = isId('stream') && peek(1)?.t === 'id' ? (next(), true) : false;
        const ref = typeRef(pkg);
        expectSym(')');
        return { ref, streaming };
      };
      const req = side();
      if (!isId('returns')) fail('expected `returns`');
      next();
      const res = side();
      let deprecated = false;
      const options: string[] = [];
      if (isSym('{')) {
        next();
        while (!isSym('}')) {
          if (isSym(';')) { next(); continue; }
          if (!isId('option')) fail(`expected \`option\` in rpc ${rname.v}`);
          next();
          const o = optionStatement();
          if (o.deprecated) deprecated = true; else options.push(o.text);
        }
        expectSym('}');
        if (isSym(';')) next();
      } else expectSym(';');
      s.rpcs.push({
        address: `/${sname}/${rname.v}`, service: sname, name: rname.v,
        request: req.ref, response: res.ref, clientStreaming: req.streaming, serverStreaming: res.streaming,
        deprecated, optionsHash: sha(options.sort().join('\n')), line: rname.line,
      });
    }
    expectSym('}');
    s.optionsHash = sha(serviceOptions.sort().join('\n'));
  };

  while (p < toks.length) {
    if (isSym(';')) { next(); continue; }
    const kw = next();
    if (kw.t !== 'id') fail(`unexpected \`${kw.v}\``, kw);
    switch (kw.v) {
      case 'package': {
        // Read by the prescan above; checked here so a malformed statement is still an error.
        if (packageSeen || ident('a package name').v !== pkg) fail('a malformed or second `package` statement', kw);
        packageSeen = true;
        expectSym(';');
        break;
      }
      case 'import': {
        const isPublic = isId('public');
        if (isPublic || isId('weak')) next();
        const path = stringLit('an import path').v;
        imports.push(path);
        if (isPublic) publicImports.push(path);
        expectSym(';');
        break;
      }
      case 'option': optionStatement(); break;
      case 'message': messageBody(pkg, simpleIdent('a message name'), 1); break;
      case 'enum': enumBody(pkg, simpleIdent('an enum name')); break;
      case 'service': serviceBody(simpleIdent('a service name')); break;
      case 'extend': ident('an extended type'); unassessed.add('extend'); skipBlock(); break;
      default: fail(`unexpected \`${kw.v}\` at the top level`, kw);
    }
  }

  const typeNames = new Set<string>();
  for (const t of [...messages, ...enums, ...services]) {
    if (typeNames.has(t.name)) fail(`\`${t.name}\` declared twice`, { t: 'id', v: t.name, line: t.line });
    typeNames.add(t.name);
  }

  const byName = <T extends { name: string }>(a: T, b: T) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return {
    file, format: 'protobuf-3', package: pkg, imports: imports.sort(), publicImports: publicImports.sort(),
    services: services.sort(byName).map(s => ({ ...s, rpcs: s.rpcs.sort(byName) })),
    messages: messages.sort(byName).map(m => ({ ...m, fields: m.fields.sort((a, b) => a.number - b.number) })),
    enums: enums.sort(byName),
    unassessed: [...unassessed].sort(),
  };
}

// ── Type resolution across files ───────────────────────────────────────────

/** Why a type reference did not resolve. */
export interface UnresolvedProtoType { file: string; line: number; written: string; reason: 'undeclared' | 'ambiguous' }

/**
 * Resolve every message and enum type reference across `docs`, with protobuf's own scoping rule:
 * a qualified name's FIRST component is looked up from the innermost scope outward, and the rest
 * must then resolve under it — a first component that resolves to a type or package and whose
 * rest does not is an error, not a reason to keep looking further out. A leading dot means
 * "from the root". A full name declared in two files (two copies of one schema) is ambiguous and
 * binds nothing.
 *
 * Mutates nothing: returns new documents with `resolved` / `requestType` / `responseType` set,
 * plus every reference that did not resolve.
 */
export function resolveProtoTypes(docs: readonly ProtoDocument[]): { docs: ProtoDocument[]; unresolved: UnresolvedProtoType[] } {
  // An import path names a file relative to an include root this reader does not know, so it
  // matches every read file whose path ENDS with it on a segment boundary.
  const bySuffix = new Map<string, number[]>();
  docs.forEach((d, i) => {
    const parts = d.file.split('/');
    for (let k = 0; k < parts.length; k++) {
      const suffix = parts.slice(k).join('/');
      bySuffix.set(suffix, [...(bySuffix.get(suffix) ?? []), i]);
    }
  });
  const importsOf = (i: number, which: 'imports' | 'publicImports') => docs[i][which].flatMap(p => bySuffix.get(p) ?? []);
  /**
   * The files a file can name types from, as protoc allows: itself, its direct imports, and
   * whatever those re-export through `import public`, transitively. A file it does not import
   * is invisible to it — otherwise adding an unrelated file whose package shadows a scope
   * changed what an untouched field resolves to, and graded that as breaking.
   */
  const visibleFrom = (i: number): Set<number> => {
    const out = new Set<number>([i]);
    const stack = importsOf(i, 'imports');
    while (stack.length) {
      const j = stack.pop()!;
      if (out.has(j)) continue;
      out.add(j);
      stack.push(...importsOf(j, 'publicImports'));
    }
    return out;
  };
  const declaredIn = new Map<string, number[]>();
  docs.forEach((d, i) => {
    for (const t of [...d.messages, ...d.enums]) declaredIn.set(t.name, [...(declaredIn.get(t.name) ?? []), i]);
  });
  const servicesIn = new Map<string, number[]>();
  docs.forEach((d, i) => { for (const sv of d.services) servicesIn.set(sv.name, [...(servicesIn.get(sv.name) ?? []), i]); });

  const resolverFor = (i: number) => {
    const visible = visibleFrom(i);
    const packages = new Set<string>();
    for (const j of visible) {
      const parts = docs[j].package ? docs[j].package.split('.') : [];
      for (let k = 1; k <= parts.length; k++) packages.add(parts.slice(0, k).join('.'));
    }
    /** How many visible files declare `n`. */
    const count = (n: string) => (declaredIn.get(n) ?? []).filter(j => visible.has(j)).length;
    // A scope component can be a package or a message: either may hold the next name.
    // A service is a scope too: protoc stops at it, and finding no type inside, reports an error.
    const isScope = (n: string) => count(n) > 0 || packages.has(n) || (servicesIn.get(n) ?? []).some(j => visible.has(j));
    return (ref: ProtoTypeRef): { name?: string; reason?: UnresolvedProtoType['reason'] } => {
      const settle = (n: string) => { const c = count(n); return c === 1 ? { name: n } : c > 1 ? { reason: 'ambiguous' as const } : { reason: 'undeclared' as const }; };
      if (ref.written.startsWith('.')) return settle(ref.written.slice(1));
      const [first, ...rest] = ref.written.split('.');
      const scope = ref.scope ? ref.scope.split('.') : [];
      for (let k = scope.length; k >= 0; k--) {
        const head = [...scope.slice(0, k), first].join('.');
        // A one-component name must find a TYPE: protoc skips a package of that name and keeps
        // looking outward. Only a compound name's first component may be a package.
        if (rest.length ? !isScope(head) : count(head) === 0) continue;
        return settle(rest.length ? `${head}.${rest.join('.')}` : head);
      }
      return { reason: 'undeclared' };
    };
  };
  const unresolved: UnresolvedProtoType[] = [];
  const out = docs.map((d, i) => { const resolve = resolverFor(i); return {
    ...d,
    messages: d.messages.map(m => ({
      ...m,
      fields: m.fields.map(f => {
        if (!f.ref) return f;
        const r = resolve(f.ref);
        if (r.name) return { ...f, resolved: r.name };
        unresolved.push({ file: d.file, line: f.line, written: f.ref.written, reason: r.reason! });
        return f;
      }),
    })),
    services: d.services.map(s => ({
      ...s,
      rpcs: s.rpcs.map(rpc => {
        const req = resolve(rpc.request);
        const res = resolve(rpc.response);
        for (const [r, ref] of [[req, rpc.request], [res, rpc.response]] as const) {
          if (!r.name) unresolved.push({ file: d.file, line: rpc.line, written: ref.written, reason: r.reason! });
        }
        return { ...rpc, ...(req.name ? { requestType: req.name } : {}), ...(res.name ? { responseType: res.name } : {}) };
      }),
    })),
  }; });
  return { docs: out, unresolved };
}
