# analyzer spec delta

## ADDED Requirements

### Requirement: KotlinHttpRoutesAreExtractedBehindImportGates

The analyzer SHALL extract HTTP route definitions from Kotlin source for Spring MVC and WebFlux
annotations, the Spring functional router, JAX-RS annotations, and the Ktor routing DSL. Each
framework SHALL be recognized only in a file that imports that framework's package. A Spring
mapping whose `value` or `path` is an array SHALL produce one route per element, joined to the class
prefix. A Ktor verb call SHALL be a route only inside a `routing` block or a `Route` extension
function, with the paths of enclosing `route` calls as its prefix. The handler SHALL be the
annotated function, the referenced function, or, for an inline lambda, the enclosing function. A
path SHALL be taken from a string literal or from a constant that resolves to exactly one string
literal; any other path expression SHALL produce a route marked unresolved that is never matched to
a client call. A Kotlin file that imports a known HTTP framework that is not modeled SHALL be
counted in a disclosed receipt by framework name. Kotlin SHALL be added to the route language set
only together with a conformance fixture for each framework.

#### Scenario: A Spring controller written in Kotlin yields routes

- **GIVEN** a Kotlin class with `@RestController`, `@RequestMapping("/api/users")`, a function with
  `@GetMapping("/{id}")`, and a function with `@PostMapping(value = ["/", "/new"])`
- **WHEN** routes are extracted
- **THEN** three routes exist: `GET /api/users/{id}`, `POST /api/users/`, `POST /api/users/new`
- **AND** each names its annotated function as the handler and `spring` as the framework

#### Scenario: Nested Ktor routes carry their prefix

- **GIVEN** a file that imports `io.ktor.server.routing` and contains
  `routing { route("/v1") { get("/health") { } post("/orders") { } } }` inside `fun Application.module()`
- **WHEN** routes are extracted
- **THEN** the routes are `GET /v1/health` and `POST /v1/orders` with handler `module`

#### Scenario: A same-named function without the gate is not a route

- **GIVEN** a Kotlin file that calls `cache.get("/health")` and does not import a Ktor routing
  package
- **WHEN** routes are extracted
- **THEN** no route is produced

#### Scenario: A non-literal path is listed but not matched

- **GIVEN** `@GetMapping(buildPath())`
- **WHEN** routes are extracted
- **THEN** one route with an unresolved path is listed
- **AND** no client call is matched to it

#### Scenario: An unmodeled framework is disclosed

- **GIVEN** a Kotlin file that imports `io.micronaut.http.annotation`
- **WHEN** routes are extracted
- **THEN** no route is guessed and the unmodeled-framework receipt names Micronaut

### Requirement: KotlinHttpClientCallsAreExtractedBehindImportGates

The analyzer SHALL extract outbound HTTP calls from Kotlin source for the Ktor client, OkHttp,
Retrofit interface annotations, Spring `RestTemplate`, `WebClient`, and `RestClient`, and the JDK
`HttpRequest` builder, each only in a file that imports that library's package. The URL SHALL be
taken from a string literal or a string template; template expressions SHALL be normalized to path
parameters. A Retrofit annotation SHALL be recorded as a client call matched by path, and SHALL
never be recorded as a route. A call whose URL is not a literal or template SHALL be omitted, not
guessed. Kotlin SHALL be added to the client language set only together with a conformance fixture
for each library.

#### Scenario: A Ktor client call is extracted

- **GIVEN** a file that imports `io.ktor.client.request` and contains
  `client.get("http://orders/v1/orders")`
- **WHEN** HTTP calls are extracted
- **THEN** one call with method `GET` and path `/v1/orders` is recorded

#### Scenario: A string template becomes a path parameter

- **GIVEN** `client.get("$base/users/$id")`
- **WHEN** HTTP calls are extracted
- **THEN** the normalized path is `/users/{param}`

#### Scenario: A Retrofit declaration is a client, not a route

- **GIVEN** an interface that imports `retrofit2.http` and declares `@GET("users/{id}") suspend fun user(@Path("id") id: String): User`
- **WHEN** HTTP calls and routes are extracted
- **THEN** one client call for `GET /users/{id}` exists and no route exists

#### Scenario: A Kotlin client reaches a Kotlin route

- **GIVEN** a Ktor client call to `/api/users/42` and a Spring Kotlin route `GET /api/users/{id}`
- **WHEN** cross-service edges are built
- **THEN** an `http_endpoint` edge joins the calling function to the route handler
