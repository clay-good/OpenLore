/**
 * Kotlin UI components and middleware
 * (change: add-kotlin-ui-and-middleware-inventories, issue #546).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { extractKotlinMiddleware, extractKotlinUi } from './kotlin-inventories.js';
import { extractMiddleware } from './middleware-extractor.js';
import { extractUIComponents } from './ui-component-extractor.js';

const COMPOSE = [
  'package ui',
  'import androidx.compose.runtime.Composable',
  'import androidx.compose.ui.tooling.preview.Preview',
  '',
  '@Composable',
  'fun Card(title: String, subtitle: String? = null, content: @Composable () -> Unit) {',
  '  Column {',
  '    Title(title)',
  '    content()',
  '  }',
  '}',
  '',
  '@Composable',
  'fun Title(text: String) = Text(text)',
  '',
  '@Preview',
  '@Composable',
  'fun CardPreview() {',
  '  Card("a") { Title("b") }',
  '}',
  '',
  'fun notComposable(x: Int) = x',
].join('\n');

describe('Compose components', () => {
  it('lists `@Composable` functions with props, slots, and what they call; a preview is not a component', () => {
    const facts = extractKotlinUi(COMPOSE);
    expect(facts.components).toEqual([
      {
        name: 'Card', line: 6,
        props: [{ name: 'title', type: 'String', required: true }, { name: 'subtitle', type: 'String?', required: false }, { name: 'content', type: '@Composable () -> Unit', required: true }],
        slots: ['content'], calls: ['Column', 'Title'],
      },
      { name: 'Title', line: 14, props: [{ name: 'text', type: 'String', required: true }], slots: [], calls: ['Text'] },
    ]);
    expect(facts.previews).toEqual([{ name: 'CardPreview', line: 18, calls: ['Card', 'Title'] }]);
  });

  it('ignores a project annotation named `Composable` without the Compose import', () => {
    expect(extractKotlinUi('package ui\nannotation class Composable\n@Composable\nfun Card() {}\n')).toEqual({ components: [], previews: [], unmodeled: [] });
  });

  it('counts Android Views as a known UI framework that is not modeled', () => {
    expect(extractKotlinUi('import android.widget.TextView\nclass Screen\n').unmodeled).toEqual(['android-views']);
  });
});

describe('Kotlin middleware', () => {
  const entries = (source: string) => extractKotlinMiddleware(source).entries.map(e => `${e.framework}:${e.type}:${e.name}`);

  it('lists Ktor plugin installations in source order, interceptors, and plugin definitions', () => {
    expect(entries([
      'import io.ktor.server.application.*',
      'val Audit = createApplicationPlugin(name = "AuditPlugin") { }',
      'fun Application.module() {',
      '  install(CallLogging)',
      '  install(Authentication) { jwt { } }',
      '  install(CORS)',
      '  install(ContentNegotiation) { json() }',
      '  install(StatusPages) { }',
      '  install(RateLimit) { }',
      '  install(Audit)',
      '  intercept(ApplicationCallPipeline.Plugins) { }',
      '}',
    ].join('\n'))).toEqual([
      'ktor:custom:AuditPlugin', 'ktor:logging:CallLogging', 'ktor:auth:Authentication', 'ktor:cors:CORS',
      'ktor:body-parsing:ContentNegotiation', 'ktor:error-handler:StatusPages', 'ktor:rate-limit:RateLimit',
      'ktor:custom:Audit', 'ktor:custom:intercept(ApplicationCallPipeline.Plugins)',
    ]);
  });

  it('lists Spring interceptors, filters, security filter chains, registrations, and controller advice', () => {
    expect(entries([
      'import org.springframework.web.servlet.HandlerInterceptor',
      'import org.springframework.context.annotation.Bean',
      'class AuthInterceptor : HandlerInterceptor',
      'class RequestLogFilter(private val log: Logger) : OncePerRequestFilter() {',
      '  override fun doFilterInternal() {}',
      '}',
      'class TenantFilter : WebFilter',
      '@ControllerAdvice',
      'class ApiErrors',
      'class Config : WebMvcConfigurer {',
      '  @Bean',
      '  fun chain(http: HttpSecurity): SecurityFilterChain = http.build()',
      '  override fun addInterceptors(registry: InterceptorRegistry) {',
      '    registry.addInterceptor(AuthInterceptor())',
      '  }',
      '}',
      'class Plain : Runnable',
    ].join('\n'))).toEqual([
      'spring:auth:AuthInterceptor', 'spring:logging:RequestLogFilter', 'spring:custom:TenantFilter',
      'spring:error-handler:ApiErrors', 'spring:auth:chain', 'spring:auth:AuthInterceptor',
    ]);
  });

  it('lists JAX-RS provider filters', () => {
    expect(entries('import jakarta.ws.rs.container.ContainerRequestFilter\nimport jakarta.ws.rs.ext.Provider\n@Provider\nclass TokenFilter : ContainerRequestFilter\nclass NotProvided : ContainerRequestFilter\n'))
      .toEqual(['jax-rs:auth:TokenFilter']);
  });

  it('does not take a function named `install` for middleware without the Ktor import', () => {
    expect(entries('package a\nfun setup() {\n  install(Something)\n}\n')).toEqual([]);
    expect(entries('import com.acme.plugins.install\nfun setup() {\n  install(Something)\n}\n')).toEqual([]);
  });

  it('counts a known server framework that is not modeled', () => {
    expect(extractKotlinMiddleware('import org.http4k.core.Filter\nimport io.javalin.Javalin\nval f = 1\n').unmodeled).toEqual(['http4k', 'javalin']);
  });
});

describe('Kotlin inventories through the extractors', () => {
  const root = mkdtempSync(join(tmpdir(), 'openlore-kotlin-inv-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const write = (rel: string, content: string): string => {
    const path = join(root, rel);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
    return path;
  };

  it('narrows children and previews to real components across files', async () => {
    const files = [
      write('ui/Card.kt', COMPOSE),
      write('ui/Screen.kt', 'package ui\nimport androidx.compose.runtime.Composable\n@Composable\nfun Screen() {\n  Card("t") { }\n  Scaffold { }\n}\n'),
      write('legacy/View.kt', 'import android.widget.TextView\nclass LegacyView\n'),
    ];
    const receipts = { unmodeledFrameworks: {} as Record<string, number> };
    const components = await extractUIComponents(files, root, undefined, receipts);
    expect(components.map(c => ({ name: c.name, framework: c.framework, children: c.children, previews: c.previews, slots: c.slots }))).toEqual([
      { name: 'Card', framework: 'compose', children: ['Title'], previews: ['CardPreview'], slots: ['content'] },
      { name: 'Title', framework: 'compose', children: undefined, previews: ['CardPreview'], slots: undefined },
      { name: 'Screen', framework: 'compose', children: ['Card'], previews: undefined, slots: undefined },
    ]);
    expect(receipts.unmodeledFrameworks).toEqual({ 'android-views': 1 });
  });

  it('gives each middleware entry its file, line, type, name, and framework', async () => {
    const files = [write('app/Module.kt', 'package app\nimport io.ktor.server.application.*\nfun Application.module() {\n  install(CallLogging)\n  install(CORS)\n}\n')];
    expect(await extractMiddleware(files, root)).toEqual([
      { type: 'logging', framework: 'ktor', file: 'app/Module.kt', line: 4, name: 'CallLogging' },
      { type: 'cors', framework: 'ktor', file: 'app/Module.kt', line: 5, name: 'CORS' },
    ]);
  });
});
