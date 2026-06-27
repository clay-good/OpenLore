# Tasks — Codebase style fingerprint

> IMPLEMENTED 2026-06-26. Module: `src/core/analyzer/style-fingerprint.ts`. Counter set shipped:
> `functionForm`, `binding`, `conditionalForm`, `asyncForm`, `stringForm`, `functionNaming` —
> data-driven per language via `STYLE_LANG_SPECS`. The proposal's `early-return vs. nested-branch`
> example was **deferred for soundness**: a sound measurement needs CFG-level reasoning and a naïve
> AST proxy risks an unsound ratio, which the honesty discipline bans. The closed set is data, so it
> can grow when a sound counter for it lands.

## 1. Counter model & per-language data
- [x] Define a closed `StyleIdiom` counter set (function form, conditional form, binding, async form,
      string form, naming case per scope) and the `StyleFingerprint` artifact shape
      (`idiom → { dominant, ratio, samples } | { signal: null, reason }`, with repo/region/file roll-ups).
- [x] Declare the per-language counter set + the enforced-scope list as data (`STYLE_LANG_SPECS`)
      alongside `STYLE_FINGERPRINT_LANGUAGES` (tracks `add-declarative-language-support-registry`,
      which now DERIVES the `styleFingerprint` capability from it); fail-soft (no counters) for a
      language with no declared set.
- [x] Fix the evidence-floor constant (`STYLE_EVIDENCE_FLOOR = 12`); not caller-tunable.

## 2. Tally in the existing AST walk
- [x] Tally idiom counters during the call-graph pass (`extractTSGraph`/`extractPyGraph`/
      `extractGoGraph` call `tallyStyle` over the SAME already-parsed tree — no second parse, no new
      dependency); raw per-file counts thread out via `CallGraphResult.styleByFile`.
- [x] Roll up counters to repository, community/region (plurality file→community attribution), and
      on-demand single-file granularities (`buildStyleFingerprint` / `assembleFromRegions` /
      `fileProfile`).
- [x] Apply the evidence floor (below threshold → `below_floor` null) and enforcement-awareness
      (enforced scope → `enforced` null, e.g. Go `functionNaming`) at roll-up time.
- [x] Incrementally update the fingerprint for changed/deleted files under watch
      (`McpWatcher.updateStyleFingerprint`, reusing the stored file→region map; communities refresh
      on the next full analyze).

## 3. MCP surface
- [x] Add opt-in `get_style_fingerprint` (repo default; `communityId` region; `filePath` single
      file; `language` filter) with input + structured output; classified `conclusion` in
      `tool-contract.ts`; full-surface-only (never `MINIMAL_TOOLS`/navigation). `openlore
      style-fingerprint` CLI added for parity.
- [x] `orient`: include a compact `regionStyle` dominant-idioms summary for the resolved region when
      above the evidence floor (omits enforced/under-evidenced idioms; ≤4 idioms; fail-open).

## 4. Tests & fixtures
- [x] Skewed-idiom fixture (in `style-fingerprint.test.ts` via `CallGraphBuilder.build`); asserts
      dominant-idiom detection with sample sizes.
- [x] Sample floor returns `below_floor` null; Go compiler-enforced naming returns `enforced` null
      (not a `1.0` tautology) — on the real Go extractor (`language-support.test.ts` behavioral check).
- [x] Determinism: two `buildStyleFingerprint` runs byte-identical.
- [x] Integration: `get_style_fingerprint` surfaces the profile through the handler (repo/region/
      file/filter/missing); `orient` carries `regionStyle` (dogfooded end-to-end).

## 5. Verify & dogfood
- [x] `npm run lint`, `npx tsc --noEmit`, `npx vitest run src examples` (5191 passed), `npm run build` green.
- [x] Dogfood: `openlore analyze` produced `style-fingerprint.json` (631 files, 217 regions); CLI +
      orient sanity-checked against the code (numbers ring true).

## 6. Docs
- [x] Documented the tool, counter set, evidence floor, and descriptive (not prescriptive) contract
      (`docs/mcp-tools.md`, `CLAUDE.md` tool table); bumped the MCP tool-count guards (67 → 68) and
      the payload-budget ceiling.
