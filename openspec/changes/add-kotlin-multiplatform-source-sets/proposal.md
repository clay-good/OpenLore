# Understand Kotlin Multiplatform source sets and `expect` / `actual`

> Status: PROPOSED (2026-10-10, issue #546). Part of `KOTLIN-TOTAL-SUPPORT-2026-10.md`.
> Deterministic, no LLM, no new dependency.

## What you get

In a Kotlin Multiplatform project, a call to a common declaration reaches every platform
implementation, and platform code is not reported as dead or as a duplicate.

## What is wrong today

Observed on the reference fixture with `expect fun now(): Long` in `commonMain` and
`actual fun now()` in `jvmMain`:

- `stamp()` in common code binds to the `expect` declaration only. The `actual` function has no
  caller, so it is an entry point and a dead-code candidate.
- Both declarations share one package and one name. Any call from another file sees two
  candidates, and unique-binding resolution refuses, so the call becomes unresolved.
- Source sets are not known: `iosMain` and `jvmMain` are just directories, and the two `now`
  functions can be reported as clones.

## What changes

**Source sets.** A file under `src/<set>/kotlin/` (or `src/<set>/java/`) belongs to source set
`<set>`. The set name is recorded on the file and on its nodes. The platform is derived from the
set name for the standard Kotlin Multiplatform names (`common`, `jvm`, `android`, `ios…`, `js`,
`wasm…`, `native`, `linux…`, `macos…`, `mingw…`, `apple`, …) with the `Main` or `Test` suffix.
Custom set names are recorded as written with platform `unknown`. Dependencies between sets
(`dependsOn`) are not read from Gradle; the standard hierarchy is not assumed beyond
"`common*` is visible to every set".

**`expect` / `actual` linking.**

- An `expect` declaration is the binding target for its name in its package. `actual` declarations
  with the same package, name, and owner do not compete with it in unique-binding resolution.
- Each `actual` is joined to its `expect` by an `actualizes` relation, stored like an override
  relation.
- Reachability flows across it: if the `expect` is reachable, every `actual` is reachable. A test
  that reaches the `expect` reaches the `actual`s for `select_tests`.
- Impact flows back: a change to an `actual` reports the callers of its `expect`.
- An `actual` with no `expect` in the repository, and an `expect` with no `actual`, are counted in
  a receipt; they are not errors, because a platform set can be absent from the checkout.
- `actual typealias X = Y` joins `X` to the `expect class X` and to `Y` when `Y` is in the
  repository.

**Conclusions that must respect the link**

- `find_dead_code`: an `actual` is never a candidate while its `expect` is live.
- `find_clones` and the duplicate report: an `expect` / `actual` pair and sibling `actual`s are
  marked as platform variants and are not reported as clones.
- `certify_public_surface`: the surface lists the `expect` declaration once.

## Not in scope

- Platform-specific call resolution ("which `actual` runs on iOS").
- Gradle `dependsOn` graphs and custom hierarchy templates.

## Impact

- `call-graph.ts` / Kotlin extractor (modifier facts), `import-resolver-bridge.ts` (binding rule),
  `reachability.ts`, `duplicate-detector.ts`, `domain-naming.ts` (source-set directory names as
  noise), `call-graph-types.ts` (relation kind).
- Specs: `analyzer`, 1 ADDED requirement.
- Risk: a new relation kind in the edge store. It reuses the override-relation storage so no schema
  migration is needed; the PR confirms this.
