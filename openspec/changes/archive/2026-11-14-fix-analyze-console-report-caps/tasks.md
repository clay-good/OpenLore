# Tasks — bound analyze's console reports

## Implementation
- [x] `src/utils/capped-list.ts`: `joinCapped` / `omittedDisclosure` + the four named caps
- [x] Cap the `⚠ Cycle:` chain AND the number of cycle lines (extracted `renderCycleLine`)
- [x] Cap the clone-group member list (extracted `renderCloneGroupLine`)
- [x] Cap the `Domains detected` and `Workspace shards (detected)` inventory lines
- [x] `src/core/analyzer/grammar-entry.ts`: import grammars by resolved entry file (DEP0151)
- [x] Route all 34 grammar import sites through `importGrammar`
- [x] `src/core/analyzer/yaml-diagnostics.ts`: `YAML_QUIET` at every non-contract `yaml` parse site
- [x] Re-derive and report the stringified-collection-key fact on `logger.debug` (Helm path)
- [x] `Logger.isDebugEnabled()` so the diagnostic walk is skipped when nobody will read it

## Verification
- [x] 1,347-symbol cycle renders < 400 chars with `… and 1339 more symbols`
- [x] 100,000-symbol cycle renders bounded, in bounded time
- [x] ANSI / bidi-override symbol names cannot reach the terminal raw
- [x] 182-member clone group renders < 600 chars with `… and 176 more members`
- [x] The resolved grammar specifier is an explicit `.js` file path (mechanism pinned)
- [x] A grammar is never imported by bare `tree-sitter-<lang>` specifier in production code
- [x] The provoking YAML emits nothing on the warning channel with `YAML_QUIET` — and DOES
      without it (the fix is load-bearing)
- [x] `--verbose` still reports the stringified key, with its file path
- [x] Real-repo before/after on grpc-go, grpc-python and kustomize

## Spec
- [x] `cli` delta: ADD ConsoleReportsAreBoundedAndDisclosed
