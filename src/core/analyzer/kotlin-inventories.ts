/**
 * Kotlin UI components and server middleware
 * (change: add-kotlin-ui-and-middleware-inventories, issue #546).
 *
 * Both inventories are import-gated: a Compose component is recognized only in a file that
 * imports a Compose package, and each middleware form only behind its framework's import.
 */
import { blankCommentsPreservingLayout } from './comment-blanking.js';
import { kotlinCodeMask, scanKotlinDeclarations, scanKotlinFile, type KotlinSignatureDeclaration } from './kotlin-source.js';

export interface KotlinComposeComponent {
  name: string;
  line: number;
  props: Array<{ name: string; type: string; required: boolean }>;
  /** Parameters whose type is a composable lambda (`content: @Composable () -> Unit`). */
  slots: string[];
  /** PascalCase names the body calls; narrowed to real components once every file is read. */
  calls: string[];
}

export interface KotlinComposePreview { name: string; line: number; calls: string[] }

export interface KotlinUiFacts {
  components: KotlinComposeComponent[];
  previews: KotlinComposePreview[];
  unmodeled: string[];
}

export type KotlinMiddlewareType = 'auth' | 'rate-limit' | 'cors' | 'logging' | 'body-parsing' | 'error-handler' | 'custom';

export interface KotlinMiddleware {
  type: KotlinMiddlewareType;
  framework: 'ktor' | 'spring' | 'jax-rs';
  name: string;
  line: number;
  offset: number;
}

const importsOf = (content: string): string[] => scanKotlinFile(content).imports.map(i => i.fqn);
const gated = (fqns: string[], prefixes: readonly string[]): boolean => fqns.some(f => prefixes.some(p => f === p || f.startsWith(`${p}.`)));

/** The body of a declaration: the text of its first `{ … }` block after `offset`, or its expression. */
function bodyAfter(mask: string, offset: number): string {
  // Skip the parameter list, then take the block or the rest of the expression statement.
  let i = mask.indexOf('(', offset);
  if (i < 0) return '';
  let depth = 0;
  for (; i < mask.length; i++) {
    if (mask[i] === '(') depth++;
    else if (mask[i] === ')') { depth--; if (depth === 0) { i++; break; } }
  }
  const open = mask.indexOf('{', i);
  const nextLine = mask.indexOf('\n', i);
  const equals = mask.slice(i, nextLine < 0 ? mask.length : nextLine).indexOf('=');
  if (open < 0 || (equals >= 0 && (nextLine >= 0 && open > nextLine))) return mask.slice(i, nextLine < 0 ? mask.length : nextLine);
  depth = 0;
  for (let k = open; k < mask.length && k < open + 200_000; k++) {
    if (mask[k] === '{') depth++;
    else if (mask[k] === '}') { depth--; if (depth === 0) return mask.slice(open, k + 1); }
  }
  return mask.slice(open);
}

const pascalCalls = (body: string): string[] =>
  [...new Set([...body.matchAll(/(?<![\w.])([A-Z][A-Za-z0-9_]*)\s*(?=[({])/g)].map(m => m[1]))].sort();

/** Compose components and previews of one Kotlin file. */
export function extractKotlinUi(content: string): KotlinUiFacts {
  const fqns = importsOf(content);
  const unmodeled = gated(fqns, ['android.view', 'android.widget']) ? ['android-views'] : [];
  if (!gated(fqns, ['androidx.compose', 'org.jetbrains.compose'])) return { components: [], previews: [], unmodeled };
  const mask = kotlinCodeMask(content);
  const components: KotlinComposeComponent[] = [];
  const previews: KotlinComposePreview[] = [];
  for (const d of scanKotlinDeclarations(content)) {
    if (d.kind !== 'function' || !d.annotations.includes('Composable')) continue;
    const calls = pascalCalls(bodyAfter(mask, d.offset)).filter(name => name !== d.name);
    if (d.annotations.includes('Preview')) { previews.push({ name: d.name, line: d.line, calls }); continue; }
    const parameters = d.parameters ?? [];
    components.push({
      name: d.name,
      line: d.line,
      props: parameters.map(p => ({ name: p.name, type: p.type ?? 'unknown', required: !p.hasDefault })),
      slots: parameters.filter(p => /@Composable\b/.test(p.type ?? '')).map(p => p.name),
      calls,
    });
  }
  return { components, previews, unmodeled };
}

const KTOR_PLUGIN_TYPES: ReadonlyArray<[RegExp, KotlinMiddlewareType]> = [
  [/^(?:Authentication|Sessions|Authorization)$/, 'auth'],
  [/^CORS$/, 'cors'],
  [/^RateLimit$/, 'rate-limit'],
  [/^(?:CallLogging|CallId|MicrometerMetrics)$/, 'logging'],
  [/^(?:ContentNegotiation|Compression|DoubleReceive)$/, 'body-parsing'],
  [/^StatusPages$/, 'error-handler'],
];

const SPRING_FILTER_TYPES: ReadonlySet<string> = new Set(['HandlerInterceptor', 'Filter', 'OncePerRequestFilter', 'WebFilter', 'GenericFilterBean']);
const JAXRS_FILTER_TYPES: ReadonlySet<string> = new Set(['ContainerRequestFilter', 'ContainerResponseFilter']);

function classifyByName(name: string): KotlinMiddlewareType {
  if (/auth|jwt|security|token/i.test(name)) return 'auth';
  if (/cors/i.test(name)) return 'cors';
  if (/rate|throttl/i.test(name)) return 'rate-limit';
  if (/log|trac|metric/i.test(name)) return 'logging';
  if (/error|exception/i.test(name)) return 'error-handler';
  return 'custom';
}

function supertypeNames(d: KotlinSignatureDeclaration): string[] {
  const header = d.signature.split('\n').filter(l => !l.startsWith('@')).join(' ');
  const colon = header.lastIndexOf(':', header.length);
  // The supertype list follows the last `)` of the constructor, or the name.
  const after = header.slice(Math.max(header.lastIndexOf(')', header.indexOf(' : ') < 0 ? header.length : header.indexOf(' : ')), 0));
  const list = after.includes(':') ? after.slice(after.indexOf(':') + 1) : colon >= 0 ? header.slice(colon + 1) : '';
  return list.split(',').map(part => part.trim().match(/^([\w.]+)/)?.[1]?.split('.').pop() ?? '').filter(Boolean);
}

/** Server middleware of one Kotlin file, in source order. */
export function extractKotlinMiddleware(content: string): { entries: KotlinMiddleware[]; unmodeled: string[] } {
  const fqns = importsOf(content);
  const unmodeled = [
    ...(gated(fqns, ['org.http4k']) ? ['http4k'] : []),
    ...(gated(fqns, ['io.javalin']) ? ['javalin'] : []),
  ];
  const ktor = gated(fqns, ['io.ktor.server']);
  const spring = gated(fqns, ['org.springframework']);
  const jaxRs = gated(fqns, ['javax.ws.rs', 'jakarta.ws.rs']);
  if (!ktor && !spring && !jaxRs) return { entries: [], unmodeled };

  const code = blankCommentsPreservingLayout(content);
  const lineStarts: number[] = [0];
  for (let i = 0; i < content.length; i++) if (content[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (offset: number): number => {
    let lo = 0;
    let hi = lineStarts.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (lineStarts[mid] <= offset) lo = mid + 1; else hi = mid; }
    return lo;
  };
  const entries: KotlinMiddleware[] = [];
  const add = (type: KotlinMiddlewareType, framework: KotlinMiddleware['framework'], name: string, offset: number): void => {
    entries.push({ type, framework, name, line: lineOf(offset), offset });
  };

  if (ktor) {
    for (const m of code.matchAll(/(?<![\w.])install\s*\(\s*([A-Za-z_][\w.]*)/g)) {
      const name = m[1].split('.').pop()!;
      add(KTOR_PLUGIN_TYPES.find(([re]) => re.test(name))?.[1] ?? 'custom', 'ktor', name, m.index);
    }
    for (const m of code.matchAll(/(?<![\w])intercept\s*\(\s*([A-Za-z_][\w.]*)/g)) add('custom', 'ktor', `intercept(${m[1]})`, m.index);
    for (const m of code.matchAll(/(?<![\w.])create(?:Application|RouteScoped)Plugin\s*\(\s*(?:name\s*=\s*)?"([^"\n]+)"/g)) add('custom', 'ktor', m[1], m.index);
  }
  if (spring || jaxRs) {
    for (const d of scanKotlinDeclarations(content)) {
      if (d.kind === 'class' || d.kind === 'object') {
        const parents = supertypeNames(d);
        if (spring && parents.some(p => SPRING_FILTER_TYPES.has(p))) add(classifyByName(d.name), 'spring', d.name, d.offset);
        else if (spring && (d.annotations.includes('ControllerAdvice') || d.annotations.includes('RestControllerAdvice'))) add('error-handler', 'spring', d.name, d.offset);
        if (jaxRs && d.annotations.includes('Provider') && parents.some(p => JAXRS_FILTER_TYPES.has(p))) add(classifyByName(d.name), 'jax-rs', d.name, d.offset);
      } else if (spring && d.kind === 'function' && d.annotations.includes('Bean') && /\bSecurity(?:Web)?FilterChain\b/.test(d.type ?? '')) {
        add('auth', 'spring', d.name, d.offset);
      }
    }
    if (spring) {
      for (const m of code.matchAll(/\.\s*addInterceptor\s*\(\s*([A-Za-z_]\w*)/g)) add(classifyByName(m[1]), 'spring', m[1], m.index);
    }
  }
  return { entries: entries.sort((a, b) => a.offset - b.offset), unmodeled };
}
