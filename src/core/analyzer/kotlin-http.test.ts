/**
 * Kotlin HTTP routes and client calls behind import gates
 * (change: add-kotlin-http-topology, issue #546).
 */
import { describe, expect, it } from 'vitest';
import { CallGraphBuilder } from './call-graph.js';
import { HTTP_CLIENT_LANGUAGES, HTTP_ROUTE_LANGUAGES } from './http-capability.js';
import { buildHttpEdges } from './http-route-parser.js';
import { UNRESOLVED_ROUTE_PATH, extractKotlinHttp } from './kotlin-http.js';
import { languageSupport } from './language-support.js';

const routes = async (source: string) => (await extractKotlinHttp('/r/A.kt', source)).routes.map(r => `${r.method} ${r.path} -> ${r.handlerName} [${r.framework}]`);
const calls = async (source: string) => (await extractKotlinHttp('/r/A.kt', source)).calls.map(c => `${c.method} ${c.url} [${c.client}]`);

describe('Kotlin routes', () => {
  it('reads Spring MVC annotations: class prefix, verb mappings, arrays, and `method = [...]`', async () => {
    expect(await routes([
      'package a',
      'import org.springframework.web.bind.annotation.*',
      'const val BASE = "/api/users"',
      '@RestController',
      '@RequestMapping(BASE)',
      'class UserController {',
      '  @GetMapping("/{id}")',
      '  fun get(@PathVariable id: String): User? = null',
      '  @PostMapping',
      '  fun create(@RequestBody body: CreateUser): User = TODO()',
      '  @RequestMapping(value = ["/a", "/b"], method = [RequestMethod.PUT, RequestMethod.PATCH])',
      '  fun multi() {}',
      '  @DeleteMapping(path = ["/{id}"])',
      '  fun remove(id: String) {}',
      '  @RequestMapping("/any")',
      '  fun noMethod() {}',
      '  fun plain() {}',
      '}',
      'class NotAController {',
      '  @GetMapping("/ignored")',
      '  fun ignored() {}',
      '}',
    ].join('\n'))).toEqual([
      'GET /api/users/{id} -> get [spring]',
      'POST /api/users -> create [spring]',
      'PUT /api/users/a -> multi [spring]', 'PATCH /api/users/a -> multi [spring]',
      'PUT /api/users/b -> multi [spring]', 'PATCH /api/users/b -> multi [spring]',
      'DELETE /api/users/{id} -> remove [spring]',
    ]);
  });

  it('takes request and response types from the handler signature', async () => {
    const facts = await extractKotlinHttp('/r/A.kt', 'import org.springframework.web.bind.annotation.*\n@RestController\nclass C {\n  @PostMapping("/users")\n  fun create(@RequestBody body: CreateUser): User = TODO()\n}\n');
    expect(facts.routes[0]).toMatchObject({ requestBodyType: 'CreateUser', responseType: 'User', contractSource: 'annotation' });
  });

  it('reads the Spring functional router with nested prefixes', async () => {
    expect(await routes([
      'import org.springframework.web.reactive.function.server.coRouter',
      'class Handler',
      'fun routes(handler: Handler) = coRouter {',
      '  GET("/health") { ok() }',
      '  "/v1".nest {',
      '    POST("/orders", handler::create)',
      '    "/admin".nest {',
      '      DELETE("/orders/{id}", handler::remove)',
      '    }',
      '  }',
      '}',
    ].join('\n'))).toEqual([
      'GET /health -> routes [spring-router]',
      'POST /v1/orders -> create [spring-router]',
      'DELETE /v1/admin/orders/{id} -> remove [spring-router]',
    ]);
  });

  it('reads JAX-RS annotations', async () => {
    expect(await routes('import jakarta.ws.rs.*\n@Path("/items")\nclass ItemResource {\n  @GET\n  fun list() = 1\n  @POST\n  @Path("/{id}/archive")\n  fun archive() = 2\n  fun helper() = 3\n}\n'))
      .toEqual(['GET /items -> list [jax-rs]', 'POST /items/{id}/archive -> archive [jax-rs]']);
  });

  it('reads the Ktor routing DSL: verbs, nested `route`, transparent wrappers, and Route extensions', async () => {
    expect(await routes([
      'import io.ktor.server.routing.*',
      'const val HEALTH = "/health"',
      'fun Application.module() {',
      '  routing {',
      '    get(HEALTH) { call.respondText("ok") }',
      '    route("/users") {',
      '      post { }',
      '      authenticate("jwt") {',
      '        get("/{id}") { }',
      '      }',
      '    }',
      '    get(dynamicPath()) { }',
      '    userRoutes()',
      '  }',
      '}',
      'fun Route.userRoutes() {',
      '  delete("/users/{id}") { }',
      '}',
      'fun unrelated() {',
      '  get("/not-a-route") { }',
      '}',
    ].join('\n'))).toEqual([
      'GET /health -> module [ktor]',
      'POST /users -> module [ktor]',
      'GET /users/{id} -> module [ktor]',
      `GET ${UNRESOLVED_ROUTE_PATH} -> module [ktor]`,
      'DELETE /users/{id} -> userRoutes [ktor]',
    ]);
  });

  it('never matches an unresolved route path to a client call', async () => {
    const server = await extractKotlinHttp('/r/S.kt', 'import io.ktor.server.routing.*\nfun Application.m() {\n  routing {\n    get(dynamicPath()) { }\n  }\n}\n');
    const client = await extractKotlinHttp('/r/C.kt', `import io.ktor.client.*\nsuspend fun f(c: HttpClient) = c.get("http://h/${UNRESOLVED_ROUTE_PATH}")\n`);
    expect(server.routes[0].path).toBe(UNRESOLVED_ROUTE_PATH);
    expect(buildHttpEdges(client.calls, server.routes)).toEqual([]);
  });

  it('recognizes nothing without the framework import', async () => {
    expect(await routes('@RestController\nclass C {\n  @GetMapping("/x")\n  fun get() = 1\n}\n')).toEqual([]);
    expect(await routes('fun Application.m() {\n  routing {\n    get("/x") { }\n  }\n}\n')).toEqual([]);
    expect(await routes('import com.acme.dsl.get\nfun f() {\n  get("/x") { }\n}\n')).toEqual([]);
  });
});

describe('Kotlin HTTP clients', () => {
  it('reads Ktor client calls, with template expressions as path parameters', async () => {
    expect(await calls([
      'import io.ktor.client.*',
      'suspend fun f(client: HttpClient, id: String, o: Order) {',
      '  client.get("http://orders.internal/api/orders/$id")',
      '  client.post("/api/orders/${o.id}/pay") { }',
      '  client.request("/api/status") { method = HttpMethod.Head }',
      '  settings.get("timeout")',
      '}',
    ].join('\n'))).toEqual([
      'GET http://orders.internal/api/orders/${p} [ktor-client]',
      'POST /api/orders/${p}/pay [ktor-client]',
      'HEAD /api/status [ktor-client]',
    ]);
  });

  it('reads OkHttp request builders', async () => {
    expect(await calls('import okhttp3.Request\nfun f(body: RequestBody) {\n  val a = Request.Builder().url("https://h/api/a").build()\n  val b = Request.Builder().url("https://h/api/b").post(body).build()\n  val c = Request.Builder().method("PATCH", body).url("https://h/api/c").build()\n}\n'))
      .toEqual(['GET https://h/api/a [okhttp]', 'POST https://h/api/b [okhttp]', 'PATCH https://h/api/c [okhttp]']);
  });

  it('reads Retrofit interface annotations as client calls, never as routes', async () => {
    const source = 'import retrofit2.http.*\ninterface Api {\n  @GET("users/{id}")\n  suspend fun user(@Path("id") id: String): User\n  @HTTP(method = "DELETE", path = "users/{id}", hasBody = true)\n  suspend fun remove(@Path("id") id: String)\n}\n';
    expect(await calls(source)).toEqual(['GET users/{id} [retrofit]', 'DELETE users/{id} [retrofit]']);
    expect(await routes(source)).toEqual([]);
  });

  it('reads Spring RestTemplate, WebClient, and RestClient calls', async () => {
    expect(await calls([
      'import org.springframework.web.client.RestTemplate',
      'import org.springframework.web.reactive.function.client.WebClient',
      'fun f(rest: RestTemplate, web: WebClient, id: String) {',
      '  rest.getForObject("http://h/api/a/$id", String::class.java)',
      '  rest.postForEntity("http://h/api/b", null, String::class.java)',
      '  rest.exchange("http://h/api/c", HttpMethod.PUT, null, String::class.java)',
      '  rest.delete("http://h/api/d")',
      '  web.get().uri("/api/e").retrieve()',
      '  web.post().uri("/api/f/{id}", id).retrieve()',
      '}',
    ].join('\n'))).toEqual([
      'GET http://h/api/a/${p} [spring-rest-template]', 'POST http://h/api/b [spring-rest-template]',
      'PUT http://h/api/c [spring-rest-template]', 'DELETE http://h/api/d [spring-rest-template]',
      'GET /api/e [spring-web-client]', 'POST /api/f/{id} [spring-web-client]',
    ]);
  });

  it('reads JDK HttpRequest builders', async () => {
    expect(await calls('import java.net.http.HttpRequest\nimport java.net.URI\nfun f() {\n  val a = HttpRequest.newBuilder(URI.create("https://h/api/a")).build()\n  val b = HttpRequest.newBuilder().uri(URI.create("https://h/api/b")).POST(body()).build()\n  val u = URI.create("https://not-a-request")\n}\n'))
      .toEqual(['GET https://h/api/a [jdk-http-client]', 'POST https://h/api/b [jdk-http-client]']);
  });

  it('omits a call whose URL is not a literal or a template, and recognizes nothing without the import', async () => {
    expect(await calls('import io.ktor.client.*\nsuspend fun f(c: HttpClient, url: String) = c.get(url)\n')).toEqual([]);
    expect(await calls('suspend fun f(c: HttpClient) = c.get("http://h/api/x")\n')).toEqual([]);
  });

  it('counts a known HTTP framework that is not modeled, by name', async () => {
    const facts = await extractKotlinHttp('/r/A.kt', 'import io.micronaut.http.annotation.Get\nimport org.http4k.core.Request\nimport io.ktor.server.resources.*\n@Controller\nclass C\n');
    expect(facts).toEqual({ routes: [], calls: [], unmodeled: ['http4k', 'ktor-resources', 'micronaut'] });
  });
});

describe('Kotlin cross-service topology', () => {
  it('matches a Ktor client call to a Spring Kotlin route and adds an http_endpoint edge', async () => {
    const result = await new CallGraphBuilder().build([
      { path: 'server/UserController.kt', language: 'Kotlin', content: 'package server\nimport org.springframework.web.bind.annotation.*\n@RestController\n@RequestMapping("/api/users")\nclass UserController {\n  @GetMapping("/{id}")\n  fun get(@PathVariable id: String): String = id\n}\n' },
      { path: 'client/UserClient.kt', language: 'Kotlin', content: 'package client\nimport io.ktor.client.*\nclass UserClient(private val http: HttpClient) {\n  suspend fun fetch(id: String) = http.get("http://users.internal/api/users/$id")\n}\n' },
    ]);
    const edge = result.edges.find(e => e.confidence === 'http_endpoint');
    expect(edge).toMatchObject({ callerId: 'client/UserClient.kt::UserClient.fetch', calleeId: 'server/UserController.kt::UserController.get' });
  });

  it('Kotlin backs crossServiceHttp as a route language and a client language', () => {
    expect(HTTP_ROUTE_LANGUAGES.has('Kotlin')).toBe(true);
    expect(HTTP_CLIENT_LANGUAGES.has('Kotlin')).toBe(true);
    expect(languageSupport('Kotlin').capabilities).toContain('crossServiceHttp');
  });
});
