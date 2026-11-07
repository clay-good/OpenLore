/**
 * gRPC server registrations (change: add-contract-graph-projection, protobuf phase).
 *
 * A gRPC server is wired up at ONE call that names both the service and its implementation, in
 * the code the generator emits for every language:
 *
 *   Go       pb.RegisterOrderServiceServer(s, &orderServer{})
 *   Python   orders_pb2_grpc.add_OrderServiceServicer_to_server(OrderServicer(), server)
 *   Node     server.addService(proto.orders.v1.OrderService.service, { getOrder, listOrders: list })
 *
 * That call is the literal evidence an `implements_endpoint` edge rests on: the RPC `GetOrder` of
 * `OrderService` is served by the method `GetOrder` of the type registered for it (Go, Python), or
 * by the function the implementation map names under that key (Node). No name similarity — a type
 * that merely looks like a servicer, or a method that merely shares an RPC's name, binds nothing.
 *
 * Scanning is a regex pass over source with comments and strings blanked first (`maskNonCode`),
 * so a registration written in a comment, a docstring or a test fixture's string is not read as
 * code. Generated stubs are skipped: they DEFINE the registration function, they do not call it.
 */

import { maskNonCode } from '../code-mask.js';

export type GrpcRuntime = 'go' | 'python' | 'node';

export interface GrpcRegistration {
  file: string;
  line: number;
  runtime: GrpcRuntime;
  /**
   * The service as the registration names it: `OrderService` (Go, Python), or the dotted
   * expression before `.service` (Node: `proto.orders.v1.OrderService`).
   */
  service: string;
  /** Go, Python: the implementing type, as written (its last component). */
  implType?: string;
  /**
   * The package (Go) or module (Python) the type was qualified with — `v2` in `&v2.OrderServer{}`.
   * Absent when written bare. It decides WHERE the type may be: a bare Go type is in the
   * registration's own package, a qualified one is not.
   */
  implQualifier?: string;
  /**
   * Node: `false` when the first argument is a service object rather than a `.service`
   * descriptor (`addService(services.GreeterService, …)`, the grpc-tools and ts-proto form). Such a
   * call is a gRPC registration only if it names a declared service, so an unknown one is dropped
   * rather than disclosed — `addService` is a common method name.
   */
  descriptor?: false;
  /** Node: each key of the implementation map, with the function it names (absent = written inline). */
  methods?: Array<{ key: string; fn?: string; imported?: true; from?: string }>;
  /** Why the implementation is not written literally at the registration (a variable, a factory call). */
  notLiteral?: string;
}

/** Registration-shaped calls examined per file: a real file has a handful. */
const MAX_MATCHES_PER_FILE = 1_000;
/** Characters of argument text read per registration: a registration is short. */
const MAX_ARG_CHARS = 16_384;

/** Generated gRPC stubs: they define the registration function rather than call it. */
const GENERATED = /(?:_grpc\.pb\.go|\.pb\.go|_pb2_grpc\.py|_pb2\.py|_grpc_pb\.[cm]?[jt]s|_pb\.[cm]?[jt]s)$/i;

/**
 * Whether a file is a generated gRPC stub. A stub is never an implementation either: Python's
 * `*_pb2_grpc.py` declares a client class named exactly like the service, with every RPC as a
 * method — the name a hand-written servicer usually has too.
 */
export const isGeneratedGrpcStub = (file: string): boolean => GENERATED.test(file);

/** Which runtime a file's registrations are read for. */
function runtimeOf(file: string): GrpcRuntime | undefined {
  if (/\.go$/i.test(file)) return 'go';
  if (/\.pyw?$/i.test(file)) return 'python';
  if (/\.[cm]?[jt]sx?$/i.test(file)) return 'node';
  return undefined;
}

/**
 * The top-level arguments of a call whose `(` is at `open`, split on commas outside brackets.
 * The text is already masked, so no string or comment can unbalance it. Undefined when the call
 * does not close within the bound.
 */
function callArgs(text: string, open: number): string[] | undefined {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  const end = Math.min(text.length, open + MAX_ARG_CHARS);
  for (let i = open + 1; i < end; i++) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) {
        if (c !== ')') return undefined;
        args.push(text.slice(start, i).trim());
        return args.filter((a, k) => a || k < args.length - 1);
      }
      depth--;
    } else if (c === ',' && depth === 0) {
      args.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  return undefined;
}

/** 1-based line of an offset, from a precomputed list of line starts. */
export function lineAt(starts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

const IDENT_PATH = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
const last = (path: string) => path.slice(path.lastIndexOf('.') + 1);

/** The type a written name means, with the qualifier it was written under (if any). */
const qualified = (path: string): { implType: string; implQualifier?: string } => {
  const i = path.lastIndexOf('.');
  return i < 0 ? { implType: path } : { implType: path.slice(i + 1), implQualifier: path.slice(0, i).split('.').pop()! };
};

/** Go: `&T{…}`, `T{…}`, `&pkg.T{}`, `new(T)` name a type; anything else does not. */
function goImplType(arg: string): { implType: string; implQualifier?: string } | undefined {
  const m = /^&?\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*\{[\s\S]*\}$/.exec(arg) ?? /^new\s*\(\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*\)$/.exec(arg);
  return m ? qualified(m[1]) : undefined;
}

/** Python: `Cls()`, `mod.Cls(args)` name a class; a variable or a factory call's result does not. */
function pythonImplType(arg: string): { implType: string; implQualifier?: string } | undefined {
  const m = /^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\(/.exec(arg);
  if (!m) return undefined;
  // The constructor call must be the whole argument: `Impl(cfg).wrap()` registers whatever
  // `wrap` returns, not an `Impl`.
  let depth = 0;
  for (let i = m[0].length - 1; i < arg.length; i++) {
    if (arg[i] === '(' || arg[i] === '[' || arg[i] === '{') depth++;
    else if (arg[i] === ')' || arg[i] === ']' || arg[i] === '}') { depth--; if (depth === 0 && i !== arg.length - 1) return undefined; }
  }
  if (depth !== 0) return undefined;
  const q = qualified(m[1]);
  // A lower-case callee is a factory function by Python convention, not the class itself.
  return /^[A-Z]/.test(q.implType) ? q : undefined;
}

/** Node: the keys of an object-literal implementation map, each with the function it names. */
export function nodeImplMap(arg: string): Array<{ key: string; fn?: string; base?: string }> | undefined {
  if (!arg.startsWith('{') || !arg.endsWith('}')) return undefined;
  const body = arg.slice(1, -1);
  const entries: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= body.length; i++) {
    const c = body[i];
    if (i === body.length || (c === ',' && depth === 0)) { entries.push(body.slice(start, i).trim()); start = i + 1; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
  }
  const out: Array<{ key: string; fn?: string; base?: string }> = [];
  for (const e of entries) {
    if (!e) continue;
    // A spread copies an unknown set of keys: the map is not literal.
    if (e.startsWith('...')) return undefined;
    const shorthand = /^([A-Za-z_$][\w$]*)$/.exec(e);
    if (shorthand) { out.push({ key: shorthand[1], fn: shorthand[1], base: shorthand[1] }); continue; }
    const pair = /^["']?([A-Za-z_$][\w$]*)["']?\s*:\s*([\s\S]+)$/.exec(e);
    if (pair) {
      const value = pair[2].trim();
      out.push(IDENT_PATH.test(value) ? { key: pair[1], fn: last(value), base: value.split('.')[0] } : { key: pair[1] });
      continue;
    }
    // A method written in the map (`getOrder(call, cb) { … }`): the function is inline.
    const method = /^(?:async\s+)?\*?\s*([A-Za-z_$][\w$]*)\s*\(/.exec(e);
    if (method) { out.push({ key: method[1], fn: method[1] }); continue; }
    return undefined;
  }
  return out;
}

/**
 * The names a JavaScript/TypeScript module binds from imports: `import a, { b, c as d } from`,
 * `import * as e from`, `const { f, g: h } = require(…)`, `const i = require(…)`. Read on masked
 * text, with every clause bounded, so a hostile file stays linear.
 */
export function importedNames(text: string): Map<string, ImportedName> {
  // Local name → the name it was exported under (`null` when the file states none: a default
  // import, a namespace, a whole module from `require`) and the module it came from.
  const out = new Map<string, ImportedName>();
  const addClause = (clause: string, destructure: 'as' | ':', from: string) => {
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces) {
      for (const part of braces[1].split(',')) {
        const p = part.trim().replace(/^type\s+/, '');
        const aliased = (destructure === 'as' ? /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/ : /^([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)$/).exec(p);
        if (aliased) { out.set(aliased[2], { exported: aliased[1], from }); continue; }
        if (/^[A-Za-z_$][\w$]*$/.test(p)) out.set(p, { exported: p, from });
      }
    }
    const rest = clause.replace(/\{[^}]*\}/, '');
    for (const m of rest.matchAll(/(?:\*\s*as\s+)?([A-Za-z_$][\w$]*)/g)) if (m[1] !== 'type' && m[1] !== 'as' && !out.has(m[1])) out.set(m[1], { exported: null, from });
  };
  // Specifiers survive the mask (it keeps module specifiers), so they are read from the same text.
  for (const m of text.matchAll(/\bimport\s+([^;'"`]{1,500}?)\s+from\s*['"]([^'"\n]{1,500})['"]/g)) addClause(m[1], 'as', m[2]);
  for (const m of text.matchAll(/\b(?:const|let|var)\s+(\{[^}]{0,500}\}|[A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:require|import)\s*\(\s*['"]([^'"\n]{1,500})['"]/g)) addClause(m[1], ':', m[2]);
  return out;
}

export interface ImportedName { exported: string | null; from: string }

/** A file and the name a function is defined under in it. */
export interface ImportTarget { file: string; name: string }

/** A repository-relative path normalized, or `undefined` when it climbs above the root. */
const posixNormalize = (path: string): string | undefined => {
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (!out.length) return undefined; out.pop(); } else out.push(seg);
  }
  return out.join('/');
};

/** The extensionless path a relative JS/TS specifier names, or `undefined` (a package, an escape). */
function jsModuleBase(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const dir = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : '';
  return posixNormalize(`${dir}/${specifier}`)?.replace(/\.(?:[cm]?[jt]s|[jt]sx)$/, '');
}

/** The module path a Python `from` names (`app/resolvers`), relative ones resolved; `undefined` past the root. */
function pythonModulePath(fromFile: string, module: string): { path: string; relative: boolean } | undefined {
  const dots = /^\.*/.exec(module)![0].length;
  const rest = module.slice(dots).split('.').filter(Boolean).join('/');
  if (!dots) return rest ? { path: rest, relative: false } : undefined;
  const parts = fromFile.split('/').slice(0, -1);
  if (dots - 1 > parts.length) return undefined;
  const up = parts.slice(0, parts.length - (dots - 1));
  const path = [...up, ...(rest ? [rest] : [])].join('/');
  return path ? { path, relative: true } : undefined;
}

/**
 * Whether `file` is the module a JS/TS import of `specifier` from `fromFile` names. Only RELATIVE
 * specifiers resolve here (`./orders`, `../db/orders.js`); a package, a path alias, or a path that
 * climbs above the repository root names a module this check cannot locate — so a same-named
 * function elsewhere is NOT the imported one.
 */
export function isImportedModule(fromFile: string, specifier: string, file: string): boolean {
  const base = jsModuleBase(fromFile, specifier);
  if (base === undefined) return false;
  const stem = file.replace(/\.(?:[cm]?[jt]sx?)$/, '');
  return stem === base || stem === (base ? `${base}/index` : 'index');
}

/**
 * Whether `file` is the module a Python `from <module> import …` in `fromFile` names: relative
 * (`.resolvers`, `..api.orders`) from the file's package, or absolute (`app.resolvers`) as a path
 * suffix. `<module>.py` or `<module>/__init__.py`.
 */
export function isImportedPythonModule(fromFile: string, module: string, file: string): boolean {
  const target = pythonModulePath(fromFile, module);
  if (!target) return false;
  const stem = file.replace(/\.pyw?$/, '');
  if (target.relative) return stem === target.path || stem === `${target.path}/__init__`;
  const t = target.path;
  return stem === t || stem.endsWith(`/${t}`) || stem === `${t}/__init__` || stem.endsWith(`/${t}/__init__`);
}

/** Re-export parts read per barrel, and files a module lookup may return: bounded, so one hostile barrel cannot stall a build. */
const MAX_REEXPORT_PARTS = 2_000;

/**
 * An import resolver over one set of files: the files (and names) an import of `name` from
 * `specifier` in `fromFile` can mean — the module the specifier names, and ONE level of re-export
 * (`export { a as name } from './x'`, `export * from './x'`, a Python package's `__init__.py` doing
 * `from .x import a as name`). A barrel `index.ts` is the common case; following further would be
 * guessing at a chain.
 *
 * Indexed once: modules are looked up by path stem, and each barrel's re-exports are parsed once,
 * so the cost is linear in the files and the imports, never their product.
 */
export function createImportResolver(files: readonly string[], contentOf: (file: string) => string | undefined) {
  const jsByStem = new Map<string, string[]>();
  const pyByStem = new Map<string, string[]>();
  const pyByBase = new Map<string, string[]>();
  const add = (m: Map<string, string[]>, k: string, f: string) => { const at = m.get(k); if (at) at.push(f); else m.set(k, [f]); };
  for (const f of files) {
    if (/\.[cm]?[jt]sx?$/.test(f)) add(jsByStem, f.replace(/\.(?:[cm]?[jt]sx?)$/, ''), f);
    else if (/\.pyw?$/.test(f)) {
      const stem = f.replace(/\.pyw?$/, '');
      add(pyByStem, stem, f);
      add(pyByBase, stem.slice(stem.lastIndexOf('/') + 1), f);
    }
  }
  const jsModules = (from: string, spec: string): string[] => {
    const base = jsModuleBase(from, spec);
    if (base === undefined) return [];
    return [...(jsByStem.get(base) ?? []), ...(jsByStem.get(base ? `${base}/index` : 'index') ?? [])];
  };
  const pyModules = (from: string, module: string): string[] => {
    const t = pythonModulePath(from, module);
    if (!t) return [];
    if (t.relative) return [...(pyByStem.get(t.path) ?? []), ...(pyByStem.get(`${t.path}/__init__`) ?? [])];
    const last = t.path.slice(t.path.lastIndexOf('/') + 1);
    const candidates = [...(pyByBase.get(last) ?? []), ...(pyByBase.get('__init__') ?? [])];
    return candidates.filter(f => isImportedPythonModule(from, module, f));
  };
  type Barrel = { named: Map<string, Array<{ spec: string; orig: string }>>; star: string[] };
  const barrels = new Map<string, Barrel>();
  const barrelOf = (m: string, runtime: 'node' | 'python'): Barrel => {
    const hit = barrels.get(m);
    if (hit) return hit;
    const b: Barrel = { named: new Map(), star: [] };
    barrels.set(m, b);
    const text = contentOf(m);
    if (text === undefined) return b;
    let parts = 0;
    const name = (exported: string, spec: string, orig: string) => {
      if (++parts > MAX_REEXPORT_PARTS) return;
      const at = b.named.get(exported);
      if (at) { if (at.length < 8) at.push({ spec, orig }); } else b.named.set(exported, [{ spec, orig }]);
    };
    if (runtime === 'node') {
      const masked = maskNonCode(text, 'js');
      for (const r of masked.matchAll(/\bexport\s*\{([^}]{0,2000})\}\s*from\s*['"]([^'"\n]{1,500})['"]/g)) {
        if (parts > MAX_REEXPORT_PARTS) break;
        for (const part of r[1].split(',')) {
          const a = /^\s*(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(part);
          if (a) name(a[2] ?? a[1], r[2], a[1]);
        }
      }
      for (const r of masked.matchAll(/\bexport\s*\*\s*from\s*['"]([^'"\n]{1,500})['"]/g)) {
        if (b.star.length >= MAX_REEXPORT_PARTS) break;
        if (!b.star.includes(r[1])) b.star.push(r[1]);
      }
    } else if (/(?:^|\/)__init__\.pyw?$/.test(m)) {
      for (const r of maskNonCode(text, 'python').matchAll(/^[ \t]*from[ \t]+(\.+[\w.]*)[ \t]+import[ \t]+(\([^)]{0,2000}\)|[^\n]{1,500})/gm)) {
        if (parts > MAX_REEXPORT_PARTS) break;
        for (const part of r[2].replace(/[()]/g, '').split(',')) {
          const a = /^\s*([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?\s*$/.exec(part);
          if (a) name(a[2] ?? a[1], r[1], a[1]);
        }
      }
    }
    return b;
  };
  return (fromFile: string, specifier: string, name: string, runtime: 'node' | 'python'): ImportTarget[] => {
    const modulesOf = (from: string, spec: string) => (runtime === 'node' ? jsModules(from, spec) : pyModules(from, spec));
    const modules = modulesOf(fromFile, specifier);
    const out: ImportTarget[] = modules.map(file => ({ file, name }));
    for (const m of modules) {
      const b = barrelOf(m, runtime);
      for (const r of b.named.get(name) ?? []) for (const f of modulesOf(m, r.spec)) out.push({ file: f, name: r.orig });
      for (const spec of b.star) for (const f of modulesOf(m, spec)) out.push({ file: f, name });
    }
    const seen = new Set<string>();
    return out.filter(t => { const k = `${t.file}\0${t.name}`; if (seen.has(k)) return false; seen.add(k); return true; });
  };
}

/** One import, resolved over `files` (see {@link createImportResolver}). */
export function importTargets(
  fromFile: string, specifier: string, name: string, runtime: 'node' | 'python',
  files: readonly string[], contentOf: (file: string) => string | undefined,
): ImportTarget[] {
  return createImportResolver(files, contentOf)(fromFile, specifier, name, runtime);
}

/** Every gRPC server registration in one source file. */
export function scanGrpcRegistrations(file: string, content: string): GrpcRegistration[] {
  const runtime = runtimeOf(file);
  if (!runtime || GENERATED.test(file)) return [];
  // Cheap gate before masking: the generated registration names appear literally.
  // Anchored at a word boundary: unanchored, `\w+` retried from every position of a long word,
  // which made one adversarial line quadratic.
  const marker = runtime === 'go' ? /\bRegister\w+Server\b/ : runtime === 'python' ? /\badd_\w+Servicer_to_server\b/ : /\.addService\b/;
  if (!marker.test(content)) return [];
  const text = maskNonCode(content, runtime === 'python' ? 'python' : 'js');
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  const out: GrpcRegistration[] = [];
  let imports: Map<string, ImportedName> | undefined;
  const pattern = runtime === 'go' ? /\bRegister([A-Z]\w*)Server\s*\(/g
    : runtime === 'python' ? /\badd_(\w+)Servicer_to_server\s*\(/g
      : /\.addService\s*\(/g;
  let seen = 0;
  for (const m of text.matchAll(pattern)) {
    if (++seen > MAX_MATCHES_PER_FILE) break;
    const at = m.index!;
    // The generated stub's own definition (or any method of that name), not a call.
    if (/\b(?:func\s*(?:\([^()\n]*\)\s*)?|def\s+)$/.test(text.slice(Math.max(0, at - 120), at))) continue;
    // Node: a call whose first argument is not a dotted name is not a registration. Checked on a
    // short slice before the bounded argument read, which costs up to 16 K characters per call.
    if (runtime === 'node' && !/^\s*[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*,/.test(text.slice(at + m[0].length, at + m[0].length + 512))) continue;
    const args = callArgs(text, at + m[0].length - 1);
    // grpc-gateway's `Register…HandlerServer(ctx, mux, server)` registers an HTTP proxy, not a
    // gRPC server. It takes three arguments; a real service named `…Handler` takes two.
    if (runtime === 'go' && m[1].endsWith('Handler') && args?.length === 3) continue;
    const line = lineAt(starts, at);
    if (!args) {
      // Node names its service in the first argument, not the matched name: read it from the
      // call's head, and report nothing when it is not a `.service` descriptor (see below).
      const service = runtime === 'node'
        ? /^\s*([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\.\s*service\s*,/.exec(text.slice(at + m[0].length, at + m[0].length + 1_024))?.[1].replace(/\s+/g, '')
        : m[1];
      if (service) out.push({ file, line, runtime, service, notLiteral: 'the registration call could not be read' });
      continue;
    }
    if (runtime === 'go') {
      const impl = args[1] !== undefined ? goImplType(args[1]) : undefined;
      out.push({ file, line, runtime, service: m[1], ...(impl ?? { notLiteral: `the implementation is \`${(args[1] ?? '').slice(0, 60)}\`, not a type written at the registration` }) });
    } else if (runtime === 'python') {
      const impl = args[0] !== undefined ? pythonImplType(args[0]) : undefined;
      out.push({ file, line, runtime, service: m[1], ...(impl ?? { notLiteral: `the servicer is \`${(args[0] ?? '').slice(0, 60)}\`, not a class instantiated at the registration` }) });
    } else {
      const svc = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.service$/.exec(args[0] ?? '');
      // Without the `.service` descriptor, the first argument may still be the service object the
      // static generators export (`services.GreeterService`); the projector keeps it only when it
      // names a declared service.
      const bare = !svc && IDENT_PATH.test(args[0] ?? '') ? args[0] : undefined;
      if (!svc && !bare) continue;
      const parsed = args[1] !== undefined ? nodeImplMap(args[1]) : undefined;
      // Whether each handler is IMPORTED into this file: only then may it be looked for outside
      // it. A same-named function elsewhere that this file never imports is not its handler.
      imports ??= importedNames(text);
      const methods = parsed?.map(({ base, ...e }) => {
        if (!base || !imports!.has(base)) return e;
        const { exported, from } = imports!.get(base)!;
        // The handler itself is the imported binding: look it up by the name it was EXPORTED
        // under (`import { getOrder as get }` names `getOrder`), never by the local alias, and only
        // in the module it was imported FROM. A default import states no such name.
        if (base === e.fn) return exported ? { ...e, fn: exported, imported: true as const, from } : e;
        // `impl.listOrders` on an imported module: the member is named as written.
        return { ...e, imported: true as const, from };
      });
      out.push({ file, line, runtime, service: svc ? svc[1] : bare!, ...(bare ? { descriptor: false as const } : {}), ...(methods ? { methods } : { notLiteral: `the implementation is \`${(args[1] ?? '').slice(0, 60)}\`, not an object literal` }) });
    }
  }
  return out;
}
