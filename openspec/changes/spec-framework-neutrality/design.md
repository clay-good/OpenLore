# Design

## What exists (measured, main at `0dd75dbef`)

- No adapter interface. The nearest seams: `loadSpecCorpus`
  (`src/core/generator/spec-link-service.ts:116`), `buildSpecMap`
  (`src/core/drift/spec-mapper.ts:299`), `detectExistingSpecDir`
  (`src/core/services/config-manager.ts:403`), `resolveOpenspecDir` (`src/utils/openspec-dir.ts:21`).
- `createOpenSpecStructure` (`config-manager.ts:380`) is called from `src/api/init.ts:84` and
  `src/cli/commands/init.ts:187`. Install reaches it at `src/cli/install/index.ts:125-135`, cold
  start at `src/core/services/cold-start-bootstrap.ts:544`. `generate` already creates the folders
  it writes (`src/core/generator/openspec-writer.ts:166-168`).
- The only spawn of the `openspec` binary is `validateWithOpenSpec`
  (`src/cli/commands/change-status.ts:82-94`). It has an injection seam (`ValidateChange`, `:73`).
- `specValidationDisclosure` (`src/core/services/spec-workflow.ts:718-800`) already names a
  validator, never runs it, and discloses its absence. Copy that pattern.

## Decisions

**1. The interface is five fields and two functions.** New file `src/core/spec-sources/types.ts`:

```ts
type SpecItemKind = 'requirement' | 'scenario' | 'decision' | 'task' | 'test-intent';
interface SpecItem { id: string; text: string; file: string; line: number; kind: SpecItemKind }
interface SpecSource {
  id: 'openspec' | 'spec-kit' | 'kiro' | 'adr' | 'markdown-requirements' | 'tests';
  detect(root: string, config: OpenLoreConfig | null): Promise<string[]>; // paths found, [] = absent
  list(root: string, config: OpenLoreConfig | null): Promise<SpecItem[]>;
}
```

`id` is `<source>:<path-or-group>/<name>`, stable across runs. `file` is repo-relative, `line` is
1-based. No write method, no validate method, no lifecycle. Why: every consumer needs only "what
intent is written, and where." Rejected: one rich model with domains, deltas and anchors for all
formats; only OpenSpec has those, and the others would fill them with guesses. The OpenSpec
adapter keeps its richer functions (`loadSpecCorpus`, `buildSpecMap`) for drift, mapping and
generation; they become its implementation and are not part of the interface.

**2. Fixed detection order; every detected source is read.** Order decides which source is named
first and which wins when two sources claim one file.

| # | Source | Detected when | Files read | Kinds |
|---|---|---|---|---|
| 1 | `openspec` | `<openspecPath or openspec>/specs/*/spec.md` exists; for a bare `specs/` or `docs/specs`, a file must also have `### Requirement:` | `specs/*/spec.md`, `decisions/adr-*.md` | requirement, scenario, decision |
| 2 | `spec-kit` | `.specify/` exists, or `specs/*/spec.md` has no `### Requirement:` and has `FR-NNN` (assumption, confirm in task 9.1) | `specs/<feature>/spec.md`, `plan.md`, `tasks.md` | requirement, scenario, task |
| 3 | `kiro` | `.kiro/specs/*/requirements.md` exists (assumption, confirm in task 8.1) | `requirements.md`, `design.md`, `tasks.md` | requirement, task |
| 4 | `adr` | `docs/adr`, `docs/decisions`, or a path in `adrPaths` holds `*.md` | each ADR file | decision |
| 5 | `markdown-requirements` | a tracked `*.md` outside the sources above has a heading or sentence with SHALL / MUST / EARS shape | those files | requirement |
| 6 | `tests` | the analyzer found test files (`isTestFile`, `src/core/analyzer/test-file.ts:97`) | test names, describe blocks | test-intent |

Why read all: a repo can have OpenSpec specs and `docs/adr` together. Rejected: a config key that
selects one format; detection is cheap and a selector is a setting nobody asked for. Today
`detectExistingSpecDir` treats a bare `specs/**/*.md` as OpenSpec, which is also the Spec Kit
layout. Rows 1 and 2 fix that by looking at the content.

**3. "None" is a state, not an error.** None means sources 1 to 5 are all absent. Code answers,
test selection and decisions work in full. Spec-dependent answers keep their current keys (no
renames), drop the "run `openlore generate`" advice, and add `reason: "no-spec-source"` with
`lookedFor` (the source ids checked). `orient` adds one optional field,
`specSources: { found: string[], lookedFor: string[] }`, returned only when `found` is empty or a
non-OpenSpec source is present. `get_test_coverage` returns `coveragePercent: null` with the same
reason instead of 0. Why: an empty list reads as "nothing governs this code" and 0% reads as
"untested"; both are false. Rejected: returning `isError`; the agent retries or stops.
`openlore drift` keeps exit code 2 for this case (`src/cli/commands/drift.ts:682`), which the main
spec `DriftHookDistinguishesFailureFromDrift` already calls "could not check"; only the text changes.

**4. Where it plugs in.**

| Seam | Today | After |
|---|---|---|
| `detectExistingSpecDir` | 3 fixed roots, needs `<root>/specs` | calls `detectSpecSources`; returns the OpenSpec root or null |
| `loadSpecCorpus` | lists `<root>/specs/*/spec.md` | unchanged body, owned by the OpenSpec adapter |
| `buildSpecMap` | own listing and regexes | uses the OpenSpec adapter's listing; same `SpecMap` |
| `orient`, `search_specs` | OpenSpec only | also see items from other sources (group 5 onward) |
| drift, mapping, coverage | OpenSpec only | OpenSpec only; other sources: `not assessed: no code anchors` |

**5. No `openspec/` at first run; `openspecPath` optional.** `init` stops calling
`createOpenSpecStructure`. A new config has no `openspecPath` unless an OpenSpec corpus was detected
or the user passed one. Readers keep the `openspec` fallback, so an old config and a repo that adds
OpenSpec later both work. Decision sync still writes only into an existing OpenSpec corpus; without
one the decision stays in `.openlore/decisions/` and the skip is said once. `adrPaths` is read-only.
Rejected: writing ADRs into `docs/adr`; adapters do not write in this change.

**6. The `.gitignore` edit stays, as one disclosed line.** Without it the index (multi-MB files)
shows up in `git status` and in every diff-based answer. It is acceptable on the plugin path under
3 rules: (a) exactly one line, `.openlore/`, no comment line and no blank line (today
`addToGitignore` adds up to 3 lines, `src/core/services/gitignore-manager.ts:84-92`); (b) skipped
when Git already ignores the folder by any rule; (c) said once in the first-run output, with the
file name. Rejected: `.git/info/exclude` (invisible to the user, so not disclosed in any diff) and a
self-ignoring `.openlore/.gitignore` (hides checked-in files such as
`.openlore/public-surface-baseline.jsonl`).

**7. A missing validator is `not-assessed`.** `ValidationReceipt` keeps `passes` and `error` and
gains `assessed?: false` and `reason`. `validateWithOpenSpec` maps `ENOENT` (and a non-executable
binary) to `{ passes: false, assessed: false, reason: "openspec CLI not found" }`. The verdict is
computed as if validation was not a signal; `archivableCandidate` is false; text output prints
`validates: not assessed (openspec CLI not found)`. Rejected: bundling the validator; OpenLore does
not reproduce OpenSpec.
