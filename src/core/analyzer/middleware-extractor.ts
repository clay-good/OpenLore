/**
 * Middleware Extractor
 *
 * Detects middleware usage in server-side source files across multiple
 * frameworks: Express, Hono, Fastify, NestJS, Next.js.
 *
 * Detection is purely regex-based — no AST parsing required.
 */

import { readFile } from 'node:fs/promises';
import { extname, relative, basename } from 'node:path';
import { isTestFile } from './test-file.js';

// ============================================================================
// TYPES
// ============================================================================

export type MiddlewareType =
  | 'auth'
  | 'rate-limit'
  | 'cors'
  | 'validation'
  | 'logging'
  | 'error-handler'
  | 'custom';

export interface MiddlewareEntry {
  /** Broad middleware category */
  type: MiddlewareType;
  /** Framework that owns this middleware */
  framework: string; // 'express' | 'nestjs' | 'nextjs' | 'fastify' | 'unknown'
  /** Relative path from rootDir */
  file: string;
  /** 1-based source line */
  line: number;
  /** Function/middleware name if detectable */
  name: string;
}

// ============================================================================
// DETECTION PATTERNS
// ============================================================================

interface Pattern {
  re: RegExp;
  type: MiddlewareType;
  name: string;
  framework: string;
}

// Express / Hono app.use(...) patterns
const EXPRESS_PATTERNS: Pattern[] = [
  // CORS
  { re: /app\.use\s*\([^)]{0,400}cors\s*\(/,          type: 'cors',         name: 'cors',        framework: 'express' },
  { re: /app\.use\s*\([^)]{0,400}cors\)/,              type: 'cors',         name: 'cors',        framework: 'express' },
  // Auth
  { re: /app\.use\s*\([^)]{0,400}helmet\s*\(/,         type: 'auth',         name: 'helmet',      framework: 'express' },
  { re: /passport\.authenticate\s*\(/,           type: 'auth',         name: 'passport',    framework: 'express' },
  { re: /\bjwt\s*\(/,                            type: 'auth',         name: 'jwt',         framework: 'express' },
  { re: /app\.use\s*\([^)]{0,400}session\s*\(/,        type: 'auth',         name: 'session',     framework: 'express' },
  // Rate-limit
  { re: /app\.use\s*\([^)]{0,400}rateLimit\s*\(/,      type: 'rate-limit',   name: 'rateLimit',   framework: 'express' },
  { re: /app\.use\s*\([^)]{0,400}slowDown\s*\(/,       type: 'rate-limit',   name: 'slowDown',    framework: 'express' },
  { re: /app\.use\s*\([^)]{0,400}throttle\s*\(/,       type: 'rate-limit',   name: 'throttle',    framework: 'express' },
  // Logging
  { re: /app\.use\s*\([^)]{0,400}morgan\s*\(/,         type: 'logging',      name: 'morgan',      framework: 'express' },
  { re: /app\.use\s*\([^)]{0,400}pino\s*\(/,           type: 'logging',      name: 'pino',        framework: 'express' },
  { re: /app\.use\s*\([^)]{0,400}winston\s*\(/,        type: 'logging',      name: 'winston',     framework: 'express' },
  // Validation
  { re: /app\.use\s*\([^)]{0,400}express\.json/,       type: 'validation',   name: 'express.json', framework: 'express' },
  { re: /app\.use\s*\([^)]{0,400}bodyParser/,          type: 'validation',   name: 'bodyParser',  framework: 'express' },
  // NOTE: zod is detected separately (see extractFromSource), gated on a real zod import —
  // a bare `.parse(` matches JSON.parse/Date.parse/etc. and produced phantom "zod" entries.
  { re: /\bcelebrate\s*\(/,                      type: 'validation',   name: 'celebrate',   framework: 'express' },
];

// NestJS decorator-based patterns
const NESTJS_PATTERNS: Pattern[] = [
  { re: /@UseGuards\s*\(/,         type: 'auth',   name: 'UseGuards',       framework: 'nestjs' },
  { re: /APP_GUARD\b/,             type: 'auth',   name: 'APP_GUARD',       framework: 'nestjs' },
  { re: /@UseInterceptors\s*\(/,   type: 'custom', name: 'UseInterceptors', framework: 'nestjs' },
  { re: /APP_INTERCEPTOR\b/,       type: 'custom', name: 'APP_INTERCEPTOR', framework: 'nestjs' },
];

// Fastify hook patterns
const FASTIFY_PATTERNS: Pattern[] = [
  { re: /\.addHook\s*\(\s*['"]onRequest['"]/,   type: 'auth',   name: 'onRequest',   framework: 'fastify' },
  { re: /\.addHook\s*\(\s*['"]preHandler['"]/,  type: 'custom', name: 'preHandler',  framework: 'fastify' },
  { re: /\.register\s*\([^,)]*cors/,            type: 'cors',   name: 'cors',        framework: 'fastify' },
];

// Express 4-argument error handler
const ERROR_HANDLER_RE = /function\s+\w*\s*\(\s*err\s*,\s*req\s*,\s*res\s*,\s*next\s*\)/;
const ERROR_HANDLER_ARROW_RE = /\(\s*err\s*,\s*req\s*,\s*res\s*,\s*next\s*\)\s*=>/;

// ============================================================================
// FRAMEWORK DETECTION
// ============================================================================

function detectFramework(source: string, filePath: string): string {
  const fp = filePath.replace(/\\/g, '/');
  if (/@UseGuards\(|@UseInterceptors\(|APP_GUARD|APP_INTERCEPTOR/.test(source)) return 'nestjs';
  if (/\/middleware\.[jt]sx?$/.test(fp) && (/^src\/middleware/.test(fp) || /^middleware/.test(fp.replace(/^.*\//, '')))) return 'nextjs';
  if (/from\s+['"]fastify['"]|require\s*\(\s*['"]fastify['"]\s*\)/.test(source) || /fastify\s*\(/.test(source)) return 'fastify';
  if (/from\s+['"]hono['"]/.test(source) || /new\s+Hono\s*[(<]/.test(source)) return 'express';
  if (/from\s+['"]express['"]|require\s*\(\s*['"]express['"]\s*\)/.test(source)) return 'express';
  return 'unknown';
}

// ============================================================================
// HELPERS
// ============================================================================

function lineNumberOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

// ============================================================================
// PER-FILE EXTRACTION
// ============================================================================

function extractFromSource(
  source: string,
  rel: string,
  filePath: string
): MiddlewareEntry[] {
  const entries: MiddlewareEntry[] = [];
  const framework = detectFramework(source, filePath);

  // ── Next.js middleware file ────────────────────────────────────────────────
  const fname = basename(filePath).toLowerCase();
  if (fname === 'middleware.ts' || fname === 'middleware.js') {
    entries.push({
      type: 'custom',
      framework: 'nextjs',
      file: rel,
      line: 1,
      name: 'middleware',
    });
    return entries;
  }

  // ── NestJS ─────────────────────────────────────────────────────────────────
  if (framework === 'nestjs') {
    for (const pat of NESTJS_PATTERNS) {
      const re = new RegExp(pat.re.source, 'gm');
      let m: RegExpExecArray | null;
      while ((m = re.exec(source)) !== null) {
        entries.push({
          type: pat.type,
          framework: 'nestjs',
          file: rel,
          line: lineNumberOf(source, m.index),
          name: pat.name,
        });
      }
    }
    return entries;
  }

  // ── Fastify ────────────────────────────────────────────────────────────────
  if (framework === 'fastify') {
    for (const pat of FASTIFY_PATTERNS) {
      const re = new RegExp(pat.re.source, 'gm');
      let m: RegExpExecArray | null;
      while ((m = re.exec(source)) !== null) {
        entries.push({
          type: pat.type,
          framework: 'fastify',
          file: rel,
          line: lineNumberOf(source, m.index),
          name: pat.name,
        });
      }
    }
  }

  // ── Express / Hono / unknown ───────────────────────────────────────────────
  for (const pat of EXPRESS_PATTERNS) {
    const re = new RegExp(pat.re.source, 'gm');
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      entries.push({
        type: pat.type,
        framework: framework === 'unknown' ? 'express' : framework,
        file: rel,
        line: lineNumberOf(source, m.index),
        name: pat.name,
      });
    }
  }

  // ── zod validation (framework-agnostic, gated on a real zod import) ────────
  // `.parse(`/`.safeParse(` only indicate zod when the file actually imports zod;
  // otherwise they match JSON.parse, Date.parse, Number.parse, test assertions, etc.
  if (/from\s+['"]zod['"]|require\s*\(\s*['"]zod['"]\s*\)/.test(source)) {
    const zodRe = /\.(?:safeParse|parse)\s*\(/gm;
    let m: RegExpExecArray | null;
    while ((m = zodRe.exec(source)) !== null) {
      entries.push({
        type: 'validation',
        framework: framework === 'unknown' ? 'express' : framework,
        file: rel,
        line: lineNumberOf(source, m.index),
        name: 'zod',
      });
    }
  }

  // ── Error handler (4-argument Express signature) ──────────────────────────
  for (const errorRe of [ERROR_HANDLER_RE, ERROR_HANDLER_ARROW_RE]) {
    const re = new RegExp(errorRe.source, 'gm');
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      // Avoid duplicates
      const line = lineNumberOf(source, m.index);
      if (!entries.some(e => e.type === 'error-handler' && e.line === line)) {
        entries.push({
          type: 'error-handler',
          framework: framework === 'unknown' ? 'express' : framework,
          file: rel,
          line,
          name: 'errorHandler',
        });
      }
    }
  }

  // Deduplicate entries with same type+name+line
  const seen = new Set<string>();
  return entries.filter(e => {
    const key = `${e.type}|${e.name}|${e.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Extract middleware entries from a list of source files.
 *
 * @param filePaths - Absolute paths to source files
 * @param rootDir   - Project root for computing relative paths
 */
export async function extractMiddleware(
  filePaths: string[],
  rootDir: string
): Promise<MiddlewareEntry[]> {
  const results: MiddlewareEntry[] = [];

  await Promise.all(
    filePaths.map(async fp => {
      // Middleware/validation declared in test files are fixtures/assertions, not the
      // app's real middleware surface — exclude them (they produced phantom entries).
      if (isTestFile(fp)) return;
      const ext = extname(fp).toLowerCase();
      if (!['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) return;

      let source: string;
      try {
        source = await readFile(fp, 'utf-8');
      } catch {
        return;
      }

      const rel = relative(rootDir, fp);
      const entries = extractFromSource(source, rel, fp);
      results.push(...entries);
    })
  );

  return results;
}
