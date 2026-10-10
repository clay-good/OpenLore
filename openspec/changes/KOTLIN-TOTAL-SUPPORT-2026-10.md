# Kotlin support (issue #546), 2026-10-10

> Status: NOT DOING as a program. Scope is reduced to one change.

Issue [#546](https://github.com/clay-good/OpenLore/issues/546) asks for Kotlin (JVM) support and
names the import parser. On `main`, `import-parser.ts` had no Kotlin code: a `.kt` file got an
unsupported-type parse error, no imports, and no exports in the file dependency graph.

## What we do

One change: `add-kotlin-file-dependency-and-exports`. It parses the Kotlin package, imports, and
package-level exports, and resolves imports through the declared package of each Kotlin and Java
file. Issue #546 is closed when that change merges.

## What we do not do

This document first proposed 23 changes under the name "total Kotlin support". That scope was too
broad for the issue. The other 22 changes are marked NOT DOING and are kept only as a record:

- `add-kotlin-callable-node-shapes`
- `add-kotlin-declared-type-receivers`
- `add-kotlin-dynamic-boundary`
- `add-kotlin-entry-point-roots`
- `add-kotlin-env-var-reads`
- `add-kotlin-error-propagation`
- `add-kotlin-http-topology`
- `add-kotlin-java-interop-resolution`
- `add-kotlin-multiplatform-source-sets`
- `add-kotlin-project-identity`
- `add-kotlin-public-surface`
- `add-kotlin-reference-corpus-conformance`
- `add-kotlin-schema-inventory`
- `add-kotlin-style-fingerprint`
- `add-kotlin-test-detection-and-generation`
- `add-kotlin-ui-and-middleware-inventories`
- `fix-kotlin-auxiliary-surface-parity`
- `fix-kotlin-package-binding-soundness`
- `fix-kotlin-signature-and-kdoc-fidelity`
- `fix-kotlin-type-hierarchy-fidelity`
- `harden-kotlin-grammar-currency`
- `widen-kotlin-control-flow-overlay`

A later issue can reopen any one of them on its own evidence. None of them is planned.
