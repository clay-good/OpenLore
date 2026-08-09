# Tasks — widen import resolution

## Implementation
- [x] Stage 1 (Go): capture the per-file `package` clause during extraction; wire `parseGoImports`
      + package-sibling resolution into the live import map; `pkg.Func` and bare same-package calls
      bind at `import` confidence, unique binding only (fall through otherwise)
- [x] Stage 2 (Java/Kotlin/C#): per-file FQN→file map from `import`/`using` +
      `package`/`namespace` declarations; qualified and imported-name calls bind at `import`
- [x] Stage 3 (PHP): `use` + `namespace` → same FQN→file map shape
- [x] Ruby: NOT wired — record the deferral rationale (no static name imports) in
      `import-resolver-bridge.ts` alongside the existing honesty note at `:44`
- [x] `IMPORT_RESOLUTION_LANGUAGES` grows exactly with each wired stage (registry `imports` column
      derives from it — no over-claim)

## Conformance
- [x] Per stage: the language's cross-file fixture flips its asserted provenance from `name_only`
      to `import` (update the precision-difference scenario from
      `add-language-capability-conformance`)
- [x] Per stage: a collision fixture (two same-named defs, one importable) binds to the imported
      one; a name the map cannot bind falls through to the existing ladder unchanged
- [x] Coverage guard: a language added to `IMPORT_RESOLUTION_LANGUAGES` without a cross-file
      import fixture fails the suite

## Verification
- [x] Per stage: before/after structural diff on a real corpus — edges moved `name_only`→`import`
      counted; no resolved edge lost except demonstrably-wrong bindings; report in the PR
- [x] Full suite green

## Spec
- [x] `analyzer` delta: ADD ImportPreciseResolutionBeyondTsJsPython
