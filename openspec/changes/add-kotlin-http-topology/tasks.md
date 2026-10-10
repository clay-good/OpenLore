# Tasks: Kotlin HTTP topology

## Implementation
- [x] Kotlin route extractor with one import gate per framework. DSL frameworks and client
      chains are read from the parse tree; annotation frameworks from the declaration scanner,
      because the pinned grammar parses an annotation that opens a file outside the class node
- [x] Spring annotations: class prefix, verb mappings, array `value`/`path`, `method = [...]`
- [x] Spring functional router and `coRouter`, with `nest` prefixes
- [x] JAX-RS with the existing `javax|jakarta.ws.rs` gate
- [x] Ktor routing DSL: verb calls, nested `route` prefixes, transparent wrappers, `Route`
      extension functions
- [x] `const val` path resolution in the same file; `<unresolved>` otherwise (a constant from
      another file is unresolved, never guessed)
- [x] Client extractors: Ktor client, OkHttp, Retrofit, Spring, JDK `HttpRequest`
- [x] String-template URLs to normalized path parameters
- [x] `unmodeled-http-framework` receipt
- [x] Add Kotlin to the route and client language sets; watcher HTTP role refresh for `.kt`

## Conformance
- [x] One fixture per framework row and per client row
- [x] Negative fixture: a function named `get` outside `routing { }` or without the import is not
      a route
- [x] Negative fixture: Retrofit `@GET` is a client, never a route
- [x] Cross-service fixture: a Ktor client call matches a Spring Kotlin route
- [x] `language-support.test.ts`: Kotlin `crossServiceHttp` fixture yields an edge

## Verification
- [x] Reference corpus: five routes found (`GET /api/users/{id}`, `POST /api/users`,
      `GET /health`, `POST /users`, `GET /users/{id}`) and two client calls
- [ ] Two real repositories (one Spring, one Ktor): route list reviewed by hand in the PR
- [ ] Full suite green (run once for the whole change set, in the pull request)

## Spec
- [x] `analyzer` delta: ADD KotlinHttpRoutesAreExtractedBehindImportGates,
      KotlinHttpClientCallsAreExtractedBehindImportGates
