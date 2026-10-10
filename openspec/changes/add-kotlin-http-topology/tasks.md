# Tasks: Kotlin HTTP topology

## Implementation
- [ ] Kotlin route extractor over the parse tree with one import gate per framework
- [ ] Spring annotations: class prefix, verb mappings, array `value`/`path`, `method = [...]`
- [ ] Spring functional router and `coRouter`, with `nest` prefixes
- [ ] JAX-RS with the existing `javax|jakarta.ws.rs` gate
- [ ] Ktor routing DSL: verb calls, nested `route` prefixes, transparent wrappers, `Route`
      extension functions
- [ ] `const val` path resolution (same file or unique import); `path: unresolved` otherwise
- [ ] Client extractors: Ktor client, OkHttp, Retrofit, Spring, JDK `HttpRequest`
- [ ] String-template URLs to normalized path parameters
- [ ] `unmodeled-http-framework` receipt
- [ ] Add Kotlin to the route and client language sets; watcher HTTP role refresh for `.kt`

## Conformance
- [ ] One fixture per framework row and per client row
- [ ] Negative fixture: a function named `get` outside `routing { }` or without the import is not
      a route
- [ ] Negative fixture: Retrofit `@GET` is a client, never a route
- [ ] Cross-service fixture: a Ktor client call matches a Spring Kotlin route
- [ ] `language-support.test.ts`: Kotlin `crossServiceHttp` fixture yields an edge

## Verification
- [ ] Reference corpus: five routes found (`GET /api/users/{id}`, `POST /api/users/`,
      `POST /api/users/new`, `GET /v1/health`, `POST /v1/orders`) and one client call
- [ ] Two real repositories (one Spring, one Ktor): route list reviewed by hand in the PR
- [ ] Full suite green

## Spec
- [ ] `analyzer` delta: ADD KotlinHttpRoutesAreExtractedBehindImportGates,
      KotlinHttpClientCallsAreExtractedBehindImportGates
