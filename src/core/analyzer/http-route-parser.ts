/**
 * HTTP Route Parser
 *
 * Extracts two complementary sets of data:
 *   1. HTTP CALLS  — fetch/axios/ky/got calls in JS/TS frontend files
 *   2. ROUTE DEFS  — FastAPI / Flask / Django route declarations in Python files
 *
 * These are then matched by `buildHttpEdges()` to create cross-language edges
 * between the frontend files that call an endpoint and the Python handlers that
 * serve it — filling the gap that static import analysis cannot reach.
 *
 * Matching strategy
 * -----------------
 * Routes are normalised to a canonical form before comparison:
 *   - Path parameters are replaced with a placeholder: /items/{id} → /items/:param
 *   - Leading slashes are normalised
 *   - Query strings are stripped from call-site URLs
 *   - Common API prefixes (/api, /api/v1, /v1, …) are tried both with and
 *     without the prefix so that a frontend call to /api/v1/search still matches
 *     a FastAPI router mounted at /search.
 *
 * Confidence levels
 * -----------------
 *   exact   — method + full path match
 *   path    — path matches, method unknown on one side (e.g. bare fetch)
 *   fuzzy   — normalised path matches after prefix stripping
 */

import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { isTestFile } from './test-file.js';
import { getSkeletonContent, detectLanguage } from './code-shaper.js';

// ============================================================================
// TYPES
// ============================================================================

/** An HTTP call found in a JS/TS source file */
export interface HttpCall {
  /** Absolute path of the file containing the call */
  file: string;
  /** HTTP method, upper-cased. 'UNKNOWN' when it cannot be determined. */
  method: string;
  /** URL as written in source — may be a template literal or variable ref */
  url: string;
  /** Normalised, static portion of the URL (params stripped, prefix removed) */
  normalizedUrl: string;
  /** 1-based source line */
  line: number;
  /** axios / fetch / ky / got / custom */
  client: string;
}

/** A route handler found in a Python source file */
export interface RouteDefinition {
  /** Absolute path of the file containing the handler */
  file: string;
  /** HTTP method, upper-cased */
  method: string;
  /** Path pattern as declared (may contain {param} or <param> placeholders) */
  path: string;
  /** Normalised path for matching */
  normalizedPath: string;
  /** Name of the handler function */
  handlerName: string;
  /** fastapi / flask / django / starlette / express / nestjs / nextjs-app etc. */
  framework: string;
  /** 1-based source line */
  line: number;
  /** Request body type extracted from handler signature, e.g. "CreateUserDto" or "z.infer<typeof schema>" */
  requestBodyType?: string;
  /** Response body type extracted from handler return type annotation, e.g. "User[]" or "void" */
  responseType?: string;
  /** How the contract was sourced */
  contractSource: 'annotation' | 'validator' | 'none';
}

/** A resolved cross-language edge */
export interface HttpEdge {
  /** Absolute path of the JS/TS caller file */
  callerFile: string;
  /** Absolute path of the Python handler file */
  handlerFile: string;
  method: string;
  /** Normalised path used for the match */
  path: string;
  call: HttpCall;
  route: RouteDefinition;
  /** How confident the match is */
  confidence: 'exact' | 'path' | 'fuzzy';
}

// The cross-service HTTP capability surface (which languages contribute client
// call sites / server routes) lives in a dependency-free leaf module so the
// language-support registry can derive its column without importing this module
// (several tests vi.mock it). Re-exported here for the public extraction API.
export {
  HTTP_CLIENT_LANGUAGES,
  HTTP_ROUTE_LANGUAGES,
  CROSS_SERVICE_HTTP_LANGUAGES,
} from './http-capability.js';

// ============================================================================
// NORMALISATION HELPERS
// ============================================================================

/** Common API prefixes that frontends add but backends may not declare */
const API_PREFIXES = [
  '/api/v1', '/api/v2', '/api/v3',
  '/api',
  '/v1', '/v2', '/v3',
];

/**
 * Reduce a URL/path to a comparable canonical form:
 *   - Strip protocol + host if present  (https://example.com/foo → /foo)
 *   - Strip query string and fragment
 *   - Replace path parameters with :param
 *     {id}, :id, <int:id>, <id>  →  :param
 *   - Collapse duplicate slashes
 *   - Remove trailing slash (except root)
 */
export function normalizeUrl(raw: string): string {
  // Remove template-literal variable parts: ${...}
  let url = raw.replace(/\$\{[^}]+\}/g, ':param');

  // Strip protocol + host
  url = url.replace(/^https?:\/\/[^/]+/, '');

  // Strip query string and fragment
  url = url.replace(/[?#].*$/, '');

  // Replace FastAPI / Flask style path params
  url = url.replace(/\{[^}]+\}/g, ':param');   // {item_id}
  url = url.replace(/<[^>]+>/g, ':param');      // <int:item_id>
  url = url.replace(/:[\w]+/g, ':param');       // :item_id  (Express style)

  // Collapse duplicate slashes, ensure leading slash
  url = ('/' + url).replace(/\/+/g, '/');

  // Remove trailing slash unless it IS the root
  if (url.length > 1 && url.endsWith('/')) url = url.slice(0, -1);

  return url.toLowerCase();
}

/**
 * Return all candidate normalised paths to try for a frontend URL.
 * We try both the full path and the path with each known prefix stripped,
 * to handle cases where the backend router is mounted without the prefix.
 */
function candidatePaths(normalizedUrl: string): string[] {
  const candidates = new Set<string>([normalizedUrl]);
  for (const prefix of API_PREFIXES) {
    if (normalizedUrl.startsWith(prefix + '/') || normalizedUrl === prefix) {
      candidates.add(normalizedUrl.slice(prefix.length) || '/');
    }
  }
  return Array.from(candidates);
}

// ============================================================================
// HTTP CALL EXTRACTION  (JS / TS)
// ============================================================================



/**
 * Extract all HTTP calls from a JavaScript or TypeScript source file.
 */
export async function extractHttpCalls(filePath: string): Promise<HttpCall[]> {
  const ext = extname(filePath).toLowerCase();
  if (!['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].includes(ext)) return [];

  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch {
    return [];
  }

  const calls: HttpCall[] = [];

  // Mask comments (to avoid false matches) LENGTH-PRESERVINGLY: blank them to spaces
  // and keep newlines, so `clean` stays byte-aligned with `content` and every
  // regex `m.index` below feeds getLine() the correct line. Removing comment text
  // instead (the old behavior) shifted offsets, so a call AFTER any comment got a
  // wrong (earlier) line — which then mis-resolved or dropped its enclosing-function
  // edge in the call-graph HTTP pass. The line-comment regex must NOT match `://`
  // inside URLs — only `//` preceded by whitespace, punctuation, brackets, or the
  // start of line (the prefix char is preserved; only the comment body is blanked).
  const clean = content
    .replace(/\/\*[\s\S]*?\*\//g, blankKeepNewlines)
    .replace(/(^|[\s,;()[\]{}])(\/\/.*)$/gm, (_m, prefix, comment) => prefix + ' '.repeat(comment.length));

  const lines = content.split('\n'); // keep original for line numbers

  // ── fetch ──────────────────────────────────────────────────────────────────
  // fetch('/api/search')
  // fetch(`/api/search/${id}`, { method: 'POST' })
  const fetchRegex = /\bfetch\s*\(\s*(`[^`]+`|'[^']+'|"[^"]+")\s*(?:,\s*\{([^}]*)\})?\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = fetchRegex.exec(clean)) !== null) {
    const rawUrl = m[1].replace(/^[`'"]/,'').replace(/[`'"]$/,'');
    const optionsBlock = m[2] ?? '';
    const methodMatch = optionsBlock.match(/method\s*:\s*['"`](\w+)['"`]/i);
    const method = methodMatch ? methodMatch[1].toUpperCase() : 'GET';

    calls.push({
      file: filePath,
      method,
      url: rawUrl,
      normalizedUrl: normalizeUrl(rawUrl),
      line: getLine(lines, m.index),
      client: 'fetch',
    });
  }

  // ── axios (method shorthands + generic) ────────────────────────────────────
  // axios.get('/api/items')
  // axios.post('/api/items', data)
  // axios({ method: 'post', url: '/api/items' })
  // axios.request({ method: 'DELETE', url: '/api/items/1' })
  const axiosMethodRegex = /\baxios\.(get|post|put|patch|delete|head|options)\s*\(\s*(`[^`]+`|'[^']+'|"[^"]+")/g;
  while ((m = axiosMethodRegex.exec(clean)) !== null) {
    const method = m[1].toUpperCase();
    const rawUrl = m[2].replace(/^[`'"]/,'').replace(/[`'"]$/,'');
    calls.push({
      file: filePath,
      method,
      url: rawUrl,
      normalizedUrl: normalizeUrl(rawUrl),
      line: getLine(lines, m.index),
      client: 'axios',
    });
  }

  // axios({ url: '...', method: '...' })  or  axios.request({ ... })
  const axiosConfigRegex = /\baxios(?:\.request)?\s*\(\s*\{([^}]{0,400})\}/g;
  while ((m = axiosConfigRegex.exec(clean)) !== null) {
    const block = m[1];
    const urlMatch = block.match(/url\s*:\s*(`[^`]+`|'[^']+'|"[^"]+")/);
    if (!urlMatch) continue;
    const rawUrl = urlMatch[1].replace(/^[`'"]/,'').replace(/[`'"]$/,'');
    const methodMatch = block.match(/method\s*:\s*['"`](\w+)['"`]/i);
    const method = methodMatch ? methodMatch[1].toUpperCase() : 'UNKNOWN';
    calls.push({
      file: filePath,
      method,
      url: rawUrl,
      normalizedUrl: normalizeUrl(rawUrl),
      line: getLine(lines, m.index),
      client: 'axios',
    });
  }

  // ── ky ─────────────────────────────────────────────────────────────────────
  // ky.get('/api/items')  ky.post('/api/items', { json: data })
  const kyRegex = /\bky\.(get|post|put|patch|delete|head)\s*\(\s*(`[^`]+`|'[^']+'|"[^"]+")/g;
  while ((m = kyRegex.exec(clean)) !== null) {
    const rawUrl = m[2].replace(/^[`'"]/,'').replace(/[`'"]$/,'');
    calls.push({
      file: filePath,
      method: m[1].toUpperCase(),
      url: rawUrl,
      normalizedUrl: normalizeUrl(rawUrl),
      line: getLine(lines, m.index),
      client: 'ky',
    });
  }

  // ── got ────────────────────────────────────────────────────────────────────
  // got.get('/api/items')
  const gotRegex = /\bgot\.(get|post|put|patch|delete|head)\s*\(\s*(`[^`]+`|'[^']+'|"[^"]+")/g;
  while ((m = gotRegex.exec(clean)) !== null) {
    const rawUrl = m[2].replace(/^[`'"]/,'').replace(/[`'"]$/,'');
    calls.push({
      file: filePath,
      method: m[1].toUpperCase(),
      url: rawUrl,
      normalizedUrl: normalizeUrl(rawUrl),
      line: getLine(lines, m.index),
      client: 'got',
    });
  }

  // ── React Query / SWR convenience wrappers ─────────────────────────────────
  // useQuery(['key', id], () => fetch('/api/items'))   — already caught above
  // useMutation(() => axios.post('/api/items'))        — already caught above

  return calls;
}

// ============================================================================
// ROUTE DEFINITION EXTRACTION  (Python)
// ============================================================================

/**
 * Extract all route definitions from a Python source file.
 * Supports FastAPI, Starlette, Flask, and Django (urls.py path/re_path).
 */
export async function extractRouteDefinitions(filePath: string): Promise<RouteDefinition[]> {
  const ext = extname(filePath).toLowerCase();
  if (!['.py', '.pyw'].includes(ext)) return [];

  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch {
    return [];
  }

  const routes: RouteDefinition[] = [];
  const lines = content.split('\n');

  // Mask comments AND triple-quoted strings, length-preservingly, before matching.
  // Length-preserving is load-bearing: every regex `m.index` below is fed to
  // getLine(lines, …), which measures against the ORIGINAL line lengths, so the
  // masked string must stay byte-aligned with `content` or the reported line (and
  // the handler resolved by scanning forward from it) drifts. Masking docstrings
  // also stops route patterns embedded in `.. code-block::` examples (e.g. Flask's
  // sansio/scaffold.py) from being matched as real routes. See the "non-code
  // masking" regression tests.
  const clean = maskPythonNonCode(content);

  // ── FastAPI / Starlette decorators ─────────────────────────────────────────
  // @app.get("/items/{item_id}")
  // @router.post("/search", ...)
  // @app.api_route("/multi", methods=["GET","POST"])
  const fastapiDecoratorRegex =
    /@(?:app|router|api_router)\.(get|post|put|patch|delete|head|options|trace)\s*\(\s*(['"/][^'")\n]+['"])/gm;
  let m: RegExpExecArray | null;
  while ((m = fastapiDecoratorRegex.exec(clean)) !== null) {
    const method = m[1].toUpperCase();
    const path = m[2].replace(/^['"]/, '').replace(/['"]$/, '');
    const lineNum = getLine(lines, m.index);
    // The handler name is on the `def` line right after the decorator block
    const handlerName = extractNextDefName(lines, lineNum);
    routes.push({
      file: filePath,
      method,
      path,
      normalizedPath: normalizeUrl(path),
      handlerName,
      framework: 'fastapi',
      line: lineNum,
      contractSource: 'none' as const,
    });
  }

  // @app.api_route("/path", methods=["GET", "POST"])
  const apiRouteRegex =
    /@(?:app|router|api_router)\.api_route\s*\(\s*(['"/][^'")\n]+['"]),\s*methods\s*=\s*\[([^\]]+)\]/gm;
  while ((m = apiRouteRegex.exec(clean)) !== null) {
    const path = m[1].replace(/^['"]/, '').replace(/['"]$/, '');
    const lineNum = getLine(lines, m.index);
    const handlerName = extractNextDefName(lines, lineNum);
    // Parse the methods list
    const methodMatches = m[2].matchAll(/['"](\w+)['"]/g);
    for (const mm of methodMatches) {
      routes.push({
        file: filePath,
        method: mm[1].toUpperCase(),
        path,
        normalizedPath: normalizeUrl(path),
        handlerName,
        framework: 'fastapi',
        line: lineNum,
        contractSource: 'none' as const,
      });
    }
  }

  // ── Flask ──────────────────────────────────────────────────────────────────
  // @app.route("/items", methods=["GET", "POST"])
  // @bp.route("/items/<int:item_id>", methods=["DELETE"])
  const flaskRouteRegex =
    /@(?:\w+)\.route\s*\(\s*(['"/][^'")\n]+['"]),?\s*(?:methods\s*=\s*\[([^\]]*)\])?\s*\)/gm;
  while ((m = flaskRouteRegex.exec(clean)) !== null) {
    const path = m[1].replace(/^['"]/, '').replace(/['"]$/, '');
    const lineNum = getLine(lines, m.index);
    const handlerName = extractNextDefName(lines, lineNum);
    const rawMethods = m[2];
    if (rawMethods) {
      const methodMatches = rawMethods.matchAll(/['"](\w+)['"]/g);
      for (const mm of methodMatches) {
        routes.push({
          file: filePath,
          method: mm[1].toUpperCase(),
          path,
          normalizedPath: normalizeUrl(path),
          handlerName,
          framework: 'flask',
          line: lineNum,
          contractSource: 'none' as const,
        });
      }
    } else {
      // Flask default is GET when no methods specified
      routes.push({
        file: filePath,
        method: 'GET',
        path,
        normalizedPath: normalizeUrl(path),
        handlerName,
        framework: 'flask',
        line: lineNum,
        contractSource: 'none' as const,
      });
    }
  }

  // ── Django urls.py ─────────────────────────────────────────────────────────
  // path('api/items/', views.ItemListView.as_view(), name='item-list'),
  // re_path(r'^api/items/(?P<pk>[0-9]+)/$', views.ItemDetailView.as_view()),
  //
  // NOTE: Django views handle HTTP method dispatch internally (via class-based
  // views or decorators), so no method is declared in urls.py. All Django
  // routes are stored with method='UNKNOWN', which means any frontend call
  // matched against a Django route will receive confidence='path' at best —
  // never 'exact'. This may produce false-positive edges when multiple HTTP
  // methods share the same URL pattern. Filter by confidence if this matters.
  // Match `path(...)` (Django 2.0+ simple converters) AND `re_path(...)` / the legacy
  // `url(...)` (regex routes). `\bpath` alone never matched `re_path` (the `_` blocks
  // the word boundary), so regex routes were silently unextracted.
  const djangoPathRegex =
    /\b(re_path|path|url)\s*\(\s*r?(['"])(.*?)\2\s*,\s*([\w.]+)/gm;
  while ((m = djangoPathRegex.exec(clean)) !== null) {
    const keyword = m[1];
    const rawPattern = m[3];
    // `path()` uses simple `<int:pk>` converters (normalizeUrl handles those);
    // `re_path()`/`url()` use a regex — convert capture groups to a path template.
    const path = keyword === 'path'
      ? '/' + rawPattern.replace(/\$$/, '').replace(/^\^/, '')
      : djangoRegexToTemplate(rawPattern);
    const handlerName = m[4].split('.').pop() ?? m[4];
    const lineNum = getLine(lines, m.index);
    routes.push({
      file: filePath,
      method: 'UNKNOWN', // Django views handle method internally
      path,
      normalizedPath: normalizeUrl(path),
      handlerName,
      framework: 'django',
      line: lineNum,
      contractSource: 'none' as const,
    });
  }

  return routes;
}

// ============================================================================
// ROUTE DEFINITION EXTRACTION  (Java — Spring MVC / JAX-RS)
// ============================================================================

const SPRING_METHOD_ANNOTATIONS: Array<[string, string]> = [
  ['GetMapping', 'GET'],
  ['PostMapping', 'POST'],
  ['PutMapping', 'PUT'],
  ['DeleteMapping', 'DELETE'],
  ['PatchMapping', 'PATCH'],
];

const JAXRS_METHOD_ANNOTATIONS: Array<[string, string]> = [
  ['GET', 'GET'],
  ['POST', 'POST'],
  ['PUT', 'PUT'],
  ['DELETE', 'DELETE'],
  ['PATCH', 'PATCH'],
  ['HEAD', 'HEAD'],
  ['OPTIONS', 'OPTIONS'],
];

/**
 * Extract a path string from a Spring annotation argument blob.
 *   ("/foo")           → /foo
 *   (value = "/foo")   → /foo
 *   (path  = "/foo")   → /foo
 *   (value = {"/foo", "/bar"}) → /foo (first only)
 *   ("/foo", method=…) → /foo
 */
function extractSpringPath(argsBlob: string): string | null {
  // Positional string: first quoted literal at start, possibly preceded by `{`
  const positional = argsBlob.match(/^\s*\{?\s*"([^"]*)"/);
  if (positional) return positional[1];
  const named = argsBlob.match(/(?:value|path)\s*=\s*\{?\s*"([^"]*)"/);
  if (named) return named[1];
  return null;
}

/**
 * Extract HTTP method from a Spring @RequestMapping argument blob.
 *   (method = RequestMethod.GET)  → GET
 *   (method = {RequestMethod.GET, RequestMethod.POST}) → [GET, POST]
 */
function extractSpringMethods(argsBlob: string): string[] {
  const match = argsBlob.match(/method\s*=\s*\{?([^}]+)\}?/);
  if (!match) return [];
  const methods: string[] = [];
  const methodRegex = /(?:RequestMethod\.)?([A-Z]+)/g;
  let m: RegExpExecArray | null;
  while ((m = methodRegex.exec(match[1])) !== null) {
    methods.push(m[1].toUpperCase());
  }
  return methods;
}

function combineSpringPaths(prefix: string, path: string): string {
  const normalizedPrefix = prefix.replace(/\/+$/, '');
  const normalizedPath = path ? '/' + path.replace(/^\/+/, '') : '';
  const combined = normalizedPrefix + normalizedPath;
  return combined || '/';
}

/**
 * Scan forward from an annotation line to find the handler method name.
 * Java method signatures: `public ReturnType methodName(args) ...`
 */
function extractNextJavaMethodName(lines: string[], annotationLine: number): string {
  const start = annotationLine - 1;
  const maxLook = Math.min(lines.length, start + 20);
  const skipNames = new Set(['if', 'for', 'while', 'switch', 'return', 'class', 'interface', 'enum', 'record', 'new']);
  for (let i = start; i < maxLook; i++) {
    const l = lines[i] ?? '';
    // Skip further annotation lines
    if (l.trim().startsWith('@')) continue;
    // Match `[modifiers] [@Annotation...] ReturnType methodName(` — return type
    // can include generics, arrays, and dotted names. Annotations may sit in the
    // return-type position (e.g. Spring's `public @ResponseBody Vets list()`),
    // so allow and skip them — otherwise the handler name resolves to "unknown".
    const match = l.match(
      /\b(?:public|private|protected)\s+(?:static\s+|final\s+|abstract\s+|synchronized\s+|default\s+|native\s+)*(?:@[\w.]+(?:\([^)]*\))?\s+)*(?:<[^>]+>\s+)?[\w<>[\], ?.]+?\s+(\w+)\s*\(/
    );
    if (match && !skipNames.has(match[1])) return match[1];
  }
  return 'unknown';
}

/**
 * Extract all HTTP route definitions from a Java source file.
 * Supports Spring MVC (@RestController / @Controller + @RequestMapping and the
 * shorthand @GetMapping / @PostMapping / …) and JAX-RS (@Path + @GET / @POST).
 */
export async function extractJavaRouteDefinitions(filePath: string): Promise<RouteDefinition[]> {
  const ext = extname(filePath).toLowerCase();
  if (ext !== '.java') return [];

  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch {
    return [];
  }

  const routes: RouteDefinition[] = [];
  const lines = content.split('\n');

  // Strip comments but preserve offsets so line numbers stay accurate.
  const clean = content
    .replace(/\/\*[\s\S]*?\*\//g, m => ' '.repeat(m.length))
    .replace(/\/\/.*$/gm, m => ' '.repeat(m.length));

  // ── Detect framework and compute class-level path prefix ───────────────────
  // Spring: class-level @RequestMapping(...)  |  JAX-RS: class-level @Path(...)
  let springPrefix = '';
  let jaxrsPrefix = '';

  // Find the first class declaration and look at annotations preceding it.
  const classMatch = clean.match(/\bclass\s+\w+/);
  if (classMatch && classMatch.index !== undefined) {
    const preamble = clean.slice(0, classMatch.index);
    const springClassMapping = preamble.match(/@RequestMapping\s*\(([^)]*)\)(?![^@]*@RequestMapping)/);
    if (springClassMapping) {
      const p = extractSpringPath(springClassMapping[1]);
      if (p) springPrefix = '/' + p.replace(/^\//, '');
    }
    const jaxrsClassPath = preamble.match(/@Path\s*\(\s*"([^"]+)"\s*\)(?![^@]*@Path)/);
    if (jaxrsClassPath) {
      jaxrsPrefix = '/' + jaxrsClassPath[1].replace(/^\//, '');
    }
  }

  const isSpring = /@(?:Rest)?Controller\b|@(?:Get|Post|Put|Delete|Patch)Mapping\b|@RequestMapping\b/.test(clean);
  // JAX-RS server annotations come from javax/jakarta.ws.rs. Require that import
  // so we don't mistake an HTTP CLIENT library for a server: Retrofit interfaces
  // use identically-named @GET/@POST/@Path from retrofit2.http (client request
  // templates, not server endpoints) and would otherwise yield phantom routes.
  const hasJaxrsImport = /\bimport\s+(?:static\s+)?(?:javax|jakarta)\.ws\.rs\b/.test(clean);
  const isJaxrs = hasJaxrsImport
    && /@Path\b/.test(clean)
    && /@(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/.test(clean);

  // ── Spring: shorthand mappings (@GetMapping, @PostMapping, …) ──────────────
  if (isSpring) {
    for (const [annotation, method] of SPRING_METHOD_ANNOTATIONS) {
      const re = new RegExp(`@${annotation}\\s*(?:\\(([^)]*)\\))?`, 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(clean)) !== null) {
        const argsBlob = m[1] ?? '';
        const path = extractSpringPath(argsBlob) ?? '';
        const fullPath = combineSpringPaths(springPrefix, path);
        const lineNum = getLine(lines, m.index);
        const handlerName = extractNextJavaMethodName(lines, lineNum);
        routes.push({
          file: filePath,
          method,
          path: fullPath,
          normalizedPath: normalizeUrl(fullPath),
          handlerName,
          framework: 'spring',
          line: lineNum,
          contractSource: 'none' as const,
        });
      }
    }

    // @RequestMapping(method = RequestMethod.GET, value = "/foo") on a method.
    // The class-level @RequestMapping is skipped because the class declaration
    // immediately follows it — we detect that by checking whether the nearest
    // forward token after the annotation is `class`.
    const reqMappingRegex = /@RequestMapping\s*\(([^)]*)\)/g;
    let m: RegExpExecArray | null;
    while ((m = reqMappingRegex.exec(clean)) !== null) {
      const argsBlob = m[1];
      const methods = extractSpringMethods(argsBlob);
      if (methods.length === 0) continue; // no method= → class-level or unhandled

      // Ensure this annotation is on a method, not on the class. Peek forward
      // past any subsequent annotations and check that we don't hit `class`
      // before a method-like signature.
      const afterIdx = m.index + m[0].length;
      const ahead = clean.slice(afterIdx, afterIdx + 400);
      const nextClass = ahead.search(/\bclass\s+\w+/);
      const nextMethod = ahead.search(
        /\b(?:public|private|protected)\s+(?:static\s+|final\s+|abstract\s+|synchronized\s+|default\s+|native\s+)*(?:<[^>]+>\s+)?[\w<>[\], ?.]+?\s+\w+\s*\(/
      );
      if (nextClass >= 0 && (nextMethod < 0 || nextClass < nextMethod)) continue;

      const path = extractSpringPath(argsBlob) ?? '';
      const fullPath = combineSpringPaths(springPrefix, path);
      const lineNum = getLine(lines, m.index);
      const handlerName = extractNextJavaMethodName(lines, lineNum);
      for (const method of methods) {
        routes.push({
          file: filePath,
          method,
          path: fullPath,
          normalizedPath: normalizeUrl(fullPath),
          handlerName,
          framework: 'spring',
          line: lineNum,
          contractSource: 'none' as const,
        });
      }
    }
  }

  // ── JAX-RS: @GET / @POST / @Path on methods ────────────────────────────────
  if (isJaxrs) {
    // Regex for a Java method signature; used to bound the annotation block
    // of the current method so we don't pick up a @Path from a later method.
    const methodSigRegex = /\b(?:public|private|protected)\s+[^{;]+?\s+\w+\s*\(/;

    for (const [annotation, method] of JAXRS_METHOD_ANNOTATIONS) {
      // Bare annotation with no argument list; path comes from class @Path
      // prefix combined with any @Path on the same method.
      const re = new RegExp(`@${annotation}\\b\\s*(?!\\()`, 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(clean)) !== null) {
        // Only look for a method-level @Path *within this method's annotation
        // block* — i.e. between the @GET and the next method signature.
        const afterIdx = m.index + m[0].length;
        const ahead = clean.slice(afterIdx, afterIdx + 400);
        const sigMatch = methodSigRegex.exec(ahead);
        const window = sigMatch ? ahead.slice(0, sigMatch.index) : ahead;
        const methodPathMatch = window.match(/@Path\s*\(\s*"([^"]+)"\s*\)/);
        const methodPath = methodPathMatch ? '/' + methodPathMatch[1].replace(/^\//, '') : '';
        const fullPath = combineSpringPaths(jaxrsPrefix, methodPath);
        const lineNum = getLine(lines, m.index);
        const handlerName = extractNextJavaMethodName(lines, lineNum);
        routes.push({
          file: filePath,
          method,
          path: fullPath,
          normalizedPath: normalizeUrl(fullPath),
          handlerName,
          framework: 'jaxrs',
          line: lineNum,
          contractSource: 'none' as const,
        });
      }
    }
  }

  return routes;
}

// ============================================================================
// EDGE BUILDER
// ============================================================================

/**
 * Extract server route definitions from one file, dispatching by extension to the
 * language's route extractor (Python / Java / TS-JS). Returns `[]` for a file no
 * route extractor handles. Used to recover the route key a single handler serves —
 * e.g. to drive cross-repo client→handler matching under federation.
 */
export async function extractRoutesFromFile(filePath: string): Promise<RouteDefinition[]> {
  const ext = extname(filePath).toLowerCase();
  if (['.py', '.pyw'].includes(ext)) return extractRouteDefinitions(filePath);
  if (ext === '.java') return extractJavaRouteDefinitions(filePath);
  if (['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].includes(ext)) return extractTsRouteDefinitions(filePath);
  return [];
}

/**
 * Match HTTP calls from JS/TS files against route definitions from Python files
 * and return cross-language edges.
 *
 * Pass in pre-extracted calls and routes (so callers can cache them across
 * multiple graph builds without re-parsing).
 */
export function buildHttpEdges(
  calls: HttpCall[],
  routes: RouteDefinition[]
): HttpEdge[] {
  const edges: HttpEdge[] = [];

  // Index routes by normalised path for O(1) lookup
  const routesByPath = new Map<string, RouteDefinition[]>();
  for (const route of routes) {
    const existing = routesByPath.get(route.normalizedPath) ?? [];
    existing.push(route);
    routesByPath.set(route.normalizedPath, existing);
  }

  for (const call of calls) {
    // Build all candidate paths (handles /api/v1 prefix stripping)
    const candidates = candidatePaths(call.normalizedUrl);
    let matched = false;

    for (const candidate of candidates) {
      const matchingRoutes = routesByPath.get(candidate);
      if (!matchingRoutes) continue;

      for (const route of matchingRoutes) {
        const methodsKnown = call.method !== 'UNKNOWN' && route.method !== 'UNKNOWN';
        const methodsMatch = call.method === route.method;

        // Both methods known and different → genuinely different endpoints (a client
        // `GET /users` and a `POST /users` handler are distinct operations, usually
        // distinct functions). Emit NOTHING rather than a phantom 'path' edge that
        // would mis-link the client to the wrong handler. A match still requires only
        // method compatibility (equal, or at least one UNKNOWN — a bare `fetch`, or a
        // Django route that dispatches methods internally).
        if (methodsKnown && !methodsMatch) continue;

        // Determine confidence.
        let confidence: HttpEdge['confidence'];
        if (methodsKnown && methodsMatch && candidate === call.normalizedUrl) {
          confidence = 'exact';
        } else if (candidate !== call.normalizedUrl) {
          confidence = 'fuzzy';
        } else {
          confidence = 'path';
        }

        edges.push({
          callerFile: call.file,
          handlerFile: route.file,
          method: methodsKnown ? call.method : route.method,
          path: candidate,
          call,
          route,
          confidence,
        });
        matched = true;
      }
    }

    // If no match found via exact/prefix logic, try fuzzy segment comparison
    if (!matched) {
      const callSegments = call.normalizedUrl.replace(/:param/g, '*').split('/');
      for (const [routePath, routeList] of routesByPath) {
        const routeSegments = routePath.replace(/:param/g, '*').split('/');
        if (callSegments.length !== routeSegments.length) continue;
        const allMatch = callSegments.every(
          (seg, i) => seg === routeSegments[i] || seg === '*' || routeSegments[i] === '*'
        );
        if (!allMatch) continue;
        for (const route of routeList) {
          // Same method-compatibility rule as the exact/prefix path above: both
          // methods known and different → not a match, even on a fuzzy segment hit.
          if (call.method !== 'UNKNOWN' && route.method !== 'UNKNOWN' && call.method !== route.method) continue;
          edges.push({
            callerFile: call.file,
            handlerFile: route.file,
            method: call.method !== 'UNKNOWN' ? call.method : route.method,
            path: routePath,
            call,
            route,
            confidence: 'fuzzy',
          });
        }
      }
    }
  }

  // Deduplicate: same caller file + handler file + method + path
  const seen = new Set<string>();
  return edges.filter(e => {
    const key = `${e.callerFile}|${e.handlerFile}|${e.method}|${e.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ============================================================================
// BATCH HELPERS
// ============================================================================

/**
 * Parse all files in a mixed JS+Python codebase and return HTTP edges.
 * Intended to be called once per graph build and its result merged into
 * the DependencyGraphResult edges.
 */
export async function extractAllHttpEdges(filePaths: string[]): Promise<{
  calls: HttpCall[];
  routes: RouteDefinition[];
  edges: HttpEdge[];
}> {
  // Collect per-file results and flatten in filePaths order. `Promise.all` resolves
  // in INPUT order regardless of completion order, so the aggregated calls/routes
  // (and therefore the edges) are a deterministic function of the file list — NOT of
  // filesystem I/O timing. Pushing into shared arrays inside the callbacks would
  // append in completion order, a latent byte-determinism hazard the spec forbids
  // (and the shareable-bundle digest relies on).
  const perFile = await Promise.all(
    filePaths.map(async (fp): Promise<{ calls: HttpCall[]; routes: RouteDefinition[] }> => {
      const ext = extname(fp).toLowerCase();
      if (['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].includes(ext)) {
        // A JS/TS file can be a client (fetch/axios calls), a server (route
        // registrations), or both (a full-stack monorepo). Extract BOTH so a
        // SAME-LANGUAGE client→server link (TS frontend → TS Express/NestJS/Next
        // backend) is matched — not only the cross-language JS/TS→Python/Java
        // case. Routes in .py/.java files are already extracted below.
        const [calls, routes] = await Promise.all([
          extractHttpCalls(fp),
          extractTsRouteDefinitions(fp),
        ]);
        return { calls, routes };
      } else if (['.py', '.pyw'].includes(ext)) {
        return { calls: [], routes: await extractRouteDefinitions(fp) };
      } else if (ext === '.java') {
        return { calls: [], routes: await extractJavaRouteDefinitions(fp) };
      }
      return { calls: [], routes: [] };
    })
  );
  const allCalls: HttpCall[] = perFile.flatMap(r => r.calls);
  const allRoutes: RouteDefinition[] = perFile.flatMap(r => r.routes);

  const edges = buildHttpEdges(allCalls, allRoutes);
  return { calls: allCalls, routes: allRoutes, edges };
}

// ============================================================================
// PRIVATE UTILITIES
// ============================================================================

/**
 * Convert a Django `re_path`/`url` regex pattern to a comparable path template:
 * strip the `^`/`$` anchors, replace each capture group (named `(?P<pk>…)`,
 * non-capturing `(?:…)`, or plain `(…)`) with a `:param` placeholder, and unescape
 * `\.`/`\/`. e.g. `^api/items/(?P<pk>[0-9]+)/$` → `/api/items/:param/`. Best-effort:
 * a nested-group pattern degrades to a partial template (over-masking only drops a
 * potential match, never invents one).
 */
function djangoRegexToTemplate(re: string): string {
  let p = re.replace(/^\^/, '').replace(/\$$/, '');
  p = p.replace(/\(\?P<[^>]+>[^)]*\)/g, ':param'); // named group
  p = p.replace(/\(\?:[^)]*\)/g, ':param');        // non-capturing group
  p = p.replace(/\([^)]*\)/g, ':param');           // plain group
  p = p.replace(/\\([./])/g, '$1');                // unescape \. and \/
  return '/' + p.replace(/^\/+/, '');
}

/** Replace every non-newline char of `match` with a space (length- and line-preserving). */
function blankKeepNewlines(match: string): string {
  return match.replace(/[^\n]/g, ' ');
}

/**
 * Length-preserving mask of Python triple-quoted strings and `#` line comments.
 * Triple-quoted strings are masked first (a docstring can contain `#` and route
 * patterns), then `#` comments on what remains. Masked regions become spaces with
 * newlines kept, so the result is byte-aligned with `content`: route regexes can
 * neither match inside docstrings/comments nor shift the offsets getLine() turns
 * into line numbers. Over-masking (e.g. a stray `"""` inside a comment) only ever
 * drops a potential match — never invents one — which matches the false-negatives-
 * over-false-positives bias of the route-handler synthesis that consumes this.
 */
function maskPythonNonCode(content: string): string {
  const stringsMasked = content.replace(/'''[\s\S]*?'''|"""[\s\S]*?"""/g, blankKeepNewlines);
  return stringsMasked.replace(/#[^\n]*/g, blankKeepNewlines);
}

/** Convert a character offset in `content` to a 1-based line number */
function getLine(lines: string[], charOffset: number): number {
  let accumulated = 0;
  for (let i = 0; i < lines.length; i++) {
    accumulated += lines[i].length + 1; // +1 for newline
    if (accumulated > charOffset) return i + 1;
  }
  return lines.length;
}

/**
 * Given the line of a decorator, scan forward to find the next `def` name.
 * Handles multi-line decorators with up to 10 lines of lookahead.
 *
 * `decoratorLine` is 1-based (from getLine()), so we convert to a 0-based
 * index before indexing into the `lines` array.
 */
function extractNextDefName(lines: string[], decoratorLine: number): string {
  const start = decoratorLine - 1; // convert 1-based → 0-based
  const maxLook = Math.min(lines.length, start + 10);
  for (let i = start; i < maxLook; i++) {
    const defMatch = lines[i]?.match(/^\s*(?:async\s+)?def\s+(\w+)/);
    if (defMatch) return defMatch[1];
  }
  return 'unknown';
}

// ============================================================================
// CONTRACT / TYPE EXTRACTION HELPERS
// ============================================================================

/**
 * Extract contract information from a handler function body or surrounding context.
 *
 * Strategies:
 *   1. TypeScript Request<P, ResBody, ReqBody, Q> generic → requestBodyType = ReqBody
 *   2. NestJS @Body() dto: Type → requestBodyType = Type
 *   3. Zod .parse( / .parseAsync( → contractSource = 'validator'
 *   4. Promise<ResponseType> return annotation
 */
function extractContractFromHandler(
  handlerSource: string
): { requestBodyType?: string; responseType?: string; contractSource: 'annotation' | 'validator' | 'none' } {
  let requestBodyType: string | undefined;
  let responseType: string | undefined;
  let contractSource: 'annotation' | 'validator' | 'none' = 'none';

  // 1. TypeScript Request<P, ResBody, ReqBody, Q> generic
  //    handler(req: Request<Params, ResBody, Body, Query>)
  const reqGenericRe = /:\s*Request\s*<[^,>]+,\s*([^,>]+),\s*([^,>]+)/;
  const reqGenericMatch = reqGenericRe.exec(handlerSource);
  if (reqGenericMatch) {
    const resBodyType = reqGenericMatch[1].trim();
    const reqBodyType = reqGenericMatch[2].trim();
    if (reqBodyType && reqBodyType !== 'unknown' && reqBodyType !== 'any') {
      requestBodyType = reqBodyType;
      contractSource = 'annotation';
    }
    if (resBodyType && resBodyType !== 'unknown' && resBodyType !== 'any') {
      responseType = resBodyType;
    }
  }

  // 2. NestJS @Body() dto: CreateUserDto
  const bodyParamRe = /@Body\s*\(\s*\)\s+\w+\s*:\s*(\w+)/;
  const bodyParamMatch = bodyParamRe.exec(handlerSource);
  if (bodyParamMatch) {
    requestBodyType = bodyParamMatch[1];
    contractSource = 'annotation';
  }

  // 3. Zod validators: schema.parse( / schema.parseAsync( / z.infer<typeof
  const zodRe = /\b\w+\.parse(?:Async)?\s*\(|z\.infer\s*<\s*typeof\s+(\w+)/;
  const zodMatch = zodRe.exec(handlerSource);
  if (zodMatch) {
    contractSource = 'validator';
    if (zodMatch[1]) {
      requestBodyType = `z.infer<typeof ${zodMatch[1]}>`;
    } else {
      // Extract schema variable name from .parse( call
      const parseVarRe = /(\w+)\.parse(?:Async)?\s*\(/;
      const parseVarMatch = parseVarRe.exec(handlerSource);
      if (parseVarMatch) {
        requestBodyType = parseVarMatch[1];
      }
    }
  }

  // 4. Promise<ResponseType> return type annotation
  const returnTypeRe = /\):\s*Promise\s*<\s*([^>]+)>/;
  const returnTypeMatch = returnTypeRe.exec(handlerSource);
  if (returnTypeMatch && !responseType) {
    const rType = returnTypeMatch[1].trim();
    if (rType && rType !== 'void' && rType !== 'unknown' && rType !== 'any') {
      responseType = rType;
    }
  }

  return { requestBodyType, responseType, contractSource };
}

// ============================================================================
// TS/JS SERVER ROUTE EXTRACTION
// ============================================================================

// Express / Hono / Fastify / Koa / Elysia style:
//   app.get('/path', handler)
//   router.post('/path', ...)
//   app.use('/prefix', router)     ← prefix accumulation
// `fastify` is included because the Fastify plugin idiom names the instance `fastify`
// (the closure param) and registers routes as `fastify.get('/path', …)` — the standard
// in Fastify's own docs/demo. The receiver allowlist stays explicit (not `\w+`) to avoid
// matching unrelated `.get(...)` calls (e.g. an axios `instance.get(url)`).
const EXPRESS_ROUTE_RE = /(?:^|[\s;(,])(?:app|router|server|api|fastify|r)\.(get|post|put|delete|patch|head|options|all)\s*\(\s*['"`]([^'"`]+)['"`]/gm;
const EXPRESS_USE_RE = /(?:^|[\s;(,])(?:app|router|server|api|fastify|r)\.use\s*\(\s*['"`]([^'"`]+)['"`]/gm;

// NestJS decorator-based:
//   @Controller('prefix')  →  class methods with @Get / @Post etc.
const NESTJS_CONTROLLER_RE = /@Controller\s*\(\s*['"`]([^'"`]*)['"`]\s*\)/g;
const NESTJS_METHOD_RE = /@(Get|Post|Put|Delete|Patch|Head|Options|All)\s*\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/g;
const NESTJS_HANDLER_RE = /(?:async\s+)?(\w+)\s*\(/;

// Next.js App Router: export (async) function GET(...) in app/**/route.ts
const NEXTJS_APP_ROUTER_RE = /^export\s+(?:async\s+)?function\s+(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s*\(/gm;

/** Detected framework from a file's content */
function detectTsFramework(source: string, filePath: string): string {
  if (/@Controller\s*\(/.test(source) && /@(Get|Post|Put|Delete|Patch)\s*\(/.test(source)) return 'nestjs';
  if (/app\/.*\/route\.[jt]sx?$/.test(filePath.replace(/\\/g, '/'))) return 'nextjs-app';
  if (/pages\/api\//.test(filePath.replace(/\\/g, '/'))) return 'nextjs-pages';
  if (/from\s+['"]hono['"]/.test(source) || /new\s+Hono\s*[(<]/.test(source)) return 'hono';
  // Match bare `fastify` AND scoped `@fastify/*` imports (e.g. @fastify/type-provider-typebox):
  // Fastify route plugins routinely import only the scoped helpers, not the bare package.
  if (/from\s+['"](?:fastify|@fastify\/[^'"]+)['"]/.test(source) || /require\s*\(\s*['"](?:fastify|@fastify\/[^'"]+)['"]\s*\)/.test(source) || /fastify\s*\(/.test(source)) return 'fastify';
  if (/from\s+['"]express['"]/.test(source) || /require\s*\(\s*['"]express['"]\s*\)/.test(source)) return 'express';
  if (/from\s+['"]koa['"]/.test(source)) return 'koa';
  if (/from\s+['"]elysia['"]/.test(source)) return 'elysia';
  if (new RegExp(EXPRESS_ROUTE_RE.source).test(source)) return 'express';
  return 'unknown';
}

/**
 * Extract HTTP route definitions from a TypeScript/JavaScript server file.
 * Handles Express-style, NestJS decorators, and Next.js App Router.
 */
export async function extractTsRouteDefinitions(filePath: string): Promise<RouteDefinition[]> {
  let source: string;
  try {
    const { readFile } = await import('node:fs/promises');
    // Use skeleton to strip comments — prevents false positives from comment
    // examples inside parser/extractor files that contain route pattern strings.
    // Line numbers in the result are approximate (skeleton line positions).
    source = getSkeletonContent(await readFile(filePath, 'utf-8'), detectLanguage(filePath));
  } catch {
    return [];
  }

  const framework = detectTsFramework(source, filePath);
  const routes: RouteDefinition[] = [];
  const lines = source.split('\n');

  function lineOf(index: number): number {
    return source.slice(0, index).split('\n').length;
  }

  // ── Next.js App Router ────────────────────────────────────────────────────
  if (framework === 'nextjs-app') {
    // Derive path from file location: app/users/route.ts → /users.
    // Force a leading slash first: the analyze pipeline passes REPO-RELATIVE paths
    // (e.g. `app/api/posts/route.ts`), and `lastIndexOf('/app/')` would miss the
    // leading `app/` segment — collapsing the route to `/` and breaking both the
    // route inventory and the cross-service edge. The absolute form is unaffected.
    const rel = '/' + filePath.replace(/\\/g, '/').replace(/^\/+/, '');
    const appIdx = rel.lastIndexOf('/app/');
    let routePath = '/';
    if (appIdx >= 0) {
      routePath = rel.slice(appIdx + 4).replace(/\/route\.[jt]sx?$/, '') || '/';
      // Remove dynamic segments brackets for display: [id] → :id
      routePath = routePath.replace(/\[([^\]]+)\]/g, ':$1');
    }

    const re = new RegExp(NEXTJS_APP_ROUTER_RE.source, NEXTJS_APP_ROUTER_RE.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      // Extract handler body for contract detection (scan next 500 chars)
      const handlerBody = source.slice(m.index, m.index + 500);
      const contract = extractContractFromHandler(handlerBody);
      routes.push({
        file: filePath,
        method: m[1].toUpperCase(),
        path: routePath,
        normalizedPath: normalizeUrl(routePath),
        handlerName: m[1],
        framework: 'nextjs-app',
        line: lineOf(m.index),
        ...contract,
      });
    }
    return routes;
  }

  // ── NestJS ────────────────────────────────────────────────────────────────
  if (framework === 'nestjs') {
    // Collect controller prefixes
    const ctrlRe = new RegExp(NESTJS_CONTROLLER_RE.source, NESTJS_CONTROLLER_RE.flags);
    let ctrlPrefix = '';
    const ctrlMatch = ctrlRe.exec(source);
    if (ctrlMatch) {
      ctrlPrefix = ctrlMatch[1] ? `/${ctrlMatch[1].replace(/^\//, '')}` : '';
    }

    const methodRe = new RegExp(NESTJS_METHOD_RE.source, NESTJS_METHOD_RE.flags);
    let m: RegExpExecArray | null;
    while ((m = methodRe.exec(source)) !== null) {
      const httpMethod = m[1].toUpperCase();
      const subPath = m[2] ? `/${m[2].replace(/^\//, '')}` : '';
      const fullPath = `${ctrlPrefix}${subPath}` || '/';

      // Find handler function name on subsequent lines
      const afterDecorator = source.slice(m.index + m[0].length);
      const handlerMatch = NESTJS_HANDLER_RE.exec(afterDecorator.slice(0, 200));
      const handlerName = handlerMatch?.[1] ?? 'unknown';

      // Extract contract from decorator + handler context (scan next 400 chars)
      const handlerContext = source.slice(m.index, m.index + 400);
      const contract = extractContractFromHandler(handlerContext);

      routes.push({
        file: filePath,
        method: httpMethod,
        path: fullPath,
        normalizedPath: normalizeUrl(fullPath),
        handlerName,
        framework: 'nestjs',
        line: lineOf(m.index),
        ...contract,
      });
    }
    return routes;
  }

  // ── Express / Hono / Fastify / Koa / Elysia ───────────────────────────────
  // Collect prefix map from .use() calls (best-effort)
  const prefixes: string[] = [];
  const useRe = new RegExp(EXPRESS_USE_RE.source, EXPRESS_USE_RE.flags);
  let um: RegExpExecArray | null;
  while ((um = useRe.exec(source)) !== null) {
    prefixes.push(um[1]);
  }

  const routeRe = new RegExp(EXPRESS_ROUTE_RE.source, EXPRESS_ROUTE_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = routeRe.exec(source)) !== null) {
    const method = m[1].toUpperCase();
    let path = m[2];

    // Apply a prefix if the route is relative (no leading slash)
    if (!path.startsWith('/') && prefixes.length > 0) {
      path = `${prefixes[0]}/${path}`;
    }

    // EXPRESS_ROUTE_RE opens with `(?:^|[\s;(,])` so the match can start on the
    // character BEFORE the receiver — and when a route registration begins a line
    // (the common top-level `app.get(...)` idiom), that leading char is the prior
    // line's newline, so `m.index` lands one line early. Advance to the actual
    // receiver token before computing the line, or the handler-name lookup reads
    // the previous line (e.g. a `function h(req, res)` def → grabs `res`) and the
    // cross-service edge / route-handler synthesis silently fails to wire.
    const recOffset = Math.max(0, m[0].search(/(?:app|router|server|api|fastify|r)\s*\./));
    const routeLine = lineOf(m.index + recOffset);

    // Find the handler name from the route registration line
    const lineText = lines[routeLine - 1] ?? '';
    const handlerMatch = lineText.match(/,\s*(?:async\s+)?(?:function\s+)?(\w+)\s*[,)]/);
    const handlerName = handlerMatch?.[1] ?? 'handler';

    // Extract contract from route context (scan next 600 chars)
    const routeContext = source.slice(m.index, m.index + 600);
    const contract = extractContractFromHandler(routeContext);

    routes.push({
      file: filePath,
      method,
      path,
      normalizedPath: normalizeUrl(path),
      handlerName,
      framework,
      line: routeLine,
      ...contract,
    });
  }

  return routes;
}

// ============================================================================
// ROUTE INVENTORY
// ============================================================================

export interface RouteInventory {
  total: number;
  byMethod: Record<string, number>;
  byFramework: Record<string, number>;
  routes: Array<{
    method: string;
    path: string;
    framework: string;
    file: string;
    handler: string;
    requestBodyType?: string;
    responseType?: string;
    contractSource: 'annotation' | 'validator' | 'none';
  }>;
}

/**
 * Build a complete route inventory from all source files.
 * Combines Python routes (extractRouteDefinitions) and TS/JS routes
 * (extractTsRouteDefinitions) into a single summary.
 *
 * @param filePaths - Absolute paths to all source files in the project
 * @param rootDir   - Project root for computing relative paths
 */
export async function buildRouteInventory(
  filePaths: string[],
  rootDir: string
): Promise<RouteInventory> {
  const { relative } = await import('node:path');

  const allRoutes: RouteDefinition[] = [];

  await Promise.all(
    filePaths.map(async fp => {
      // Routes declared inside test files (e.g. a `fastify.get('/error')` set up by a
      // test harness) are fixtures, not the app's real API surface — exclude them so the
      // inventory doesn't report phantom endpoints.
      if (isTestFile(fp)) return;
      const ext = extname(fp).toLowerCase();
      if (['.py', '.pyw'].includes(ext)) {
        allRoutes.push(...await extractRouteDefinitions(fp));
      } else if (['.ts', '.tsx', '.js', '.jsx', '.mjs'].includes(ext)) {
        allRoutes.push(...await extractTsRouteDefinitions(fp));
      } else if (ext === '.java') {
        allRoutes.push(...await extractJavaRouteDefinitions(fp));
      }
    })
  );

  const byMethod: Record<string, number> = {};
  const byFramework: Record<string, number> = {};

  for (const r of allRoutes) {
    byMethod[r.method] = (byMethod[r.method] ?? 0) + 1;
    byFramework[r.framework] = (byFramework[r.framework] ?? 0) + 1;
  }

  return {
    total: allRoutes.length,
    byMethod,
    byFramework,
    routes: allRoutes.map(r => ({
      method: r.method,
      path: r.path,
      framework: r.framework,
      file: relative(rootDir, r.file),
      handler: r.handlerName,
      requestBodyType: r.requestBodyType,
      responseType: r.responseType,
      contractSource: r.contractSource,
    })),
  };
}
