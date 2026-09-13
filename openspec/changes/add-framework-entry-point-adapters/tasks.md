# Tasks — add-framework-entry-point-adapters

## Implementation
- [x] Adapter module `src/core/analyzer/entry-point-adapters.ts`: config readers returning `{ file, receipts }`
      evidence and reasoned boundaries
- [x] Stage 1: root package.json (`bin`/`main`/`module`/`exports`, npm `scripts`, `jest`), with
      `outDir` → `rootDir` source mapping and a `build-output-unmapped` boundary
- [x] Stage 2: vitest/vite/jest setup-file literals (comment-aware, multi-line arrays, `<rootDir>`)
      and tsconfig `files`
- [ ] ~~tsconfig `references`, include globs~~ — dropped (see proposal)
- [x] Stage 3: GitHub Actions `run:` steps with working directories
- [x] Executed-file shell tokenizer: runners, wrappers, preloads, command position; redirects,
      heredocs, arguments ignored; variables, globs, `-m`, and `cd` disclosed
- [x] Hardened reading: no-follow non-blocking reads, no YAML merge keys, per-config caps
- [x] `externally-wired` roots in `deadCodeIds` (shared with coverage gaps, landmarks, claim
      verification) and `find_dead_code`, with receipts and caveats
- [x] `report_coverage_gaps` receipts and caveats; CODEBASE.md entry-point decomposition

## Verification
- [x] Adapter fixtures (17 tests), including arguments/outputs/heredocs not wired, FIFO and linked
      configs, a merge-key bomb, the reference cap, case spelling, and JSONC strings
- [x] Negative control: an unreferenced file's candidate is unchanged with and without wiring
- [x] report_coverage_gaps: a config-wired untested entry carries its receipt and is not also-dead
- [x] Dogfood on this repository and six public repositories
- [x] Full suite green
