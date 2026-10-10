# Parse Kotlin imports and exports for the file dependency graph

> Status: PROPOSED (2026-10-10, issue #546). Part of `KOTLIN-TOTAL-SUPPORT-2026-10.md`. This is the
> file the issue names (`import-parser`). Deterministic, no LLM, no new dependency.

## What you get

A Kotlin file has real import edges and a real export list. The dependency graph, architecture
checks, spec links, `mapping.json`, the verifier, and the manifest stop treating Kotlin as a
language with no modules.

## What is missing today

- `importParserFileType` has no Kotlin case (`import-parser.ts:1216-1226`). A `.kt` file returns
  empty imports and exports and the parse error `Unsupported file type: .kt`.
- `computeFileImportEdges` is gated on `.java` (`dependency-graph.ts:183-197`). On the reference
  fixture every Kotlin edge is call-derived (`isCallEdge: true`, `importedNames: []`), and
  `Main.kt`, which imports four packages, has no edge to two of them.
- `resolveJavaImport` lists `src/main/kotlin` as a source root but probes only `<FQN>.java`
  (`import-parser.ts:1087-1103`), so a Java file that imports a Kotlin class never resolves.
- `extractsExports` is false for Kotlin, so consumers report `language-not-extracted`
  (`spec-link-service.ts:225`) or silently see nothing (`verification-engine.ts:645-649`,
  `mapping-generator.ts:66`, `architecture/check.ts:518`, `reachability.ts:164-171`).

## What changes

**Imports.** `package`, plain, aliased, and wildcard imports are parsed from the header of the
file. Default-import packages and JDK or Kotlin standard-library prefixes are marked built-in.

**Resolution is by declared package, not by directory.** Kotlin does not require the directory to
match the package, and one file can declare many types. So an import resolves through a
package index built from every Kotlin and Java file's `package` line and top-level declarations:

| Import | Resolves to |
|---|---|
| `import a.b.C` | the file that declares type `C` in package `a.b` |
| `import a.b.f` | the file that declares top-level function or property `f` in `a.b` |
| `import a.b.C.Inner`, `import a.b.Obj.member` | the file that declares `C` / `Obj` |
| `import a.b.*` | every file of package `a.b` that declares a name the importing file uses; if use cannot be decided, no edge and a counted `wildcard-unresolved` receipt |
| `import a.b.C as D` | as `import a.b.C`; the alias is the imported name |
| a name declared in two files of one package | no edge; counted as ambiguous |

Java and Kotlin share one index, in both directions.

**Exports.** A Kotlin file exports its top-level declarations and the members of exported classes
whose visibility is `public` (the default) or `protected`. `internal` declarations are exported
with the tag `internal`, because they are visible to the whole module but not to consumers of it.
`private` declarations are not exported. Each export records its kind (function, extension
function, property, class kind, object, type alias) and, for `@JvmName` or `@file:JvmName`, the
JVM-facing name as an alias.

**Same-package edges** keep coming from call edges (`SAME_PACKAGE_IMPLICIT_LANGS`). They are
de-duplicated against import edges as today.

**Disclosure.** `extractsExports` is true for Kotlin. A Kotlin file no longer carries the
`Unsupported file type` parse error.

## Not in scope

- Gradle module boundaries (`internal` across modules): see `add-kotlin-project-identity`.
- Dependency edges to library artifacts.

## Impact

- `import-parser.ts` (Kotlin parser, shared JVM package index), `dependency-graph.ts`,
  `mcp-watcher.ts` (incremental update), `java-method-scanner.ts` is untouched.
- Specs: `analyzer`, 2 ADDED requirements.
- Risk: the dependency graph of a Kotlin repository gains many edges; cluster and domain output
  will move. The PR shows the before/after edge counts and domain list for a real repository.
