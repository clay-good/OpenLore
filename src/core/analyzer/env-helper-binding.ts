/**
 * One-hop environment-variable helper binding (change: follow-env-name-through-helper).
 *
 * The env extractor reads a variable's NAME out of a literal at the read site:
 * `os.Getenv("PORT")`, `process.env.PORT`. A very common idiom defeats that —
 * the read is inside a one-line wrapper and the name is passed in:
 *
 * ```go
 * mustMapEnv(&svc.productCatalogSvcAddr, "PRODUCT_CATALOG_SERVICE_ADDR")   // ← the name lives here
 * …
 * func mustMapEnv(target *string, envKey string) { v := os.Getenv(envKey); … }   // ← the read lives here
 * ```
 *
 * The wrapper's own `os.Getenv(envKey)` names no variable, so before this module
 * the whole call site was invisible: `analyze_env_impact` under-reported the read
 * sites with nothing said about the gap.
 *
 * This module follows EXACTLY ONE HOP, and only where the binding is provable from
 * literal text — a wrong read site sends an agent to the wrong file and inflates the
 * blast radius, so a refusal is always preferred to a guess. Every condition below is
 * required:
 *
 *   1. the wrapper is a FREE function declared at the top level of the SAME FILE as
 *      the call site (never a method, never a cross-module same-named helper);
 *   2. its parameter flows DIRECTLY into the env read — the key expression is exactly
 *      the parameter identifier, with no concatenation, reassignment, rebinding, or
 *      shadowing anywhere in the body;
 *   3. exactly one parameter position feeds an env read;
 *   4. the call site passes a plain string literal of env-name shape at that position.
 *
 * Anything else — a variable argument, a template string, a concatenation, a parameter
 * with a default, a wrapper that wraps another wrapper (two hops), a shadowed parameter
 * — stays UNFOLLOWED and is counted in {@link EnvHelperScan.unfollowed} so the caller can
 * disclose the remaining gap with evidence instead of a generic caveat.
 *
 * No general dataflow, no new grammar, no new persisted artifact: one bounded text pass
 * over the same per-language read patterns the extractor already uses.
 */

// ============================================================================
// BOUNDS (hostile input: nothing here may go super-linear)
// ============================================================================

/** Indirect (non-literal-key) env reads considered per file. */
const MAX_INDIRECT_READS_PER_FILE = 50;
/** Function declarations enumerated per file when at least one indirect read exists. */
const MAX_DECLARATIONS_PER_FILE = 2000;
/** Characters of a candidate wrapper body scanned for the read / rebinding guards. */
const BODY_SCAN_LIMIT = 64 * 1024;
/** Characters scanned forward from a call's `(` looking for its matching `)`. */
const ARG_SCAN_LIMIT = 4096;
/** Characters of parameter list parsed. */
const PARAM_SCAN_LIMIT = 1024;
/**
 * Call sites followed per wrapper. A helper called from 10,000 sites would otherwise
 * dominate the payload; the cap is disclosed via {@link EnvHelperScan.callSiteCapHit}.
 */
export const MAX_CALL_SITES_PER_WRAPPER = 64;
/** Longest argument text compared against the env-name shape. */
const MAX_ARG_TEXT = 512;

// ============================================================================
// TYPES
// ============================================================================

/** A read site recovered at the CALL SITE, with the wrapper disclosed as the mechanism. */
export interface EnvHelperBinding {
  /** Variable name, read from the string literal at the call site. */
  name: string;
  /** Repo-relative file of the CALL SITE (where the variable is named). */
  file: string;
  /** 1-based line of the call site. */
  line: number;
  /** Per-site fallback verdict, taken from the wrapper's read form. */
  required: boolean;
  /** The helper the name flows through — the mechanism, always disclosed. */
  via: { helper: string; file: string; line: number };
}

/** An env read whose key is not a literal and which could NOT be followed. */
export interface UnfollowedEnvRead {
  file: string;
  line: number;
  /** The key expression as written, truncated — e.g. `envKey`, `prefix + name`. */
  keyExpression: string;
  /** Why it was not followed, in a few plain words. */
  reason: string;
}

export interface EnvHelperScan {
  bindings: EnvHelperBinding[];
  unfollowed: UnfollowedEnvRead[];
  /** True when a per-wrapper call-site cap stopped the follow short. */
  callSiteCapHit: boolean;
}

const EMPTY_SCAN: EnvHelperScan = { bindings: [], unfollowed: [], callSiteCapHit: false };

/** Env-name shape — the same shape the extractor's literal patterns accept. */
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

// ============================================================================
// PER-SITE `required` VERDICTS
// ============================================================================
// Moved here from env-extractor so the one-hop binder can classify a bound site by
// the WRAPPER's read form without duplicating the rules (env-extractor imports them).

/** JS/TS: a read has a site-local fallback when `??`/`||` immediately follows. */
export function tsSiteRequired(source: string, afterIdx: number): boolean {
  // Skip optional TS non-null `!`, whitespace, and transparent block comments,
  // then look for a site-local ?? or || fallback.
  let tail = source.slice(afterIdx, afterIdx + ARG_SCAN_LIMIT);
  for (;;) {
    const next = tail.replace(/^\s*(?:!|\/\*[\s\S]*?\*\/)/, '');
    if (next === tail) break;
    tail = next;
  }
  tail = tail.replace(/^\s*/, '');
  return !(tail.startsWith('??') || tail.startsWith('||'));
}

/**
 * A call-form read (`os.environ.get('X'…)`, `os.getenv('X'…)`, `ENV.fetch('X'…)`)
 * is required only when it has NO default. `afterIdx` is just past the matched
 * `…('X'` — a comma before the close means a positional default follows → soft.
 */
export function callHasNoDefaultArg(source: string, afterIdx: number): boolean {
  const tail = source.slice(afterIdx, afterIdx + ARG_SCAN_LIMIT).replace(/^\s*/, '');
  return !tail.startsWith(',');
}

/**
 * Ruby `ENV.fetch('X'…)`: required only with no default. A default can be a second
 * positional arg (`ENV.fetch('X', d)`) OR a block (`ENV.fetch('X') { d }` /
 * `ENV.fetch('X') do … end`) — both suppress the KeyError, so neither is a hard break.
 */
export function rubyFetchRequired(source: string, afterIdx: number): boolean {
  if (!callHasNoDefaultArg(source, afterIdx)) return false; // positional default
  // After the closing paren, a `{` or `do` is a block default.
  const afterParen = source.slice(afterIdx, afterIdx + ARG_SCAN_LIMIT).replace(/^\s*\)?\s*/, '');
  if (afterParen.startsWith('{') || /^do\b/.test(afterParen)) return false;
  return true;
}

// ============================================================================
// DIALECTS
// ============================================================================

type Dialect = 'ts' | 'py' | 'go' | 'rb';

const TS_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

function dialectOf(ext: string): Dialect | null {
  if (TS_EXTS.has(ext)) return 'ts';
  if (ext === '.py' || ext === '.pyw') return 'py';
  if (ext === '.go') return 'go';
  if (ext === '.rb') return 'rb';
  return null;
}

/** `true` at every index that sits inside a comment. Strings are left intact. */
function commentFlags(source: string, dialect: Dialect): Uint8Array {
  const flags = new Uint8Array(source.length);
  const cStyle = dialect === 'ts' || dialect === 'go';
  // Go's backtick strings are RAW: a backslash inside them escapes nothing.
  const rawBacktick = dialect === 'go';
  let quote = '';
  let escaped = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\' && !(quote === '`' && rawBacktick)) escaped = true;
      else if (ch === quote) quote = '';
      // An unterminated single-quoted string must not swallow the rest of the file.
      else if (ch === '\n' && quote !== '`') quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || (ch === '`' && dialect !== 'py')) { quote = ch; continue; }
    if (cStyle && ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') flags[i++] = 1;
    } else if (cStyle && ch === '/' && source[i + 1] === '*') {
      flags[i++] = 1;
      while (i < source.length) {
        flags[i] = 1;
        if (source[i] === '*' && source[i + 1] === '/') { flags[++i] = 1; break; }
        i++;
      }
    } else if (!cStyle && ch === '#') {
      while (i < source.length && source[i] !== '\n') flags[i++] = 1;
      i--;
    }
  }
  return flags;
}

/**
 * An INDEPENDENT guard that `idx` sits after a line-comment starter on its own line.
 * {@link commentFlags} tracks quotes across the whole file, so a pathological literal
 * (an unbalanced quote inside a Python triple-quoted block) could desynchronise it and
 * leave a commented-out call unmasked. This re-decides the question from the start of
 * the one line, where desynchronisation cannot reach — cheap insurance against the one
 * failure mode that would invent a read site out of dead text.
 */
function afterLineComment(source: string, idx: number, dialect: Dialect): boolean {
  const cStyle = dialect === 'ts' || dialect === 'go';
  let start = source.lastIndexOf('\n', idx - 1) + 1;
  if (idx - start > 4096) start = idx - 4096; // bounded: a minified line stays cheap
  let quote = '';
  let escaped = false;
  for (let i = start; i < idx; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (cStyle ? ch === '/' && source[i + 1] === '/' : ch === '#') return true;
  }
  return false;
}

/** Sorted newline starts → 1-based line for an index. */
function lineLookup(source: string): (idx: number) => number {
  const starts: number[] = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return (idx: number): number => {
    let lo = 0, hi = starts.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= idx) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans + 1;
  };
}

// ============================================================================
// STEP 1 — INDIRECT ENV READS (a read whose key is not a literal)
// ============================================================================

interface IndirectRead {
  /** Index of the whole read expression's start. */
  index: number;
  /** The key expression text, trimmed. */
  key: string;
  /** Number of top-level arguments / subscript parts the read was given. */
  argCount: number;
  /** Index just past the closing delimiter. */
  afterRead: number;
  /** Read form, for the `required` verdict. */
  form: 'go-getenv' | 'py-subscript' | 'py-call' | 'ts-subscript' | 'rb-subscript' | 'rb-fetch';
}

/** Openers per dialect: a regex whose match ENDS at the key's opening delimiter. */
const READ_OPENERS: Record<Dialect, Array<{ re: RegExp; close: ')' | ']'; form: IndirectRead['form'] }>> = {
  go: [{ re: /(?<![\w$.])os\.(?:Getenv|LookupEnv)\s*\(/g, close: ')', form: 'go-getenv' }],
  py: [
    { re: /(?<![\w$.])os\.environ\s*\[/g, close: ']', form: 'py-subscript' },
    { re: /(?<![\w$.])os\.(?:environ\s*\.\s*get|getenv)\s*\(/g, close: ')', form: 'py-call' },
  ],
  ts: [{ re: /(?<![\w$.])process\.env\s*\[/g, close: ']', form: 'ts-subscript' }],
  rb: [
    { re: /(?<![\w$:.])ENV\s*\[/g, close: ']', form: 'rb-subscript' },
    { re: /(?<![\w$:.])ENV\s*\.\s*fetch\s*\(/g, close: ')', form: 'rb-fetch' },
  ],
};

/**
 * Find the matching close delimiter for the open delimiter at `open`, honouring nested
 * delimiters and string literals. Bounded by `ARG_SCAN_LIMIT`; returns -1 when it is not
 * found within the bound (such a read stays unfollowed rather than costing more).
 */
function matchDelimiter(source: string, open: number, close: ')' | ']'): number {
  const openCh = source[open];
  let depth = 0;
  let quote = '';
  let escaped = false;
  const limit = Math.min(source.length, open + ARG_SCAN_LIMIT);
  for (let i = open; i < limit; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === openCh) depth++;
    else if (ch === close && --depth === 0) return i;
  }
  return -1;
}

/** Split a delimited argument body on top-level commas. */
function splitArgs(body: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = 0; i <= body.length; i++) {
    const ch = i === body.length ? ',' : body[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) { parts.push(body.slice(start, i)); start = i + 1; }
  }
  return parts;
}

/** Is this text one whole string literal and nothing else? */
function isSoleStringLiteral(text: string): boolean {
  const q = text[0];
  if (q !== '"' && q !== "'" && q !== '`') return false;
  let escaped = false;
  for (let i = 1; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === q) return i === text.length - 1;
  }
  return false;
}

/** Is this argument text a plain string literal of env-name shape? */
function literalEnvName(text: string, dialect: Dialect): string | null {
  if (text.length > MAX_ARG_TEXT) return null;
  const t = text.trim();
  if (t.length < 3) return null;
  const q = t[0];
  // A template literal can interpolate — never a provable literal in TS/JS.
  if (q === '`' && dialect !== 'go') return null;
  if (q !== '"' && q !== "'" && q !== '`') return null;
  if (t[t.length - 1] !== q) return null;
  const inner = t.slice(1, -1);
  // Reject anything with an escape or a second quote: only a flat literal is provable.
  if (inner.includes('\\') || inner.includes(q)) return null;
  return ENV_NAME_RE.test(inner) ? inner : null;
}

function collectIndirectReads(source: string, dialect: Dialect, comments: Uint8Array): IndirectRead[] {
  const reads: IndirectRead[] = [];
  for (const opener of READ_OPENERS[dialect]) {
    const re = new RegExp(opener.re.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      if (reads.length >= MAX_INDIRECT_READS_PER_FILE) break;
      if (comments[m.index] || afterLineComment(source, m.index, dialect)) continue;
      const open = m.index + m[0].length - 1;
      const close = matchDelimiter(source, open, opener.close);
      if (close === -1) continue;
      const args = splitArgs(source.slice(open + 1, close));
      const keyRaw = args[0] ?? '';
      const key = keyRaw.trim();
      if (!key) continue;
      // A literal key is already handled by the extractor's own patterns.
      if (literalEnvName(key, dialect) !== null) continue;
      // So is a literal of a shape the extractor rejects — not an indirect read. But a
      // key that merely STARTS with a literal (`"APP_" + name`) is computed, and must be
      // counted: dropping it would hide exactly the kind of read this boundary is about.
      if (isSoleStringLiteral(key)) continue;
      reads.push({ index: m.index, key, argCount: args.length, afterRead: close + 1, form: opener.form });
    }
  }
  reads.sort((a, b) => a.index - b.index);
  return reads;
}

// ============================================================================
// STEP 2 — THE ENCLOSING FREE FUNCTION
// ============================================================================

/**
 * Top-level free-function declarations. A METHOD is deliberately unmatched in every
 * dialect: a call site `obj.helper("X")` cannot be proven to reach this declaration
 * from text alone, so methods stay unfollowed.
 */
const DECLARATIONS: Record<Dialect, RegExp> = {
  // `func (r *T) Name(` has `(` straight after `func`, so a method never matches.
  // A generic `func Name[T any](` does not match either — it stays unfollowed.
  go: /(?<![\w.])func[ \t]+([A-Za-z_]\w*)[ \t]*\(/g,
  // Column 0 only: an indented `def` is a method or a closure.
  py: /^def[ \t]+([A-Za-z_]\w*)[ \t]*\(/gm,
  rb: /^def[ \t]+([A-Za-z_]\w*[!?]?)[ \t]*\(/gm,
  // Column 0 only (an optional `export`/`async`): `function name(` or `const name = (`.
  ts: /^(?:export[ \t]+)?(?:(?:async[ \t]+)?function[ \t]+([A-Za-z_$][\w$]*)[ \t]*\(|(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)[ \t]*(?::[^=\n]*)?=[ \t]*(?:async[ \t]*)?\()/gm,
};

interface Declaration {
  name: string;
  /** Index of the declaration's start. */
  index: number;
  /** Index of the parameter list's `(`. */
  paramOpen: number;
}

function collectDeclarations(source: string, dialect: Dialect, comments: Uint8Array): Declaration[] {
  const out: Declaration[] = [];
  const re = new RegExp(DECLARATIONS[dialect].source, DECLARATIONS[dialect].flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    if (out.length >= MAX_DECLARATIONS_PER_FILE) break;
    if (comments[m.index] || afterLineComment(source, m.index, dialect)) continue;
    const name = m[1] ?? m[2];
    if (!name) continue;
    out.push({ name, index: m.index, paramOpen: m.index + m[0].length - 1 });
  }
  return out;
}

/** The body text of a declaration, bounded. `null` when the extent is not determinable. */
function bodyOf(source: string, decl: Declaration, dialect: Dialect): { start: number; end: number } | null {
  const paramClose = matchDelimiter(source, decl.paramOpen, ')');
  if (paramClose === -1) return null;

  if (dialect === 'go' || dialect === 'ts') {
    // Arrow bodies and Go/TS blocks alike: the first `{` after the parameter list.
    // A concise arrow body (`=> process.env[k]`) has none → not followed.
    const limit = Math.min(source.length, paramClose + 512);
    let open = -1;
    for (let i = paramClose + 1; i < limit; i++) {
      const ch = source[i];
      if (ch === '{') { open = i; break; }
      if (ch === ';') break;
    }
    if (open === -1) return null;
    const close = matchBrace(source, open);
    if (close === -1) return null;
    return { start: open + 1, end: Math.min(close, open + 1 + BODY_SCAN_LIMIT) };
  }

  // Python: from the end of the def line to the first line with content at column 0.
  // Ruby: to the first line that is exactly `end` at column 0.
  const firstNl = source.indexOf('\n', paramClose);
  if (firstNl === -1) return null;
  let i = firstNl + 1;
  const hardEnd = Math.min(source.length, i + BODY_SCAN_LIMIT);
  while (i < hardEnd) {
    const nl = source.indexOf('\n', i);
    const lineEnd = nl === -1 ? source.length : nl;
    const line = source.slice(i, lineEnd);
    if (dialect === 'rb') {
      if (/^end[ \t]*(?:#.*)?$/.test(line)) return { start: firstNl + 1, end: i };
    } else if (line.length > 0 && !/^[ \t#]/.test(line)) {
      return { start: firstNl + 1, end: i };
    }
    if (nl === -1) break;
    i = nl + 1;
  }
  return { start: firstNl + 1, end: hardEnd };
}

function matchBrace(source: string, open: number): number {
  let depth = 0;
  let quote = '';
  let escaped = false;
  const limit = Math.min(source.length, open + BODY_SCAN_LIMIT);
  for (let i = open; i < limit; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return -1;
}

/**
 * Parameter names by position. `null` when the list is anything but a flat list of
 * plain named parameters — a default, a destructuring pattern, a variadic, or a
 * function-typed parameter all make the position unprovable, so the read is not followed.
 */
function paramNames(source: string, decl: Declaration, dialect: Dialect): string[] | null {
  const close = matchDelimiter(source, decl.paramOpen, ')');
  if (close === -1) return null;
  const raw = source.slice(decl.paramOpen + 1, close);
  if (raw.length > PARAM_SCAN_LIMIT) return null;
  if (raw.trim() === '') return [];
  // A default value makes the position optional → callers may omit it.
  if (/=/.test(raw)) return null;
  // A nested call/type/destructure/variadic: never followed.
  if (/[({[]/.test(raw)) return null;
  if (raw.includes('...')) return null;
  if (dialect !== 'go' && raw.includes('*')) return null; // py/rb varargs, not Go pointers
  if (dialect === 'ts' && raw.includes('?')) return null;  // optional parameter

  const names: string[] = [];
  for (const token of raw.split(',')) {
    const id = /[A-Za-z_$][\w$]*/.exec(token.trim());
    if (!id) return null;
    names.push(id[0]);
  }
  return names;
}

/**
 * Rebinding guards: ANY sign that the parameter is not the exact value the caller passed
 * by the time it reaches the read. Deliberately over-broad — a false refusal costs a
 * disclosed boundary line, a false binding sends an agent to the wrong file.
 */
function isRebound(body: string, n: string, dialect: Dialect): boolean {
  const id = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const common = [
    new RegExp(`\\b${id}\\s*(?:=(?!=)|\\+=|\\*=|\\|\\|=|\\?\\?=)`),
    new RegExp(`\\b${id}\\s*:=`),
  ];
  const perDialect: RegExp[] = dialect === 'go'
    ? [new RegExp(`func\\s*\\([^)]*\\b${id}\\b`), new RegExp(`&\\s*${id}\\b`)]
    : dialect === 'py'
      ? [
        new RegExp(`\\bdef\\s+\\w+\\s*\\([^)]*\\b${id}\\b`),
        new RegExp(`\\blambda\\b[^:\\n]*\\b${id}\\b`),
        new RegExp(`\\bfor\\s+[^\\n]*\\b${id}\\b[^\\n]*\\bin\\b`),
        new RegExp(`\\bas\\s+${id}\\b`),
        new RegExp(`\\b(?:global|nonlocal)\\s+[^\\n]*\\b${id}\\b`),
        new RegExp(`\\b${id}\\s*:[^=\\n]*=`),
      ]
      : dialect === 'rb'
        ? [
          new RegExp(`\\bdef\\s+\\w+\\s*\\([^)]*\\b${id}\\b`),
          new RegExp(`\\|[^|\\n]*\\b${id}\\b[^|\\n]*\\|`),
          new RegExp(`\\bfor\\s+${id}\\b`),
        ]
        : [
          new RegExp(`\\b(?:const|let|var)\\s+[^=\\n;]*\\b${id}\\b`),
          new RegExp(`\\bfunction\\s*\\w*\\s*\\([^)]*\\b${id}\\b`),
          new RegExp(`\\([^)\\n]*\\b${id}\\b[^)\\n]*\\)\\s*=>`),
          new RegExp(`\\b${id}\\s*=>`),
          new RegExp(`\\bcatch\\s*\\(\\s*${id}\\b`),
          new RegExp(`\\b${id}\\s*(?:\\+\\+|--)`),
          new RegExp(`(?:\\+\\+|--)\\s*${id}\\b`),
        ];
  return [...common, ...perDialect].some(re => re.test(body));
}

// ============================================================================
// STEP 3 — CALL SITES IN THE SAME FILE
// ============================================================================

function callSitesOf(
  source: string,
  helper: Declaration,
  paramIndex: number,
  dialect: Dialect,
  comments: Uint8Array,
  declarationIndexes: ReadonlySet<number>,
): { literals: Array<{ name: string; index: number }>; capHit: boolean } {
  const id = helper.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The lookbehind refuses a RECEIVER: `obj.helper(`, `self.helper(`, `Mod::helper(`,
  // `@helper(` are never bound to this free function.
  const re = new RegExp(`(?<![\\w$.@:])${id}\\s*\\(`, 'g');
  const literals: Array<{ name: string; index: number }> = [];
  let capHit = false;
  let seen = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    if (comments[m.index] || afterLineComment(source, m.index, dialect)) continue;
    // Skip the declarations themselves (`func helper(`, `def helper(`, `function helper(`).
    if (declarationIndexes.has(m.index)) continue;
    const before = source.slice(Math.max(0, m.index - 24), m.index);
    if (/\b(?:func|def|function|class)[ \t]+$/.test(before)) continue;
    if (++seen > MAX_CALL_SITES_PER_WRAPPER) { capHit = true; break; }
    const open = m.index + m[0].length - 1;
    const close = matchDelimiter(source, open, ')');
    if (close === -1) continue;
    const args = splitArgs(source.slice(open + 1, close));
    if (args.length <= paramIndex) continue;
    const name = literalEnvName(args[paramIndex], dialect);
    if (name) literals.push({ name, index: m.index });
  }
  return { literals, capHit };
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Follow an env-var name ONE HOP from a literal at a call site into the helper that
 * reads it, for one file. Returns the bound read sites (attributed to the call site,
 * with the helper disclosed) plus every indirect read it refused to follow and why.
 *
 * Deterministic, bounded, text-only. Never throws on hostile input.
 */
export function scanEnvHelperBindings(source: string, relPath: string, ext: string): EnvHelperScan {
  const dialect = dialectOf(ext.toLowerCase());
  if (!dialect) return EMPTY_SCAN;

  const comments = commentFlags(source, dialect);
  const indirect = collectIndirectReads(source, dialect, comments);
  // The overwhelmingly common case: every read names its variable with a literal.
  // Costs one linear pass and enumerates no declarations at all.
  if (indirect.length === 0) return EMPTY_SCAN;

  const lineOf = lineLookup(source);
  const declarations = collectDeclarations(source, dialect, comments);
  const declarationIndexes = new Set(declarations.map(d => d.index));

  const bindings: EnvHelperBinding[] = [];
  const unfollowed: UnfollowedEnvRead[] = [];
  let callSiteCapHit = false;

  // A helper may hold more than one indirect read; bind each independently but refuse
  // when more than one PARAMETER position feeds reads in the same helper.
  const readsByDecl = new Map<number, IndirectRead[]>();
  const declForRead = new Map<IndirectRead, Declaration>();
  const orphans: IndirectRead[] = [];
  for (const read of indirect) {
    // The innermost declaration starting before the read whose body contains it.
    let owner: Declaration | null = null;
    for (let i = declarations.length - 1; i >= 0; i--) {
      const d = declarations[i];
      if (d.index > read.index) continue;
      const body = bodyOf(source, d, dialect);
      if (body && read.index >= body.start && read.index < body.end) owner = d;
      break;
    }
    if (!owner) { orphans.push(read); continue; }
    declForRead.set(read, owner);
    const arr = readsByDecl.get(owner.index);
    if (arr) arr.push(read); else readsByDecl.set(owner.index, [read]);
  }

  const push = (read: IndirectRead, reason: string): void => {
    unfollowed.push({
      file: relPath,
      line: lineOf(read.index),
      keyExpression: read.key.length > 80 ? `${read.key.slice(0, 77)}...` : read.key,
      reason,
    });
  };

  for (const read of orphans) {
    push(read, 'the read is not inside a top-level free function (module level, a method, or a closure)');
  }

  for (const reads of readsByDecl.values()) {
    const decl = declForRead.get(reads[0])!;
    const body = bodyOf(source, decl, dialect)!;
    const bodyText = source.slice(body.start, body.end);
    const params = paramNames(source, decl, dialect);
    if (params === null) {
      for (const r of reads) push(r, `the helper \`${decl.name}\` has a parameter list that cannot be matched to a call-site position (a default, a pattern, a variadic, or a typed callback)`);
      continue;
    }

    // Which reads take a bare parameter identifier as their whole key?
    const direct = reads.filter(r => params.includes(r.key) && /^[A-Za-z_$][\w$]*$/.test(r.key));
    for (const r of reads) {
      if (direct.includes(r)) continue;
      push(r, /^[A-Za-z_$][\w$]*$/.test(r.key)
        ? `the key \`${r.key}\` is a local value, not a parameter of \`${decl.name}\``
        : `the key is a computed expression, not a bare parameter of \`${decl.name}\``);
    }
    if (direct.length === 0) continue;

    const positions = new Set(direct.map(r => params.indexOf(r.key)));
    if (positions.size !== 1) {
      for (const r of direct) push(r, `more than one parameter of \`${decl.name}\` feeds an environment read`);
      continue;
    }
    const paramIndex = [...positions][0];
    const paramName = params[paramIndex];

    if (isRebound(bodyText, paramName, dialect)) {
      for (const r of direct) push(r, `the parameter \`${paramName}\` is reassigned, shadowed, or rebound inside \`${decl.name}\``);
      continue;
    }

    const { literals, capHit } = callSitesOf(source, decl, paramIndex, dialect, comments, declarationIndexes);
    if (capHit) callSiteCapHit = true;
    if (literals.length === 0) {
      for (const r of direct) push(r, `no call site of \`${decl.name}\` in this file passes a plain string literal at position ${paramIndex + 1}`);
      continue;
    }

    // One bound read site per (call site × read form) — the call site is where the
    // variable is NAMED, which is what an agent asking "who reads this?" wants to see.
    for (const r of direct) {
      const required = requiredFor(source, r);
      for (const lit of literals) {
        bindings.push({
          name: lit.name,
          file: relPath,
          line: lineOf(lit.index),
          required,
          via: { helper: decl.name, file: relPath, line: lineOf(r.index) },
        });
      }
    }
  }

  bindings.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name) || a.via.line - b.via.line);
  unfollowed.sort((a, b) => a.line - b.line || a.keyExpression.localeCompare(b.keyExpression));
  return { bindings, unfollowed, callSiteCapHit };
}

/** The per-site `required` verdict for a bound read, taken from the WRAPPER's read form. */
function requiredFor(source: string, read: IndirectRead): boolean {
  switch (read.form) {
    // os.Getenv / os.LookupEnv return "" rather than failing — never a hard break.
    case 'go-getenv': return false;
    // os.environ[k] raises KeyError.
    case 'py-subscript': return true;
    // A positional default makes the break soft.
    case 'py-call': return read.argCount <= 1;
    case 'ts-subscript': return tsSiteRequired(source, read.afterRead);
    // ENV[k] returns nil.
    case 'rb-subscript': return false;
    // ENV.fetch(k) is strict only with neither a positional nor a block default.
    case 'rb-fetch': return read.argCount <= 1 && !hasRubyBlockDefault(source, read.afterRead);
  }
}

/** After `ENV.fetch(k)`, a `{ … }` or `do … end` block supplies a default. */
function hasRubyBlockDefault(source: string, afterRead: number): boolean {
  const tail = source.slice(afterRead, afterRead + 64).replace(/^\s*/, '');
  return tail.startsWith('{') || /^do\b/.test(tail);
}
