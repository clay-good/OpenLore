/**
 * Environment Variable Extractor
 *
 * Detects env vars used in a project from two complementary sources:
 *   1. Declaration files — .env.example, .env.local, .env (with optional comments)
 *   2. Source code — process.env.X (JS/TS), os.environ["X"] (Python),
 *      os.Getenv("X") (Go), ENV["X"] (Ruby)
 *
 * Variables found in declaration files are marked hasDefault=true when the
 * declaration line has a non-empty value. Variables found only in source code
 * are marked required=true (no known default).
 */

import { readFile } from 'node:fs/promises';
import { extname, relative, basename } from 'node:path';

// ============================================================================
// TYPES
// ============================================================================

export interface EnvVar {
  /** Environment variable name, e.g. DATABASE_URL */
  name: string;
  /** Relative path(s) where the variable was found */
  files: string[];
  /** True when declared in .env.example with a non-empty value */
  hasDefault: boolean;
  /** True when used in source code without a fallback (process.env.X without ?? or ||) */
  required: boolean;
  /** Inline comment from .env.example, if present */
  description?: string;
}

// ============================================================================
// ENV FILE PARSER
// ============================================================================

function parseEnvFile(content: string, relPath: string): EnvVar[] {
  const vars: EnvVar[] = [];
  let pendingComment = '';

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();

    // Accumulate comment lines as description
    if (line.startsWith('#')) {
      pendingComment = line.replace(/^#+\s*/, '');
      continue;
    }

    if (!line) {
      pendingComment = '';
      continue;
    }

    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) { pendingComment = ''; continue; }

    const name = line.slice(0, eqIdx).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) { pendingComment = ''; continue; }

    const rawValue = line.slice(eqIdx + 1).trim();
    // Strip inline comment from value
    const valueWithoutComment = rawValue.replace(/#.*$/, '').trim();
    const inlineComment = rawValue.includes('#')
      ? rawValue.slice(rawValue.indexOf('#') + 1).trim()
      : '';

    const hasDefault = valueWithoutComment.length > 0;
    const description = inlineComment || pendingComment || undefined;

    vars.push({ name, files: [relPath], hasDefault, required: false, description });
    pendingComment = '';
  }

  return vars;
}

// ============================================================================
// SOURCE CODE SCANNERS
// ============================================================================

// JS/TS: process.env.VAR_NAME or process.env['VAR_NAME'] or process.env["VAR_NAME"]
const TS_ENV_RE = /process\.env\.([A-Z_][A-Z0-9_]*)|process\.env\[['"]([A-Z_][A-Z0-9_]*)['"]]/g;
// Fallback detection: process.env.X ?? 'default' or process.env.X || 'default'
const TS_HAS_FALLBACK_RE = /process\.env\.(?:[A-Z_][A-Z0-9_]*|\[['"][A-Z_][A-Z0-9_]*['"]])\s*(?:\?\?|(?<!\|)\|\|)/;

// Python: os.environ["X"], os.environ['X'], os.environ.get("X"), os.getenv("X")
const PY_ENV_RE = /os\.environ\[['"]([A-Z_][A-Z0-9_]*)['"]|os\.environ\.get\(['"]([A-Z_][A-Z0-9_]*)['"]|os\.getenv\(['"]([A-Z_][A-Z0-9_]*)['"]/g;

// Go: os.Getenv("X")
const GO_ENV_RE = /os\.Getenv\("([A-Z_][A-Z0-9_]*)"\)/g;

// Ruby: ENV["X"], ENV['X'], ENV.fetch("X")
const RUBY_ENV_RE = /ENV\[['"]([A-Z_][A-Z0-9_]*)['"]|ENV\.fetch\(['"]([A-Z_][A-Z0-9_]*)['"]/g;

function extractFromSource(source: string, relPath: string, ext: string): Array<{ name: string; required: boolean }> {
  const found: Array<{ name: string; required: boolean }> = [];

  let re: RegExp;
  let hasFallback = false;

  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    re = new RegExp(TS_ENV_RE.source, 'g');
    hasFallback = TS_HAS_FALLBACK_RE.test(source);
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const name = m[1] ?? m[2];
      if (name) found.push({ name, required: !hasFallback });
    }
  } else if (['.py', '.pyw'].includes(ext)) {
    re = new RegExp(PY_ENV_RE.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const name = m[1] ?? m[2] ?? m[3];
      // os.environ.get and os.getenv have optional defaults → not strictly required
      const isStrict = m[1] !== undefined; // only os.environ["X"] is strict
      if (name) found.push({ name, required: isStrict });
    }
  } else if (ext === '.go') {
    re = new RegExp(GO_ENV_RE.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      if (m[1]) found.push({ name: m[1], required: false }); // Go always uses string return, caller checks
    }
  } else if (ext === '.rb') {
    re = new RegExp(RUBY_ENV_RE.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const name = m[1] ?? m[2];
      const isStrict = m[1] !== undefined; // ENV.fetch has optional default
      if (name) found.push({ name, required: isStrict });
    }
  }

  return found;
}

// ============================================================================
// PUBLIC API
// ============================================================================

const ENV_DECLARATION_FILES = new Set(['.env', '.env.example', '.env.local', '.env.test', '.env.production']);
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.pyw', '.go', '.rb']);
const SKIP_DIRS = ['/node_modules/', '/.openlore/', '/dist/', '/build/', '/coverage/'];

/**
 * Extract all environment variables referenced or declared in the project.
 */
export async function extractEnvVars(
  filePaths: string[],
  rootDir: string
): Promise<EnvVar[]> {
  const map = new Map<string, EnvVar>();

  function upsert(name: string, relPath: string, patch: Partial<EnvVar>): void {
    const existing = map.get(name);
    if (existing) {
      if (!existing.files.includes(relPath)) existing.files.push(relPath);
      if (patch.hasDefault) existing.hasDefault = true;
      if (patch.required) existing.required = true;
      if (patch.description && !existing.description) existing.description = patch.description;
    } else {
      map.set(name, {
        name,
        files: [relPath],
        hasDefault: patch.hasDefault ?? false,
        required: patch.required ?? false,
        description: patch.description,
      });
    }
  }

  await Promise.all(
    filePaths.map(async fp => {
      if (SKIP_DIRS.some(d => fp.replace(/\\/g, '/').includes(d))) return;

      const name = basename(fp);
      const ext = extname(fp).toLowerCase();
      const rel = relative(rootDir, fp);

      let source: string;
      try {
        source = await readFile(fp, 'utf-8');
      } catch {
        return;
      }

      // Env declaration files
      if (ENV_DECLARATION_FILES.has(name)) {
        for (const v of parseEnvFile(source, rel)) {
          upsert(v.name, rel, { hasDefault: v.hasDefault, description: v.description });
        }
        return;
      }

      // Source files
      if (!SOURCE_EXTENSIONS.has(ext)) return;
      // Skip test files
      if (fp.includes('.test.') || fp.includes('.spec.') || fp.includes('_test.') || fp.includes('_spec.')) return;

      for (const { name: varName, required } of extractFromSource(source, rel, ext)) {
        upsert(varName, rel, { required });
      }
    })
  );

  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Return a compact summary string for LLM prompts.
 */
export function summarizeEnvVars(vars: EnvVar[]): string {
  if (vars.length === 0) return '';
  const lines = vars.map(v => {
    const flags: string[] = [];
    if (v.required) flags.push('required');
    if (v.hasDefault) flags.push('has-default');
    const suffix = flags.length > 0 ? ` [${flags.join(', ')}]` : '';
    const desc = v.description ? ` — ${v.description}` : '';
    return `  ${v.name}${suffix}${desc}`;
  });
  return `Environment variables (${vars.length}):\n${lines.join('\n')}`;
}

// ============================================================================
// LINE-PRECISE READ SITES (change: add-env-config-impact-graph)
// ============================================================================

/**
 * One environment-variable READ in source, located to a line, with a per-site
 * fallback verdict. The read-site refinement of {@link extractFromSource}: same
 * per-language patterns, but it keeps WHERE each read is and whether THAT site
 * has an immediate fallback — the input `analyze_env_impact` needs to map a read
 * to its enclosing function and classify the break as hard vs. soft.
 */
export interface EnvReadSite {
  /** Environment variable name, e.g. DATABASE_URL */
  name: string;
  /** Repo-relative path of the file the read is in */
  file: string;
  /** 1-based line of the read */
  line: number;
  /**
   * True when no immediate fallback was detected AT THIS site (a hard break if
   * the var is removed). A fallback elsewhere does not clear it — per-site only.
   * A documented heuristic, not a guarantee.
   */
  required: boolean;
}

/** Build a sorted array of newline byte/char offsets for O(log n) line lookup. */
function lineLookup(source: string): (idx: number) => number {
  const starts: number[] = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10 /* \n */) starts.push(i + 1);
  }
  return (idx: number): number => {
    // Largest start <= idx → its 1-based line.
    let lo = 0, hi = starts.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= idx) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans + 1;
  };
}

/** JS/TS: a read has a site-local fallback when `?? `/`||` immediately follows. */
function tsSiteRequired(source: string, afterIdx: number): boolean {
  // Skip optional TS non-null `!` and whitespace, then look for ?? or ||.
  const tail = source.slice(afterIdx).replace(/^\s*!?\s*/, '');
  return !(tail.startsWith('??') || tail.startsWith('||'));
}

/**
 * A call-form read (`os.environ.get('X'…)`, `os.getenv('X'…)`, `ENV.fetch('X'…)`)
 * is required only when it has NO default. `afterIdx` is just past the matched
 * `…('X'` — a comma before the close means a positional default follows → soft.
 */
function callHasNoDefaultArg(source: string, afterIdx: number): boolean {
  const tail = source.slice(afterIdx).replace(/^\s*/, '');
  return !tail.startsWith(',');
}

/**
 * Ruby `ENV.fetch('X'…)`: required only with no default. A default can be a second
 * positional arg (`ENV.fetch('X', d)`) OR a block (`ENV.fetch('X') { d }` /
 * `ENV.fetch('X') do … end`) — both suppress the KeyError, so neither is a hard break.
 */
function rubyFetchRequired(source: string, afterIdx: number): boolean {
  if (!callHasNoDefaultArg(source, afterIdx)) return false; // positional default
  // After the closing paren, a `{` or `do` is a block default.
  const afterParen = source.slice(afterIdx).replace(/^\s*\)\s*/, '');
  if (afterParen.startsWith('{') || /^do\b/.test(afterParen)) return false;
  return true;
}

/**
 * Extract every environment-variable READ site in one file, line-precise, reusing
 * the existing per-language patterns (no new grammar). Returns [] for a file in a
 * language the patterns do not cover — an honest absence, never a guessed read.
 * Deterministic: stable order (line, then name).
 */
export function extractEnvReadSites(source: string, relPath: string, ext: string): EnvReadSite[] {
  const sites: EnvReadSite[] = [];
  const lineOf = lineLookup(source);
  let m: RegExpExecArray | null;

  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    const re = new RegExp(TS_ENV_RE.source, 'g');
    while ((m = re.exec(source)) !== null) {
      const name = m[1] ?? m[2];
      if (!name) continue;
      const afterIdx = m.index + m[0].length;
      sites.push({ name, file: relPath, line: lineOf(m.index), required: tsSiteRequired(source, afterIdx) });
    }
  } else if (['.py', '.pyw'].includes(ext)) {
    const re = new RegExp(PY_ENV_RE.source, 'g');
    while ((m = re.exec(source)) !== null) {
      const name = m[1] ?? m[2] ?? m[3];
      if (!name) continue;
      // os.environ["X"] (m[1]) is a strict subscript (raises KeyError) → required.
      // os.environ.get("X") / os.getenv("X") (m[2]/m[3]) are required only without a
      // default arg: `get("X")` returns None (a deferred hard break), `get("X", d)`
      // returns the default (soft). Symmetric with the TS/Ruby per-site checks.
      const afterIdx = m.index + m[0].length;
      const required = m[1] !== undefined ? true : callHasNoDefaultArg(source, afterIdx);
      sites.push({ name, file: relPath, line: lineOf(m.index), required });
    }
  } else if (ext === '.go') {
    const re = new RegExp(GO_ENV_RE.source, 'g');
    while ((m = re.exec(source)) !== null) {
      if (!m[1]) continue;
      // os.Getenv returns "" rather than failing — never a hard break.
      sites.push({ name: m[1], file: relPath, line: lineOf(m.index), required: false });
    }
  } else if (ext === '.rb') {
    const re = new RegExp(RUBY_ENV_RE.source, 'g');
    while ((m = re.exec(source)) !== null) {
      const name = m[1] ?? m[2];
      if (!name) continue;
      const afterIdx = m.index + m[0].length;
      // ENV["X"] (m[1]) is strict; ENV.fetch("X") (m[2]) is strict only without a default arg.
      const required = m[1] !== undefined ? true : rubyFetchRequired(source, afterIdx);
      sites.push({ name, file: relPath, line: lineOf(m.index), required });
    }
  }

  sites.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
  return sites;
}
