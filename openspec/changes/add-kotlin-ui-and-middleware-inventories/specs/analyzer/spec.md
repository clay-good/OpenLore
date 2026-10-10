# analyzer spec delta

## ADDED Requirements

### Requirement: KotlinUiComponentsAndMiddlewareAreInventoried

The analyzer SHALL list a Kotlin function annotated `@Composable`, in a file that imports a Compose
package, as a UI component with framework `compose`, its parameters as props with type and default
presence, a trailing composable-lambda parameter as a slot, and the composable functions it calls as
children. A `@Preview` function SHALL be recorded as a preview and SHALL NOT be listed as a
component. The analyzer SHALL list Kotlin server middleware behind import gates: Ktor plugin
installations, interceptors, and plugin definitions; Spring interceptors, servlet and reactive
filters, security filter chains, and controller advice; and JAX-RS provider filters. Each middleware
entry SHALL carry its file, line, type, name, and framework, and Ktor installations in one function
SHALL keep their source order. A Kotlin file that imports a UI or server framework that is not
modeled SHALL be counted in a disclosed receipt.

#### Scenario: A composable function is a component

- **GIVEN** a file that imports `androidx.compose.runtime.Composable` and declares
  `@Composable fun UserCard(user: User, compact: Boolean = false, content: @Composable () -> Unit)`
- **WHEN** UI components are extracted
- **THEN** `UserCard` is a `compose` component with props `user` and `compact` (default present)
  and a slot `content`

#### Scenario: A preview is not a component

- **GIVEN** `@Preview @Composable fun UserCardPreview() { UserCard(sample) { } }`
- **WHEN** UI components are extracted
- **THEN** `UserCardPreview` is recorded as a preview of `UserCard` and not as a component

#### Scenario: Ktor plugins are middleware in order

- **GIVEN** a file that imports `io.ktor.server.application` and calls `install(CORS)`, then
  `install(Authentication) { … }`, in `fun Application.module()`
- **WHEN** middleware is extracted
- **THEN** two entries exist, `CORS` (type cors) before `Authentication` (type auth), framework
  `ktor`

#### Scenario: A Spring interceptor is middleware

- **GIVEN** a Kotlin class that implements `HandlerInterceptor` in a file that imports
  `org.springframework.web.servlet.HandlerInterceptor`
- **WHEN** middleware is extracted
- **THEN** one entry with framework `spring` names that class

#### Scenario: A same-named function without the gate is ignored

- **GIVEN** a Kotlin file that calls a project function `install(x)` and imports no Ktor package
- **WHEN** middleware is extracted
- **THEN** no entry is produced
