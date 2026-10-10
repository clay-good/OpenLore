# analyzer spec delta

## ADDED Requirements

### Requirement: KotlinPackageBindingIsReceiverAwareAndDeclarationExact

The analyzer SHALL build the Kotlin package symbol index from declarations at package level only
(functions, extension functions with their receiver type, properties, classes, objects, enum
classes, and type aliases), and SHALL NOT index a member of a class, object, or interface as a
package-level symbol. A package-level function SHALL bind only a call that has no receiver. An
extension function SHALL bind a receiver call only when its name is in scope through an explicit
import, a wildcard import, or the caller's own package, and the binding is unique. Import handling
SHALL cover plain, aliased, wildcard, top-level function, top-level property, and nested-type
imports, with the precedence explicit import, then wildcard import, then same package, then default
imports. Names supplied by the Kotlin default-import packages SHALL resolve as external unless the
file imports a project symbol of that name or shares its package. A name that does not bind
uniquely SHALL fall through to the existing resolution ladder; this path SHALL NOT emit a guessed
edge.

#### Scenario: A member-shaped call does not bind to a same-package member of the same name

- **GIVEN** a Kotlin package that declares `class UserController { fun get(id: String) }` and, in
  another file, `suspend fun fetch(client: HttpClient) = client.get("http://orders")`
- **WHEN** the call graph is built
- **THEN** no edge joins `fetch` to `UserController.get`
- **AND** the call is recorded as external or left to receiver-type resolution

#### Scenario: A self-field call does not bind to the enclosing method

- **GIVEN** `class UserController(private val service: UserService) { fun create(n: String) = this.service.create(n) }`
- **WHEN** the call graph is built
- **THEN** no edge joins `UserController.create` to itself for that call site

#### Scenario: An imported extension function binds at import confidence

- **GIVEN** `fun String.slugify(): String` declared in package `com.acme.util` and two files that
  `import com.acme.util.slugify` and call `name.slugify()`
- **WHEN** the call graph is built
- **THEN** both calls bind to that declaration with `import` confidence

#### Scenario: A wildcard import binds a unique package symbol

- **GIVEN** a file with `import com.acme.repo.*` that calls `openStore()`, and exactly one
  package-level `fun openStore()` in `com.acme.repo`
- **WHEN** the call graph is built
- **THEN** the call binds to that function with `import` confidence
- **AND** an explicit import of another `openStore` in the same file takes precedence

#### Scenario: A modified or generic top-level function is indexed

- **GIVEN** `private suspend fun <T> load(id: String): T` at package level
- **WHEN** the package index is built
- **THEN** `load` is indexed as a package-level function
- **AND** `enum class Color` is indexed under the name `Color`

#### Scenario: A default-import name stays external

- **GIVEN** a call to `listOf(1, 2)` or `require(x > 0)` in a file that imports no project symbol
  of that name
- **WHEN** the call graph is built
- **THEN** the call resolves as external even when another package in the repository declares a
  function with the same simple name
