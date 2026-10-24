# analyzer spec delta

## ADDED Requirements

### Requirement: KotlinDeclarationsCarryExactSignaturesAndKdoc

The analyzer SHALL derive the signature of a Kotlin declaration from the parse tree. The signature
SHALL run from the first annotation or modifier to the end of the declared return type, or to the
end of the parameter list when no return type is written, and SHALL NOT contain any part of a block
body or an expression body. The analyzer SHALL record parameters (name, type, default presence,
`vararg`), return type, type parameters, visibility with `public` as the default, and declaration
modifiers. The signature inventory SHALL include functions, constructors, properties, classes of
every kind, and type aliases. A KDoc block that immediately precedes a declaration, before or after
its annotations, SHALL be recorded as the docstring with its summary and block tags; a line comment
SHALL NOT be recorded as a docstring. Calls to scope functions and other names in a fixed
standard-library list SHALL NOT be recorded as external leaves unless a project function of that
name is in scope.

#### Scenario: An annotation argument with a brace does not cut the signature

- **GIVEN** `@GetMapping("/{id}") fun get(id: String): String = service.find(id)`
- **WHEN** the function node is built
- **THEN** the signature contains `fun get(id: String): String`
- **AND** it does not contain `service.find`

#### Scenario: An expression body is not part of the signature

- **GIVEN** `fun risky(): Int = runCatching { repo.size() }.getOrElse { 0 }`
- **WHEN** the function node is built
- **THEN** the signature is `fun risky(): Int`

#### Scenario: Modifiers and type parameters are recorded

- **GIVEN** `protected inline fun <reified T> load(id: String, vararg tags: String): T?`
- **WHEN** signatures are extracted
- **THEN** the entry has visibility `protected`, modifier `inline`, type parameter `T`, two
  parameters with the second marked `vararg`, and return type `T?`

#### Scenario: KDoc is the docstring

- **GIVEN** a function preceded by `/** Computes a thing. @param x the input */` and then `@JvmStatic`
- **WHEN** the function node is built
- **THEN** the docstring summary is `Computes a thing.` and the `@param x` tag is kept

#### Scenario: A scope function is not an external leaf

- **GIVEN** `x.let { helper(it) }` in a file that declares or imports no function named `let`
- **WHEN** the call graph is built
- **THEN** no external node named `let` is created
- **AND** the call to `helper` is attributed to the enclosing function
