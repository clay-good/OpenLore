# Dogfood — pre-flight blast-radius guard (2026-06-18)

Ran the shipped `blast_radius` capability against this PR's own working-tree diff on the OpenLore repo
itself. Goal: confirm the briefing is correct, conclusion-shaped, advisory, and that the hook installs
and behaves as specified.

## 1. CLI briefing on the real diff

`openlore blast-radius` (human render) and `--json` both produce a single conclusion-shaped briefing.
Trimmed JSON snapshot of this PR's diff vs `HEAD`:

```json
{
  "baseRef": "HEAD",
  "changed": { "files": 10, "symbols": 19 },
  "impact": {
    "highestRiskLevel": "critical",
    "maxAffectedCallers": 5,
    "hubsTouched": [],
    "analyzedSymbolCount": 12
  },
  "tests": { "count": 10, "toRun": ["payloadBytes", "serialize", "tool-driver.test", "map.test", "..."] },
  "memory": { "drifted": 0, "orphaned": 0 },
  "specs": { "willGoStale": 4 },
  "decisions": { "affected": 10 },
  "federation": { "evaluated": false, "note": "…multi-repo federation not yet shipped…" },
  "headline": "10 files / 19 symbols changed; highest risk: critical; 10 tests to run; 10 decisions affected; 4 specs may go stale.",
  "posture": "advisory"
}
```

The `critical` verdict came from editing `dispatchTool` (a high-fan-out god function whose blast radius
is large) — a true positive: that is exactly the kind of edit the guard exists to surface. The 10
`select_tests` entries, the 10 ADR-gap decisions (the changed analyzer/mcp-handlers files are governed
by recorded ADRs), and the 4 stale specs are all real and match what `check_spec_drift` reports.

**Verified:**
- `--json` stdout is clean (validateDirectory's per-call success chatter is suppressed via quiet mode);
  first byte is `{` and the payload parses.
- Output is conclusion-shaped — counts + named risks, no `nodes[]`/`edges[]`. `assertConclusionShape`
  passes in the test suite.
- `federation.evaluated: false` is surfaced honestly with a note, not silently omitted.

## 2. Advisory hook behavior

- `openlore blast-radius --hook` → **exit 0** (advisory), briefing printed to **stderr**. Confirmed on
  this repo's diff (a critical-risk diff still does not block).
- `--install-hook` appended the `# openlore-blast-radius-hook` block to `.git/hooks/pre-commit` **after**
  the existing decisions-gate block (both markers present, the blast block is reachable). Coexistence
  with the decisions gate verified.
- `--uninstall-hook` removed only the blast-radius block and left the decisions gate intact.
- Infrastructure failure (no graph / not a repo) prints a warning and **exits 0** — it never blocks a
  commit. Verified by the `error in result` branch returning 0.

## 3. Opt-in blocking

`triggeredBlockPatterns(briefing, block)` is the deterministic gate:
- `orphans-anchored-memory` fires only when `memory.orphaned > 0`.
- `orphans-anchored-decision` fires only when a decision issue of kind `adr-orphaned` is present.
- With no configured patterns (the default), it returns `[]` → advisory, never blocks.

Unit-tested for all three cases (fires-on-its-pattern / advisory-otherwise / advisory-by-default). On
this PR's diff no orphaning pattern is present, so even with blocking configured the hook would stay
advisory — matching the spec scenario "opt-in blocking fires only on its pattern."

## 4. Regression posture

Full suite green after the change: **191 files, 3917 passed, 2 skipped** (`vitest run src examples`).
The conscious tool-surface budget was bumped 55_000 → 57_000 with a documented comment, per the
established `mcp-presets` discipline. No other test required changes beyond registering the new tool in
`tool-driver.ts` (the TOOL_REGISTRY ↔ TOOL_DEFINITIONS completeness check).

## 5. Post-review hardening (2026-06-19)

A review pass (impl / tests / docs) tightened the advisory-never-block guarantee and closed test gaps:

- **Advisory safety net hardened.** `validateDirectory` and the composed handlers can *throw* (bad
  path, corrupt JSON, a mid-pass git failure), not only return `{error}`. Those throws are now caught:
  per-symbol `analyze_impact` failures are skipped (one bad symbol no longer aborts the briefing),
  a `check_spec_drift` throw degrades to a drift-unavailable caveat, and `runBlastRadiusCli` wraps the
  whole compute in a final try/catch → it can never turn an exception into a blocked commit. Re-verified
  end-to-end: running from a non-analyzed directory and with a bad base ref both exit 0 in `--hook` mode.
- **Hook version-skew can't hard-block.** The local-build branches of the installed hook now probe
  `blast-radius --help | grep -- '--hook'` before invoking (matching the global branch), so a stale local
  `openlore` that predates the feature degrades to advisory instead of erroring out and blocking.
- **No-silent-truncation.** The `changed.symbolNames` cap (30) now emits a caveat when exceeded.
- **Tests expanded 7 → 24** for the feature: hook install/uninstall (fresh, coexist+strip-`exit 0`,
  idempotent, round-trip restore, not-a-repo), the full `runBlastRadiusCli` flow (advisory exit 0 on
  error, `--json` `{status:"unavailable"}`, block exit 1 only on a configured fired pattern, stderr
  routing), `impactResults` normalization (`{matches}` name-collision / error / null), truncation
  caveat, and depth/maxSymbols clamping.
- **Docs aligned.** The `cli/PreflightHookIsOptInAndAdvisory` scenario now matches reality (explicit
  `--install-hook` command, never auto-installed by `openlore setup`); `blast_radius` rows added to the
  README cheat-sheet and `docs/mcp-tools.md`; the stale "50 tools" surface figure corrected to the
  measured 58.

## 6. Second hardening round (2026-06-19) — block-correctness & config safety

A second review pass (correctness / openspec-lifecycle / security) found two real defects in the
block path that the first pass missed; both are now fixed and regression-tested:

- **Block gate could silently fail to fire (correctness bug).** `triggeredBlockPatterns` decided
  `orphans-anchored-decision` by scanning `decisions.items`, which is display-capped at 20. On a large
  diff where `adr-orphaned` issues landed past index 20 (behind many `adr-gap` entries), a commit the
  operator explicitly configured to block would have passed advisory. Fixed by adding an **uncapped**
  `decisions.orphaned` count (mirroring `memory.orphaned`) and blocking on the count, never the sliced
  array. Regression test asserts the block fires when the orphaned issue is past the cap. Verified on
  the real diff: `decisions: { affected: 11, orphaned: 0, items_len: 11 }`.
- **Malformed config could block a commit (never-block violation).** A syntactically valid
  `.openlore/config.json` with a wrong-typed `blastRadius.block` (e.g. `{}` or a bare string) threw on
  iteration *outside* the advisory safety net → non-zero exit → blocked commit. Fixed by coercing
  `block` with `Array.isArray` and wrapping the config read in its own try/catch. Verified end-to-end:
  a `block: {}` and a `block: "…"` config both exit 0 in `--hook` mode.
- **No-silent-truncation completed.** Every display-capped detail list (`tests.toRun`, `memory.willDrift`,
  `specs.items`, `decisions.items`, `impact.topSymbols`) now emits a caveat when it drops items —
  closing the gap against the module's own "truncation is reported, never silent" contract.
- **Conclusion-shape locked on all return paths.** Added `assertConclusionShape` assertions for the
  empty-diff briefing and the `{error}` path (previously only the populated briefing was asserted).

Tests for the feature: **24 → 27**. Full suite re-confirmed green (`vitest run src examples`).

> **Known follow-up (not a functional gap, out of this feature's scope):** the two auto-extracted
> hardening decisions (`51c2603d`, `215092bc`) synced into `openspec/specs/analyzer/spec.md` because
> `blast-radius.ts` is mapped to the `analyzer` domain; they semantically belong to `mcp-handlers`/`cli`.
> The advisory/opt-in *requirements* are already correctly captured in the mcp-handlers/cli specs via the
> change's hand-written deltas, so no requirement is missing — only the decision filing is off-domain.

## 7. Third pass — real end-to-end execution + surface/doc polish (2026-06-19)

This pass exercised the surfaces the earlier passes only unit-tested, against real inputs:

- **Real `git commit` through the installed hook.** In a throwaway repo (real `openlore init` + `analyze`,
  hook resolving to this build), an actual `git commit` ran the advisory briefing to stderr and exited 0;
  the commit landed. Confirmed it coexists with a decisions-gate hook and that the capability probe
  silently degrades to advisory when only an older global `openlore` (no `--hook`) is on PATH.
- **Live MCP protocol.** Drove `node dist/cli/index.js mcp` over JSON-RPC stdio: `tools/list` advertises
  58 tools including `blast_radius` (schema `required:["directory"]`, props `directory/baseRef/depth/maxSymbols`);
  `tools/call blast_radius` returns `isError:false` and a valid conclusion-shaped briefing (with the new
  `decisions.orphaned`), honoring `maxSymbols`.
- **Edge cases.** Unborn HEAD (first-ever commit) with and without an analysis both exit 0 — no crash,
  the first commit is never blocked.
- **Surface/doc polish.** Added an explicit `blast_radius: _RO` entry to `TOOL_ANNOTATIONS` (was relying on
  the silent `_RO` fallback); corrected four remaining stale "50 tools" references (`README.md` ×2,
  `docs/agent-setup.md` ×2) to 58; the hook's human render now appends a "… and N more" line for any capped
  detail list (specs/decisions/memory) so the developer-facing output is never silently truncated.

Feature tests: **27 → 28**. Full suite re-confirmed green (`vitest run src examples`); `tsc` + `eslint` clean.

## 8. Fourth pass — adversarial multi-agent E2E + base-ref honesty fix (2026-06-19)

A fourth review fanned out three adversarial agents (security / docs-consistency / block-path E2E) against
real inputs, plus direct dogfooding of the built CLI and the live MCP server. It found and fixed one real
defect and one user-facing doc miss; the remaining surfaces re-confirmed clean.

- **[fixed] Base ref was misrepresented on silent fallback (honesty defect).** `getChangedFiles` →
  `resolveBaseRef` silently falls back through `main → master → HEAD~1` when the requested ref does not
  resolve, but `computeBlastRadius` discarded `diff.resolvedBase` and labeled the briefing with the
  *requested* `baseRef`. So `blast-radius --base totally-bogus-ref` produced a briefing that *claimed* to
  diff against `totally-bogus-ref` while actually diffing `main` (24 files) — a silent misrepresentation
  that violates the briefing's own no-silent / honest-scope contract. The briefing now carries a
  `resolvedBaseRef` field (what git actually diffed against) alongside the requested `baseRef`, emits a
  caveat when they differ (`Requested base ref "X" did not resolve; diffed against "Y" instead …`), the
  empty-diff headline reports the resolved ref, and the human/hook render adds a `⚠ base ref … did not
  resolve` line — so the fallback is honest across all three surfaces (JSON, MCP, human). Verified E2E on
  the real repo and the live MCP server; the advisory-never-block guarantee is preserved (bad ref in
  `--hook` still exits 0). Decision `c7ddcd1f`.
- **[fixed] Two stale "50 MCP tools" references.** The third pass corrected the in-prose counts but missed
  the top-of-README architecture table (`README.md:72`) and the Mermaid architecture diagram
  (`README.md:395`); both now read **58 MCP tools**, matching the measured surface.
- **Re-confirmed clean by adversarial agents (no defect):**
  - *Argument-injection / never-block:* `validateGitRef` (leading-dash + allowlist) plus `execFile`
    (no shell) reject `--upload-pack=…`, `-x`, shell metacharacters, null bytes, and 5,000-char refs on
    both the CLI and MCP paths. Every malformed input in `--hook` mode — no analysis, non-git dir, invalid
    JSON config, bad/empty/null-byte ref, and `blastRadius.block` set to a number / null / nested array /
    bare string / bogus pattern names — exits 0. The installed hook shell script has no user-controlled
    interpolation and `sh -n` passes.
  - *Block path fires E2E:* on a throwaway repo, an anchored memory was orphaned (anchor symbol deleted +
    re-analyzed); with `block: ["orphans-anchored-memory"]` a real `git commit` through the installed hook
    was **blocked** (exit 1, "commit blocked" message), and the same diff with no block config **committed**
    (exit 0, advisory). Confirms `triggeredBlockPatterns` reading the uncapped `*.orphaned` count works end
    to end, not just by inspection.

Feature tests: **28 → 31** (base-ref fallback honesty + no-caveat-when-resolved + human-render fallback
line). Full suite green: **191 files, 3924 passed, 2 skipped** (`vitest run src examples`); `tsc` + `eslint`
clean.
