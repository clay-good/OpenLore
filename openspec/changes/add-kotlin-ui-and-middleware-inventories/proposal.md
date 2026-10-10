# List Compose UI components and Kotlin server middleware

> Status: PROPOSED (2026-10-10, issue #546). Part of `KOTLIN-TOTAL-SUPPORT-2026-10.md`.
> Deterministic, no LLM, no new dependency.

## What you get

`get_ui_component_inventory` lists Jetpack Compose components, and `get_middleware_inventory`
lists the plugins, filters, and interceptors of a Kotlin server.

## What is missing today

Both inventories are JavaScript-family only (`ui-component-extractor.ts:291`,
`middleware-extractor.ts:281`). A Kotlin file gets `[]` with no disclosure. Compose is the standard
UI toolkit for Android and Kotlin Multiplatform, and every Ktor or Spring service has middleware.

## What changes

**UI components** (gated on an `androidx.compose` or `org.jetbrains.compose` import)

- A function annotated `@Composable` is a component, framework `compose`.
- Props are its parameters: name, type, and whether a default exists. A trailing
  `content: @Composable () -> Unit` parameter is marked as a slot.
- A `@Preview` function is recorded as a preview of the components it calls, not as a component.
- Child components are the `@Composable` functions it calls, taken from call edges.
- The component record's `framework` union gains `compose`.

**Middleware** (import-gated, framework named per entry)

| Framework | Gate | Entry |
|---|---|---|
| Ktor | `io.ktor.server` | `install(Plugin) { … }`; type classified from the plugin name (`Authentication` → auth, `CORS` → cors, `RateLimit` → rate-limit, `CallLogging` → logging, `ContentNegotiation` → body-parsing, `StatusPages` → error-handling, others → custom); `intercept(...)` and `createApplicationPlugin(...)` → custom |
| Spring | `org.springframework` | a class that implements `HandlerInterceptor`, `Filter`, `OncePerRequestFilter`, or `WebFilter`; a `SecurityFilterChain` `@Bean`; `addInterceptors` registrations; `@ControllerAdvice` → error-handling |
| JAX-RS | `javax.ws.rs` or `jakarta.ws.rs` | a class with `@Provider` that implements `ContainerRequestFilter` or `ContainerResponseFilter` |

- Each entry records its file, line, type, name, and framework, in the existing record shape.
- Order of `install` calls within one function is kept, because Ktor applies plugins in order.

**Disclosure.** A Kotlin file that imports a UI or server framework that is not modeled (Android
Views with XML layouts, http4k filters, Javalin handlers) is counted in an unmodeled-framework
receipt on the inventory.

## Not in scope

- Android XML layouts and View classes; Compose navigation graphs; Compose state analysis.
- Java middleware. The Spring and JAX-RS gates are JVM-wide, so Java can adopt them later.

## Impact

- `ui-component-extractor.ts`, `middleware-extractor.ts`, their inventory types.
- Specs: `analyzer`, 1 ADDED requirement.
- Risk: low; additive and gated.
