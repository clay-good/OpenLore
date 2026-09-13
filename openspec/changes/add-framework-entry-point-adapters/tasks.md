# Tasks — add-framework-entry-point-adapters

## Implementation
- [x] Adapter module `src/core/analyzer/entry-point-adapters.ts`: deterministic config readers returning
      `{ file, receipts }` evidence; dynamic references, missing targets, paths outside the
      repository, and unparsed configs are disclosed boundaries
- [x] Stage 1: root package.json (`bin`/`main`/`module`/`exports`, npm `scripts`, `jest`), with
      `outDir` → `rootDir` source mapping
- [x] Stage 2: vitest/vite/jest `setupFiles`/`globalSetup` literals and tsconfig `files`
- [ ] ~~tsconfig `references`~~ — deferred: they name projects, not code files
- [x] Stage 3: GitHub Actions `run:` steps, reusing the workflow parser's `${{ }}` masking
- [x] `externally-wired` roots in `deadCodeIds` and `find_dead_code`, counted in `rootKinds`, with an
      `externalWiring` receipt block and caveats
- [x] `report_coverage_gaps` receipts and the CODEBASE.md entry-point decomposition

## Verification
- [x] Adapter fixtures: bin/main/exports mapping, a built output next to its source, npm scripts,
      tsconfig files, vitest setup files, workflow run steps with a working directory
- [x] Negative control: an unreferenced file stays candidate-dead with unchanged confidence and reason
- [x] Dynamic reference, missing target, symlink escape, and unparsed config → disclosed boundary
- [x] report_coverage_gaps: a config-wired untested entry point carries its receipt and is not also-dead
- [x] Dogfood: 38 of 1,018 entry points on this repository are in config-wired files
- [x] Full suite green
