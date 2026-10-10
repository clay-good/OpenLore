# Extract Kotlin HTTP routes and HTTP client calls

> Status: PROPOSED (2026-10-10, issue #546). Part of `KOTLIN-TOTAL-SUPPORT-2026-10.md`.
> Deterministic, no LLM, no new dependency.

## What you get

`get_route_inventory` lists the endpoints of a Kotlin service, cross-service edges connect Kotlin
clients to routes, and route handlers stop appearing as dead code.

## What is missing today

- Route extraction returns `[]` for any file that is not `.java` (`http-route-parser.ts:1025`,
  `:1208`). The reference fixture has a Spring controller and a Ktor module; the inventory is
  `total: 0`.
- The `analyzer` spec already says a "Java/Kotlin file" is classified for JAX-RS. The code does not
  read `.kt`.
- No client extraction exists for Kotlin (`HTTP_CLIENT_LANGUAGES`, `http-capability.ts:14`).
- The Java annotation scanner cannot be reused as is: Kotlin writes array arguments as
  `value = ["/a", "/b"]`, handlers as `fun` or `suspend fun`, and Ktor declares routes as nested
  lambdas, not annotations.

## What changes

Extraction reads the Kotlin parse tree. Each framework is gated on its import, so a same-named
function from another library is never taken for a route.

**Routes**

| Framework | Import gate | Recognized |
|---|---|---|
| Spring MVC / WebFlux | `org.springframework.web.bind.annotation` | `@RestController` / `@Controller`; class `@RequestMapping` prefix; `@GetMapping` … `@PatchMapping`; `@RequestMapping(method = [...])`; `value` / `path` as a string or an array (one route per element) |
| Spring functional | `org.springframework.web.reactive.function.server` or `…servlet.function` | `router { }` / `coRouter { }` with `GET("/x", h)`, nested `"/prefix".nest { }` |
| JAX-RS (Quarkus, Jersey) | `javax.ws.rs` or `jakarta.ws.rs` | `@Path` on class and method with a verb annotation |
| Ktor | `io.ktor.server.routing` or `io.ktor.routing` | `get`/`post`/`put`/`delete`/`patch`/`head`/`options` with a literal path inside `routing { }` or a `Route` extension function; nested `route("/p") { }` prefixes; wrappers such as `authenticate { }` are transparent |

- **Handler.** For annotations it is the annotated function. For Ktor and the functional router it
  is the referenced function (`handler::get`) or, for an inline lambda, the enclosing function.
- **Path.** A string literal, or a `const val` that resolves to one literal in the same file or by
  a unique import. Any other expression gives a route with `path: unresolved` that is listed but
  never matched to a client.
- **Request and response types** come from the handler signature where an annotation marks them
  (`@RequestBody`), with `contractSource: annotation`.

**Clients**

| Library | Import gate | Recognized |
|---|---|---|
| Ktor client | `io.ktor.client` | `client.get("u")`, `.post`, `.put`, `.delete`, `.patch`, `.request("u") { method = HttpMethod.X }` |
| OkHttp | `okhttp3` | `Request.Builder().url("u")` with the verb call in the same chain; default `GET` |
| Retrofit | `retrofit2.http` | `@GET("p")` … `@HTTP(method=, path=)` on interface functions; matched by path only |
| Spring | `org.springframework.web.client` or `…reactive.function.client` | `RestTemplate` verb methods, `WebClient` / `RestClient` `.get().uri("u")` chains |
| JDK | `java.net.http` | `HttpRequest.newBuilder(URI.create("u"))` / `.uri(URI.create("u"))` |

- A URL is a string literal or a string template. Template expressions become path parameters, as
  template literals do for TypeScript.

**Disclosure**

- A Kotlin file that imports a known HTTP framework that is not modeled (Micronaut, http4k,
  Javalin, Fuel, Ktor type-safe `Resources`) is counted in an `unmodeled-http-framework` receipt by
  framework name. A quiet route inventory for such a repository says so.
- Kotlin joins `HTTP_ROUTE_LANGUAGES` and `HTTP_CLIENT_LANGUAGES` only with conformance fixtures.

## Not in scope

- Java HTTP clients. The gates above are JVM-wide, so Java can reuse them in a follow-up.
- Base-URL resolution from configuration; gRPC; WebSocket routes.

## Impact

- `http-route-parser.ts`, `http-capability.ts`, `call-graph.ts` (route-handler edges),
  `dependency-graph.ts` (cross edges), `mcp-watcher.ts` (HTTP role refresh), `reachability.ts`
  (handler roots apply to Kotlin).
- Specs: `analyzer`, 2 ADDED requirements.
- Risk: false routes from DSL functions named `get`. The import gate plus the `routing`/`Route`
  scope rule is the control; the PR lists every route found in two real repositories.
