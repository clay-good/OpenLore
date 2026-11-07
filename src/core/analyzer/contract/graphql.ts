/**
 * GraphQL SDL reader (change: add-contract-graph-projection, GraphQL phase).
 *
 * Reads one schema file (`.graphql`, `.graphqls`, `.gql`) into a normalized element model: object,
 * interface, input, enum, union and scalar types with their fields, arguments, enum values, union
 * members and implemented interfaces, plus the `schema { query: … }` roots. `extend` definitions are
 * kept apart and merged across files by {@link mergeGraphqlSchema}, because a modular schema splits
 * one type over many files. Deterministic and offline: a small hand-written tokenizer, no
 * `graphql-js`, no network.
 *
 * A file holding only operations and fragments is a CLIENT document, not a schema, and is reported
 * as such. Directives other than `@deprecated` are outside the model: each one is named in
 * `unassessed` and hashed into its element, so a change to one is seen and never read as "no
 * change". Every name is bounded, so a hostile file stays linear.
 */

import { createHash } from 'node:crypto';
import { MAX_SPEC_BYTES } from './openapi.js';

/** Whether a path is a GraphQL file this reader may read. */
export const isGraphqlPath = (path: string): boolean => /\.(?:graphqls?|gql)$/i.test(path);

/** The scalars GraphQL itself defines: never a reference to a declared type. */
const BUILT_IN_SCALARS: ReadonlySet<string> = new Set(['Int', 'Float', 'String', 'Boolean', 'ID']);
export const isBuiltInScalar = (name: string): boolean => BUILT_IN_SCALARS.has(name);

/** The longest name read; past it the file is unread (a name is a single identifier in GraphQL). */
const MAX_NAME_CHARS = 1_024;
/** List nesting read at most in a type reference (`[[[T]]]`): deeper is unreadable. */
const MAX_LIST_DEPTH = 32;

export type GqlKind = 'object' | 'interface' | 'input' | 'enum' | 'union' | 'scalar';

export interface GqlArg {
  name: string;
  /** The type as written, whitespace removed: `[ID!]!`. */
  type: string;
  /** The default value as written (whitespace collapsed), when there is one. */
  defaultValue?: string;
  deprecated: boolean;
  /** A hash of the directives other than `@deprecated`. */
  directivesHash: string;
  line: number;
}

export interface GqlField {
  name: string;
  type: string;
  /** Arguments (object and interface fields only), in declaration order. */
  args: GqlArg[];
  /** The default value (input fields only). */
  defaultValue?: string;
  deprecated: boolean;
  directivesHash: string;
  line: number;
  /** Set by {@link mergeGraphqlSchema} on a field an `extend` in another file added. */
  file?: string;
}

export interface GqlEnumValue { name: string; deprecated: boolean; directivesHash: string; line: number }

/** A type definition — or, with `extension`, the fields an `extend` adds to one. */
export interface GqlType {
  kind: GqlKind;
  name: string;
  line: number;
  extension: boolean;
  /** Object, interface and input fields. */
  fields: GqlField[];
  /** Enum values. */
  values: GqlEnumValue[];
  /** Union members. */
  members: string[];
  /** Interfaces an object or interface implements. */
  interfaces: string[];
  /** A hash of the type's own directives (`@deprecated` is not valid on a type, so all of them). */
  directivesHash: string;
}

/** A directive definition: `directive @auth(role: Role!) repeatable on FIELD_DEFINITION | OBJECT`. */
export interface GqlDirectiveDef {
  name: string;
  args: GqlArg[];
  repeatable: boolean;
  locations: string[];
  line: number;
}

export interface GqlDocument {
  file: string;
  format: 'graphql-sdl';
  /** Root operation types the file names in `schema { … }` (or `extend schema`). */
  roots: Partial<Record<'query' | 'mutation' | 'subscription', string>>;
  /**
   * Whether the file holds a `schema { … }` DEFINITION (not an `extend schema`). A schema with
   * one has exactly the roots it names: the default names apply only when no file defines one.
   */
  hasSchemaDefinition: boolean;
  /** A hash of the directives on `schema` / `extend schema` (Federation's `@link`, …). */
  schemaDirectivesHash: string;
  directiveDefs: GqlDirectiveDef[];
  types: GqlType[];
  /** Constructs outside the model: custom directives used, by name, and operations in a schema file. */
  unassessed: string[];
}

/** A GraphQL file that is a client document (operations and fragments only), not a schema. */
export interface GqlClientDocument { file: string; clientDocument: true }

// ── Tokenizer ──────────────────────────────────────────────────────────────

interface Tok { t: 'name' | 'num' | 'str' | 'punct'; v: string; line: number }
const STRING_ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
class GqlSyntaxError extends Error {}

function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let line = 1;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '\n') { line++; i++; continue; }
    // A lone carriage return is a line terminator too (CRLF counts once, at its `\n`).
    if (c === '\r') { if (text[i + 1] !== '\n') line++; i++; continue; }
    // Commas are insignificant in GraphQL, exactly like whitespace.
    if (c === ' ' || c === '\t' || c === '\r' || c === ',' || c === '﻿') { i++; continue; }
    if (c === '#') { while (i < n && text[i] !== '\n') i++; continue; }
    if (c === '"') {
      const start = line;
      if (text.startsWith('"""', i)) {
        let j = i + 3;
        let v = '';
        for (;;) {
          if (j >= n) throw new GqlSyntaxError(`line ${start}: unterminated block string`);
          if (text.startsWith('\\"""', j)) { v += '"""'; j += 4; continue; }
          if (text.startsWith('"""', j)) break;
          if (text[j] === '\n') line++;
          v += text[j++];
        }
        out.push({ t: 'str', v, line: start });
        i = j + 3;
        continue;
      }
      let j = i + 1;
      let v = '';
      while (j < n && text[j] !== '"') {
        if (text[j] === '\n') throw new GqlSyntaxError(`line ${start}: unterminated string`);
        if (text[j] === '\\' && j + 1 < n) {
          if (text[j + 1] === '\n') throw new GqlSyntaxError(`line ${start}: unterminated string`);
          // `\u00e9` and `"é"` are one value: decoded, so a default rewritten in either form is no change.
          const u = text[j + 1] === 'u' ? /^u(?:([0-9a-fA-F]{4})|\{([0-9a-fA-F]{1,6})\})/.exec(text.slice(j + 1, j + 11)) : null;
          const cp = u ? parseInt(u[1] ?? u[2], 16) : -1;
          if (u && cp <= 0x10ffff) { v += String.fromCodePoint(cp); j += 1 + u[0].length; continue; }
          v += STRING_ESCAPES[text[j + 1]] ?? text[j + 1];
          j += 2;
          continue;
        }
        v += text[j++];
      }
      if (j >= n) throw new GqlSyntaxError(`line ${start}: unterminated string`);
      out.push({ t: 'str', v, line: start });
      i = j + 1;
      continue;
    }
    if (/[_A-Za-z]/.test(c)) {
      let j = i + 1;
      while (j < n && /\w/.test(text[j])) j++;
      if (j - i > MAX_NAME_CHARS) throw new GqlSyntaxError(`line ${line}: a name longer than ${MAX_NAME_CHARS} characters`);
      out.push({ t: 'name', v: text.slice(i, j), line });
      i = j;
      continue;
    }
    if (/[-0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w.+-]/.test(text[j]) && !((text[j] === '+' || text[j] === '-') && !/[eE]/.test(text[j - 1]))) j++;
      out.push({ t: 'num', v: text.slice(i, j), line });
      i = j;
      continue;
    }
    if (text.startsWith('...', i)) { out.push({ t: 'punct', v: '...', line }); i += 3; continue; }
    if ('!$&()=:@[]{}|'.includes(c)) { out.push({ t: 'punct', v: c, line }); i++; continue; }
    throw new GqlSyntaxError(`line ${line}: unexpected character ${JSON.stringify(c).slice(0, 12)}`);
  }
  return out;
}

const sha = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 16);
/** The directive hash of an element with no directive other than `@deprecated`. */
const NO_DIRECTIVES = sha('');

/** A token as an error message names it: never a string's text, at most 40 characters of anything else. */
const shown = (t: Tok | undefined): string => (!t ? 'end of file' : t.t === 'str' ? 'a string' : `\`${t.v.length > 40 ? `${t.v.slice(0, 40)}…` : t.v}\``);

// ── Parser ─────────────────────────────────────────────────────────────────

const TYPE_KEYWORDS: Record<string, GqlKind> = { type: 'object', interface: 'interface', input: 'input', enum: 'enum', union: 'union', scalar: 'scalar' };
const EXECUTABLE = new Set(['query', 'mutation', 'subscription', 'fragment']);

/**
 * Parse one file. Returns an `error` when it cannot be read, or `{ clientDocument: true }` when it
 * holds operations and fragments only.
 */
export function readGraphql(file: string, text: string): GqlDocument | GqlClientDocument | { file: string; error: string } {
  if (text.length > MAX_SPEC_BYTES) return { file, error: `larger than ${MAX_SPEC_BYTES / 1024 / 1024} MB` };
  try {
    return parse(file, tokenize(text));
  } catch (e) {
    return { file, error: e instanceof Error ? e.message.split('\n')[0] : String(e) };
  }
}

function parse(file: string, toks: Tok[]): GqlDocument | GqlClientDocument {
  let p = 0;
  const peek = (k = 0): Tok | undefined => toks[p + k];
  const fail = (msg: string, t: Tok | undefined = peek()): never => {
    throw new GqlSyntaxError(`line ${t?.line ?? toks[toks.length - 1]?.line ?? 1}: ${msg}`);
  };
  const next = (): Tok => toks[p++] ?? fail('unexpected end of file');
  const is = (v: string, k = 0) => peek(k)?.t === 'punct' && peek(k)?.v === v;
  const isName = (v: string, k = 0) => peek(k)?.t === 'name' && peek(k)?.v === v;
  const expect = (v: string): Tok => (is(v) ? next() : fail(`expected \`${v}\`, found ${shown(peek())}`));
  const name = (what: string): Tok => (peek()?.t === 'name' ? next() : fail(`expected ${what}, found ${shown(peek())}`));
  const skipDescription = () => { if (peek()?.t === 'str') next(); };

  const unassessed = new Set<string>();

  /** A balanced `{…}`, `[…]` or `(…)` group, or one token: a value or a selection set, as text. */
  const skipGroup = (): string => {
    const open = peek();
    if (!open) fail('unexpected end of file');
    const closer: Record<string, string> = { '{': '}', '[': ']', '(': ')' };
    if (open!.t !== 'punct' || !closer[open!.v]) return next().v;
    const stack: string[] = [];
    const parts: string[] = [];
    do {
      const t = next();
      if (t.t === 'punct' && closer[t.v]) stack.push(closer[t.v]);
      else if (t.t === 'punct' && (t.v === '}' || t.v === ']' || t.v === ')')) {
        if (stack.pop() !== t.v) fail(`unbalanced ${shown(t)}`, t);
      }
      parts.push(t.t === 'str' ? JSON.stringify(t.v) : t.v);
    } while (stack.length);
    return parts.join(' ');
  };
  /**
   * A value literal (a default value), in canonical form: object fields sorted, numbers as
   * numbers. `{a: 1, b: 2}` and `{b: 2, a: 1}` — or `1` and `1.0` — are one default, not a change.
   */
  const value = (depth = 0): string => {
    if (depth > MAX_LIST_DEPTH) fail(`a value nested deeper than ${MAX_LIST_DEPTH}`);
    const t = peek();
    if (!t) return fail('unexpected end of file');
    if (is('$')) { next(); return `$${name('a variable name').v}`; }
    if (is('[')) {
      next();
      const items: string[] = [];
      while (!is(']')) items.push(value(depth + 1));
      expect(']');
      return `[${items.join(',')}]`;
    }
    if (is('{')) {
      next();
      const fields: Array<[string, string]> = [];
      while (!is('}')) { const k = name('an input field name').v; expect(':'); fields.push([k, value(depth + 1)]); }
      expect('}');
      return `{${fields.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}:${v}`).join(',')}}`;
    }
    next();
    if (t.t === 'str') return JSON.stringify(t.v);
    if (t.t === 'num') { const n = Number(t.v); return Number.isFinite(n) ? String(n) : t.v; }
    if (t.t === 'name') return t.v;
    return fail(`expected a value, found ${shown(t)}`, t);
  };
  /** Directives: whether `@deprecated` is among them, and a hash of the others. */
  const directives = (): { deprecated: boolean; hash: string } => {
    let deprecated = false;
    const others: string[] = [];
    while (is('@')) {
      next();
      const d = name('a directive name').v;
      const args = is('(') ? skipGroup() : '';
      if (d === 'deprecated') deprecated = true;
      else { others.push(`${d}${args}`); unassessed.add(`@${d}`); }
    }
    return { deprecated, hash: sha(others.sort().join('\n')) };
  };
  /** A type reference, whitespace removed: `[ID!]!`. */
  const typeRef = (depth = 0): string => {
    if (depth > MAX_LIST_DEPTH) fail(`list types nested deeper than ${MAX_LIST_DEPTH}`);
    let t: string;
    if (is('[')) { next(); t = `[${typeRef(depth + 1)}]`; expect(']'); } else t = name('a type name').v;
    if (is('!')) { next(); t += '!'; }
    return t;
  };
  const inputValue = (): GqlArg => {
    skipDescription();
    const n = name('an argument or input field name');
    expect(':');
    const type = typeRef();
    const defaultValue = is('=') ? (next(), value()) : undefined;
    const d = directives();
    return { name: n.v, type, ...(defaultValue !== undefined ? { defaultValue } : {}), deprecated: d.deprecated, directivesHash: d.hash, line: n.line };
  };
  const implementsList = (): string[] => {
    const out: string[] = [];
    if (!isName('implements')) return out;
    next();
    if (is('&')) next();
    out.push(name('an interface name').v);
    while (is('&')) { next(); out.push(name('an interface name').v); }
    return out;
  };

  const clientDirective = toks.some((t, k) => t.t === 'name' && t.v === 'client' && toks[k - 1]?.t === 'punct' && toks[k - 1].v === '@');
  const roots: GqlDocument['roots'] = {};
  const types: GqlType[] = [];
  const directiveDefs: GqlDirectiveDef[] = [];
  const schemaDirectives: string[] = [];
  let hasSchemaDefinition = false;
  let sawTypeSystem = false;
  let sawExecutable = false;

  while (p < toks.length) {
    skipDescription();
    const extension = isName('extend');
    if (extension) next();
    const kw = peek();
    if (!kw) fail('unexpected end of file');
    if (kw!.t === 'punct' && kw!.v === '{' && !extension) { sawExecutable = true; skipGroup(); continue; }
    if (kw!.t !== 'name') fail(`unexpected ${shown(kw)}`, kw);
    if (EXECUTABLE.has(kw!.v) && !extension) {
      // An operation or fragment: skip to the end of its selection set.
      sawExecutable = true;
      next();
      while (p < toks.length && !is('{')) {
        if (is('(')) skipGroup(); else next();
      }
      expect('{');
      p--;
      skipGroup();
      continue;
    }
    if (kw!.v === 'schema') {
      sawTypeSystem = true;
      if (!extension) {
        // A document defines its schema once; a second definition is refused, as graphql-js does.
        if (hasSchemaDefinition) fail('a second `schema` definition', kw);
        hasSchemaDefinition = true;
      }
      next();
      const d = directives();
      if (d.hash !== NO_DIRECTIVES) schemaDirectives.push(d.hash);
      if (!is('{')) { if (extension) continue; fail('expected `{` after `schema`'); }
      next();
      while (!is('}')) {
        const op = name('`query`, `mutation` or `subscription`');
        if (op.v !== 'query' && op.v !== 'mutation' && op.v !== 'subscription') fail(`unexpected ${shown(op)} in \`schema\``, op);
        const kind = op.v as 'query' | 'mutation' | 'subscription';
        if (roots[kind]) fail(`the ${kind} root is named twice`, op);
        expect(':');
        roots[kind] = name('a type name').v;
      }
      expect('}');
      continue;
    }
    if (kw!.v === 'directive' && !extension) {
      // A directive definition: its arguments, `repeatable` and locations are modeled and diffed.
      sawTypeSystem = true;
      next();
      expect('@');
      const dn = name('a directive name');
      const args: GqlArg[] = [];
      if (is('(')) {
        next();
        const seenArgs = new Set<string>();
        while (!is(')')) {
          const a = inputValue();
          if (seenArgs.has(a.name)) fail(`argument \`${a.name}\` declared twice on @${dn.v}`);
          seenArgs.add(a.name);
          args.push(a);
        }
        expect(')');
      }
      const repeatable = isName('repeatable') ? (next(), true) : false;
      if (!isName('on')) fail('expected `on` in a directive definition');
      next();
      if (is('|')) next();
      const locations = [name('a directive location').v];
      while (is('|')) { next(); locations.push(name('a directive location').v); }
      directiveDefs.push({ name: dn.v, args, repeatable, locations: [...new Set(locations)].sort(), line: dn.line });
      continue;
    }
    const kind = TYPE_KEYWORDS[kw!.v];
    if (!kind) fail(`unexpected ${shown(kw)} at the top level`, kw);
    sawTypeSystem = true;
    next();
    const n = name('a type name');
    const t: GqlType = { kind, name: n.v, line: n.line, extension, fields: [], values: [], members: [], interfaces: [], directivesHash: '' };
    if (kind === 'object' || kind === 'interface') t.interfaces = implementsList();
    t.directivesHash = directives().hash;
    if (kind === 'union' && is('=')) {
      next();
      if (is('|')) next();
      t.members.push(name('a union member').v);
      while (is('|')) { next(); t.members.push(name('a union member').v); }
    } else if ((kind === 'object' || kind === 'interface' || kind === 'input') && is('{')) {
      next();
      const seen = new Set<string>();
      while (!is('}')) {
        skipDescription();
        if (kind === 'input') {
          const v = inputValue();
          if (seen.has(v.name)) fail(`field ${shown({ t: 'name', v: v.name, line: v.line })} declared twice in ${t.name}`);
          seen.add(v.name);
          t.fields.push({ name: v.name, type: v.type, args: [], ...(v.defaultValue !== undefined ? { defaultValue: v.defaultValue } : {}), deprecated: v.deprecated, directivesHash: v.directivesHash, line: v.line });
          continue;
        }
        const f = name('a field name');
        if (seen.has(f.v)) fail(`field ${shown(f)} declared twice in ${t.name}`, f);
        seen.add(f.v);
        const args: GqlArg[] = [];
        if (is('(')) {
          next();
          const seenArgs = new Set<string>();
          while (!is(')')) {
            const a = inputValue();
            // A repeated argument name would let the last one silently win every comparison.
            if (seenArgs.has(a.name)) fail(`argument \`${a.name}\` declared twice on ${t.name}.${f.v}`);
            seenArgs.add(a.name);
            args.push(a);
          }
          expect(')');
        }
        expect(':');
        const type = typeRef();
        const d = directives();
        t.fields.push({ name: f.v, type, args, deprecated: d.deprecated, directivesHash: d.hash, line: f.line });
      }
      expect('}');
    } else if (kind === 'enum' && is('{')) {
      next();
      const seen = new Set<string>();
      while (!is('}')) {
        skipDescription();
        const v = name('an enum value');
        if (seen.has(v.v)) fail(`enum value ${shown(v)} declared twice in ${t.name}`, v);
        seen.add(v.v);
        const d = directives();
        t.values.push({ name: v.v, deprecated: d.deprecated, directivesHash: d.hash, line: v.line });
      }
      expect('}');
    }
    types.push(t);
  }

  // Operations using `@client` beside type definitions are Apollo local state: the types extend a
  // CLIENT cache, not a server's API. The whole file is a client document.
  if (sawExecutable && !sawTypeSystem) return { file, clientDocument: true };
  if (sawExecutable && clientDirective) return { file, clientDocument: true };
  if (sawExecutable) unassessed.add('operations in a schema file');
  const byName = <T extends { name: string }>(a: T, b: T) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return {
    file, format: 'graphql-sdl', roots, hasSchemaDefinition,
    schemaDirectivesHash: schemaDirectives.length ? sha(schemaDirectives.sort().join('|')) : NO_DIRECTIVES,
    directiveDefs: directiveDefs.sort(byName),
    types: types.sort((a, b) => byName(a, b) || Number(a.extension) - Number(b.extension) || a.line - b.line),
    unassessed: [...unassessed].sort(),
  };
}

// ── One schema across files ────────────────────────────────────────────────

/** A merged type, with the files that define and extend it. */
export interface GqlMergedType extends GqlType {
  /** The file holding the definition (not an extension), or the first extension's file. */
  file: string;
  /** Files that extend it, sorted. */
  extendedIn: string[];
  /**
   * No file read defines it; only `extend`s do. A Federation 1 subgraph writes
   * `extend type Query { … }` and `extend type User @key(…)` for types the gateway defines, so the
   * extensions ARE this repository's contract and are compared as such.
   */
  extensionOnly?: true;
}

export type GqlRootKind = 'query' | 'mutation' | 'subscription';

export interface GqlSchema {
  /** Types by name, definitions with their extensions folded in. A name defined twice is absent. */
  types: Map<string, GqlMergedType>;
  /**
   * Root operation type names. When a file defines `schema { … }`, exactly the roots it names;
   * otherwise the default names `Query`, `Mutation`, `Subscription` (as GraphQL itself says).
   */
  roots: Partial<Record<GqlRootKind, string>>;
  /** Root kinds two files name differently: no root of that kind is assessed. */
  rootConflicts: GqlRootKind[];
  /** Names defined in more than one file, with a fingerprint of all their definitions. */
  ambiguous: Array<{ name: string; files: string[]; fingerprint: string }>;
  /** `extend`s of a type no file read defines (projected as extension-only types). */
  orphanExtensions: Array<{ name: string; file: string }>;
  /** Directive definitions by name; one defined in two files is absent (see `ambiguousDirectives`). */
  directives: Map<string, GqlDirectiveDef & { file: string }>;
  /** Directives defined in more than one file, with a fingerprint of all their definitions. */
  ambiguousDirectives: Array<{ name: string; files: string[]; fingerprint: string }>;
  /** A hash of every directive on `schema` / `extend schema`. */
  schemaDirectivesHash: string;
  conflicts: string[];
}

/** A definition's content for comparison: everything but its line numbers. */
const fingerprintOf = (x: unknown): string => sha(JSON.stringify(x, (k, v) => (k === 'line' ? undefined : v)));

/**
 * Merge every read document into ONE schema, as a GraphQL server does: one global namespace,
 * definitions and their `extend`s folded together. A name defined in two files — two services'
 * schemas in one repository, or a copy beside its source — is ambiguous and dropped from the
 * merged map, never guessed between; its fingerprint is kept so a change to it is still seen.
 */
export function mergeGraphqlSchema(docs: readonly GqlDocument[]): GqlSchema {
  const defs = new Map<string, Array<{ file: string; t: GqlType }>>();
  const exts = new Map<string, Array<{ file: string; t: GqlType }>>();
  const declaredRoots: Partial<Record<GqlRootKind, string>> = {};
  const rootConflicts = new Set<GqlRootKind>();
  const conflicts: string[] = [];
  const directiveAt = new Map<string, Array<GqlDirectiveDef & { file: string }>>();
  const schemaDirectives: string[] = [];
  let defined = false;
  for (const d of [...docs].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))) {
    if (d.hasSchemaDefinition) defined = true;
    if (d.schemaDirectivesHash !== NO_DIRECTIVES) schemaDirectives.push(d.schemaDirectivesHash);
    for (const [op, type] of Object.entries(d.roots) as Array<[GqlRootKind, string]>) {
      if (declaredRoots[op] && declaredRoots[op] !== type) {
        rootConflicts.add(op);
        conflicts.push(`the ${op} root is \`${declaredRoots[op]}\` in one file and \`${type}\` in another`);
      } else declaredRoots[op] = type;
    }
    for (const t of d.types) {
      const into = t.extension ? exts : defs;
      const at = into.get(t.name);
      if (at) at.push({ file: d.file, t }); else into.set(t.name, [{ file: d.file, t }]);
    }
    for (const dd of d.directiveDefs) {
      const at = directiveAt.get(dd.name);
      if (at) at.push({ ...dd, file: d.file }); else directiveAt.set(dd.name, [{ ...dd, file: d.file }]);
    }
  }
  // With a `schema` definition anywhere, exactly the roots named; without one, the defaults.
  const roots: GqlSchema['roots'] = defined ? { ...declaredRoots } : { query: 'Query', mutation: 'Mutation', subscription: 'Subscription', ...declaredRoots };
  for (const k of rootConflicts) delete roots[k];
  const types = new Map<string, GqlMergedType>();
  const ambiguous: GqlSchema['ambiguous'] = [];
  for (const [name, at] of defs) {
    if (at.length > 1) {
      ambiguous.push({ name, files: at.map(x => x.file).sort(), fingerprint: fingerprintOf([...at.map(x => x.t), ...(exts.get(name) ?? []).map(x => x.t)].map(fingerprintOf).sort()) });
      continue;
    }
    const { file, t } = at[0];
    types.set(name, { ...t, file, extendedIn: [], fields: [...t.fields], values: [...t.values], members: [...t.members], interfaces: [...t.interfaces] });
  }
  const orphanExtensions: GqlSchema['orphanExtensions'] = [];
  for (const [name, at] of exts) {
    let base = types.get(name);
    if (!base) {
      if (defs.has(name)) continue; // ambiguous: in its fingerprint
      for (const x of at) orphanExtensions.push({ name, file: x.file });
      // Extension-only: the first extension stands for the definition the gateway holds.
      const first = at[0];
      base = { ...first.t, extension: false, file: first.file, extendedIn: [], extensionOnly: true, fields: [], values: [], members: [], interfaces: [], directivesHash: NO_DIRECTIVES };
      types.set(name, base);
    }
    const extDirectives: string[] = [];
    // Built once per type, not once per extension: thousands of `extend type Query` were quadratic.
    const fieldNames = new Set(base.fields.map(f => f.name));
    const valueNames = new Set(base.values.map(v => v.name));
    const memberNames = new Set(base.members);
    const interfaceNames = new Set(base.interfaces);
    for (const { file, t } of at) {
      if (t.kind !== base.kind) { conflicts.push(`\`extend ${t.kind} ${name}\` in ${file} extends a ${base.kind}`); continue; }
      if (file !== base.file || !base.extensionOnly) base.extendedIn.push(file);
      for (const f of t.fields) {
        if (fieldNames.has(f.name)) conflicts.push(`field \`${name}.${f.name}\` is declared twice (an extension in ${file})`);
        else { fieldNames.add(f.name); base.fields.push(file === base.file ? f : { ...f, file }); }
      }
      for (const v of t.values) if (!valueNames.has(v.name)) { valueNames.add(v.name); base.values.push(v); }
      for (const m of t.members) if (!memberNames.has(m)) { memberNames.add(m); base.members.push(m); }
      for (const i of t.interfaces) if (!interfaceNames.has(i)) { interfaceNames.add(i); base.interfaces.push(i); }
      if (t.directivesHash !== NO_DIRECTIVES) extDirectives.push(t.directivesHash);
    }
    // Folded in independent of file order, and only when an extension carries a directive: moving
    // fields into a bare `extend`, or an extension to another file, changes no directive.
    if (extDirectives.length) base.directivesHash = sha([base.directivesHash, ...extDirectives.sort()].join('|'));
    base.extendedIn = [...new Set(base.extendedIn)].sort();
  }
  const directives: GqlSchema['directives'] = new Map();
  const ambiguousDirectives: GqlSchema['ambiguousDirectives'] = [];
  for (const [name, at] of directiveAt) {
    if (at.length > 1) {
      ambiguousDirectives.push({ name, files: at.map(x => x.file).sort(), fingerprint: fingerprintOf(at.map(({ file: _f, ...d }) => fingerprintOf(d)).sort()) });
      continue;
    }
    directives.set(name, at[0]);
  }
  return {
    types, roots, rootConflicts: [...rootConflicts].sort(), ambiguous: ambiguous.sort((a, b) => (a.name < b.name ? -1 : 1)),
    orphanExtensions, directives, ambiguousDirectives: ambiguousDirectives.sort((a, b) => (a.name < b.name ? -1 : 1)), schemaDirectivesHash: schemaDirectives.length ? sha(schemaDirectives.sort().join('|')) : NO_DIRECTIVES,
    conflicts: conflicts.sort(),
  };
}

/**
 * The schema paths Relay configs name (`"relay": { "schema": "./schema/schema.graphql" }` in a
 * `package.json`, `schema: '…'` in `relay.config.*`), resolved from the config's directory.
 */
export function relaySchemaPaths(configs: ReadonlyArray<{ path: string; content: string }>): Set<string> {
  const out = new Set<string>();
  for (const c of configs) {
    const dir = c.path.includes('/') ? c.path.slice(0, c.path.lastIndexOf('/')) : '';
    const body = /package\.json$/.test(c.path) ? /"relay"\s*:\s*\{([^}]{0,4000})\}/.exec(c.content)?.[1] : c.content;
    if (!body) continue;
    const m = /["']?schema["']?\s*:\s*["']([^"'\n]{1,500})["']/.exec(body);
    if (!m) continue;
    // Only a schema INSIDE the config's own directory is the Relay project's copy. A path that climbs
    // out of it — `../api/schema.graphql`, or past the repository root — names someone else's
    // schema (often this repository's own server), which must never be dropped on its say-so.
    const parts: string[] = [];
    let escaped = false;
    for (const seg of m[1].split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') { if (!parts.length) { escaped = true; break; } parts.pop(); } else parts.push(seg);
    }
    if (escaped || !parts.length) continue;
    out.add([...(dir ? [dir] : []), ...parts].join('/'));
  }
  return out;
}

/** The named type inside a type reference: `[Order!]!` → `Order`. */
export const namedType = (type: string): string => type.replace(/[[\]!]/g, '');
