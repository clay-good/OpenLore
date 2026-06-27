# Dogfood — multi-repo federation (2026-06-19)

End-to-end validation of the federation subset on two real repos analyzed by the freshly-built CLI.
This is the live evidence behind the IMPLEMENTED status; the deterministic unit coverage is in
`src/core/federation/{registry,resolver}.test.ts` (18 tests) and `mcp-presets.test.ts`.

## Setup

Two tiny repos, each with its own independently-built `.openlore` index:

- **repo-a (producer)** — `src/index.ts` exports `greet(name)` and `farewell(name)`.
  - `greet` → `stable_id: "sid:greet(name: string)"` (internal node).
- **repo-b (consumer)** — `src/app.ts` `welcome()` calls `greet` (imported from `repo-a`),
  `runApp()` calls `welcome()`; `src/app.test.ts` covers `welcome()` via an inline `it()` block. The
  analyzer associates that test through a `tested_by` edge on the test module — there is no callable
  `testWelcome` symbol — so cross-repo selection surfaces it as the test `app.test` (see session 2).
  - The cross-package call is retained as an external node `{name:"greet", is_external:1}` plus an
    edge `welcome → greet (confidence:"external")`. This is the signal federation resolves on.

```
$ openlore federation add /tmp/fed-exp/repoB --name consumer-b   # run from repo-a
✓ Registered "consumer-b" → /tmp/fed-exp/repoB
$ openlore federation list
  consumer-b           ✓ indexed
```

`.openlore/federation.json` holds `{ name, path, fingerprint, schemaVersion, lastBuilt }`. Force-
reanalyzing repo-b changed its fingerprint and `federation list` / queries correctly flipped it to
`⚠ stale` until re-registered — staleness detection works.

## Per-tool results (via the real `dispatchTool` path)

**federation_status** (home = repo-a): `registered: 1, indexed: 1`, repo state + live-vs-registered
fingerprint reported. Opt-in: this tool exists only under `--preset federation`.

**analyze_impact `greet` + federation** — the headline scenario:
```json
"federation": {
  "consumers": [ { "repo": "consumer-b", "caller": "welcome", "file": "src/app.ts", "symbol": "greet" } ],
  "consumerCount": 1,
  "reposConsulted": ["consumer-b"],
  "reposSkipped": [],
  "caveats": ["Cross-repo consumers are matched by exact symbol name at external call sites; …collision is possible."]
}
```

**find_dead_code + federation** — `farewell` (no consumer anywhere) stays a high-confidence
candidate; `greet` is pulled OUT of candidate-dead and reported as `liveViaFederation` because
consumer-b's `welcome` calls it. Exactly the "is this export dead across all consumers, not just
here?" scenario.

**select_tests `greet` + federation** — selects the consumer's test across the repo boundary:
```json
"federation": { "crossRepoTests": [ { "repo": "consumer-b", "test": "app.test", "file": "src/app.test.ts", "viaSymbol": "greet", "confidence": "high" } ], "crossRepoTestCount": 1 }
```
(Test nodes live only in `ctx.callGraph`, not the SQLite store which persists production nodes —
the federated test walk uses the call graph, matching the single-repo `select_tests`.)

**find_path `runApp` → `greet` + federation** (home = repo-b, repo-a registered) — `greet` isn't in
repo-b's graph, so instead of a bare error it returns the cross-repo location + bridge:
```json
"crossRepo": true,
"federation": {
  "producers": [ { "repo": "producer-a", "file": "src/index.ts", "stableId": "sid:greet(name: string)" } ],
  "bridge": { "present": true, "fromHomeCallers": ["welcome"] }
}
```

## Honesty / invariants observed

- No merged graph: each repo's index is loaded lazily via `readCachedContext`; only the repos needed
  are touched. Adding a repo never triggered a global rebuild.
- Every conclusion names `reposConsulted` / `reposSkipped` with a reason (stale/unindexed/missing).
- The cross-repo match is exact on the stable-ID name descriptor; call-site signatures are
  unavailable, so arity is unconfirmed and a bare exported-name collision across packages is possible
  — disclosed in `caveats`, not hidden.

## Bugs found & fixed during dogfooding

1. `findReachingTests` originally walked the SQLite edge store, which holds only production nodes —
   test nodes were invisible and `select_tests` federation returned empty. Rewrote it to traverse
   `ctx.callGraph` (where test nodes live), matching the single-repo handler.
2. `find_path` errored before reaching federation logic when `to` didn't resolve in the home repo.
   Reordered so a `to` published by another repo resolves to a cross-repo location instead of an error.
3. `tools/list` payload budget + the tool-driver coverage gate + tool-contract classification all
   needed the new tool registered — caught by existing guard tests and fixed.

## Adversarial re-dogfood (2026-06-19, session 2)

Re-ran the full scenario set on **freshly `openlore analyze`-built** repos (not hand-shaped indexes),
driving the real `dispatchTool` path, plus a third repo (`repo-c`) that calls a *different* package's
`greet` to probe the disclosed name-collision case. Three real bugs surfaced that the synthetic unit
tests had masked; all are now fixed with regression tests (`registry.test.ts`, `resolver.test.ts`).

1. **Registry path identity was not symlink-canonical** (`registry.ts`). The CLI passes
   `process.cwd()` (OS-canonicalized) as the home dir, but a user-supplied repo path was only
   `resolve()`d. On a system where the working tree sits behind a symlink (macOS `/tmp` →
   `/private/tmp`, a symlinked checkout) the home-repo self-add guard, path de-dup, and remove-by-path
   all silently failed to match the same directory — e.g. `openlore federation add .` from the home
   repo registered the repo as its own peer, and every federated conclusion then consulted the home
   repo as a "consumer." Fixed with a `canonicalize()` (realpath, resolve-fallback) used for all path
   comparisons; the unit test now exercises symlinked spellings. The original happy-path dogfood missed
   this because its paths were already canonical.

2. **Federated `select_tests` ignored `tested_by` edges** (`resolver.ts` `findReachingTests`). The
   single-repo handler discovers tests from two sources — test *nodes* reached by the backward
   call-walk **and** import-based `tested_by` edges — but the federated walker implemented only the
   first. The real analyzer associates a typical test file with the production it covers via a
   `tested_by` edge (an inline `it("…")` block produces no callable test symbol), so on a real consumer
   index `select_tests <symbol> --federation` returned **`crossRepoTests: []`** even though the
   consumer's code was tested. (The original dogfood's `testWelcome` result came from a hand-built
   `testWelcome → welcome` call edge, which the analyzer does not emit for an inline test.) The walker
   now honors `tested_by` on the seeds and on every reached production node; the cross-repo test is
   selected (`app.test`, high confidence) on the real index.

3. **`find_dead_code` silently dropped federation in `ifDeleted` mode** (`reachability.ts`). The
   delete-impact branch returns before the federation block, so `federation: true` was accepted and
   ignored with no disclosure — violating the "every federated conclusion names its coverage" invariant.
   Now the delete-impact response carries a `federationNote` explaining that federation scope is a
   within-repo reachability query here and pointing to the candidate-dead / `analyze_impact` paths for
   cross-repo liveness.

Re-verified after the fixes, end-to-end through `dispatchTool`: home-repo self-add is rejected;
symlinked-spelling re-add refreshes (not appends); `analyze_impact greet --federation` names
`consumer-b` **and** `consumer-c` (collision disclosed in `caveats`, not hidden) and no longer
self-consults the home repo; `find_dead_code --federation` keeps `greet` live-via-federation while
`farewell` stays high-confidence dead; `select_tests greet --federation` selects the consumer test
across the boundary; `find_path runApp→greet --federation` returns the cross-repo producer + bridge.
Full suite green after the fixes.

## Adversarial re-dogfood (2026-06-19, session 3)

Four independent adversarial passes (registry/CLI, cross-repo resolution, test-selection/pathfinding,
docs/spec) over freshly `openlore analyze`-built repos driven through the real `dispatchTool` path.
The four headline scenarios and all session-2 fixes re-verified green; six further gaps surfaced and
were fixed with regression tests. Full suite green afterward: **3921 passed, 2 skipped**.

1. **`federation list` / `remove` crashed on a corrupt manifest** (`federation.ts`). Unlike `add`, the
   `list` and `remove` actions had no try/catch, so a malformed `.openlore/federation.json` made
   `loadRegistry` throw an *uncaught* exception — a raw Node stack trace with no clean exit code. Both
   now print `✗ <message>` and set `process.exitCode = 1` (verified end-to-end via the real CLI binary;
   regression test in `federation.test.ts`).

2. **`select_tests --federation` mis-attributed `viaSymbol` on multi-symbol changes** (`resolver.ts`
   `findCrossRepoTests`). With more than one changed symbol, every selected test in a repo was labeled
   with a blanket join of *all* symbols that repo consumed (e.g. `"farewell,greet"`) instead of the
   specific symbol whose consumer reached it. Seeds are now grouped per published symbol and walked
   separately, so each cross-repo test is attributed to the exact symbol that selected it
   (`testHi → greet`, `testLo → farewell`). Regression test in `resolver.test.ts`.

3. **`find_dead_code --federation` silently truncated the consumer list** (`reachability.ts`).
   `analyze_impact` discloses `federation.truncated` when the 200-consumer cap drops consumers, but
   `find_dead_code` omitted it — a silent under-report violating the coverage-honesty invariant. It now
   threads `batch.truncated` (verified on a real 210-caller consumer: `consumers: 200, truncated: 11`).

4. **`select_tests --federation` ignored `directResolvedOnly` across the boundary** (`test-impact.ts` →
   `resolver.ts`). Local selection honors the strict flag; the cross-repo walk traversed synthesized
   dynamic-dispatch edges unconditionally. `findReachingTests` now accepts `directResolvedOnly` and the
   handler threads it, so a test reaching a consumer call site only through a synthesized edge is dropped
   under strict selection — matching the single-repo semantics. Regression test in `resolver.test.ts`.

5. **`select_tests --federation` silently dropped the federation surface when no local seed resolved**
   (`test-impact.ts`). Opting into federation but resolving zero changed symbols returned no federation
   block at all. It now returns a `federationNote` explaining that cross-repo selection keys off the home
   repo's changed published symbols, so nothing was propagated. Regression test in `test-impact.test.ts`.

6. **`find_path` `name:` selector was a half-wired dead path** (`pathfind.ts`). The federation
   selector-prefix regex listed `name:`, but `resolveEndpoint` has no `name:` branch, so `to:"name:greet"`
   produced a strictly *worse* answer than the bare `to:"greet"` (empty federation block + bare error).
   `name:` is now treated as an explicit symbol name (stripped, like a bare name), so `name:greet`
   resolves to the same cross-repo producer + bridge as `greet` (verified end-to-end).

**Docs.** Fixed four stale "50 tools" figures the count guard could not see — its regex matched only a
bare `\d+ tools`, so `50 MCP tools` / `50 graph-native tools` (README) and `all 50` (mcp-tools.md) drifted
while the surface grew to 58. Corrected to 58 and broadened the guard regex to allow one adjective between
the count and "tools" so the phrasing is guarded going forward. Added an **Honest limits** section to
`docs/federation.md`: staleness is only as fresh as each peer's last real `analyze` (the analyze TTL can
mask in-window drift — use `--force`), and a consumer that locally shadows an imported name resolves the
call to its local node, so it won't appear as a cross-repo consumer (a disclosed false-negative).

### Three pre-existing callouts pulled into this PR

The first two were flagged as pre-existing (not strictly federation), then fixed here at the maintainer's
request; the third is documented as a limit rather than code-changed (touching the `analyze` TTL has a
fleet-wide blast radius).

1. **`find_path` emitted a broken relative path** (`pathfind.ts`, present since the original `find_path`
   feature, commit 4e42e5e — not federation). The chain ran each node's *already repo-relative* path
   through `relative(absDir, …)`, which re-resolved it against `process.cwd()` and emitted
   `"../../…/<cwd>/src/app.ts"` garbage whenever the MCP server's cwd differed from the analyzed directory
   (the normal server case — it only looked right when cwd happened to equal the project dir).
   Reproduced live: home repo analyzed by absolute path from a different cwd →
   `"../../../../../../private/tmp/fp-repro/examples/opencode/agent-guard.ts"`. Fixed to relativize only
   genuinely-absolute paths and pass repo-relative ones through verbatim; regression test asserts the
   chain stays repo-relative (no `../`) when the analyzed dir is not cwd.

2. **`--minimal` help said "5 tools" while the preset holds 6** (`mcp.ts`). `get_health_map` was added to
   `MINIMAL_TOOLS` (commit 4b76575) and the `mcp-presets` test already pins the 6-tool *set*, but the
   user-facing `--minimal` help string and `docs/agent-setup.md` still listed the old 5. Both corrected to
   6 (now naming `get_health_map`), and a new guard ties the `--minimal` help text to `TOOL_PRESETS.minimal`
   (count + every member) so it can't drift from the set again. (Dated benchmark/spec records that measured
   the historical "5 tools / ~45 tools" surface are left intact, like the tool-count guard's exclusions.)

3. **`analyze`'s recency TTL can mask peer drift fleet-wide** — documented, not code-changed. A peer edited
   and re-`analyze`d inside the recency window is TTL-short-circuited, so its `fingerprint.json` doesn't
   move and federation still reads it as `indexed`/consultable. This affects all of OpenLore (the TTL is
   not federation code) and changing it has a wide blast radius, so it is disclosed in the **Honest limits**
   section of `docs/federation.md` (run `openlore analyze --force` in a peer to be certain) rather than
   altered here.

## Adversarial re-dogfood (2026-06-19, session 4)

Fourth pass: four parallel adversarial probes (registry/CLI, cross-repo resolution, test-selection/
pathfinding, docs) driving the real `dispatchTool` path over freshly `openlore analyze`-built repos. All
prior fixes and the four headline scenarios re-verified. Registry/CLI hardening held under ~35 adversarial
cases (symlink-canonical self-add, corrupt-manifest list/remove, junk-entry filtering, name clashes) with
no crashes and correct exit codes. Three further gaps fixed with regression tests:

1. **Consumer-cap starvation flipped a `find_dead_code` liveness verdict to a false positive** (`resolver.ts`,
   `findCrossRepoConsumersBatch`). The cap on returned consumers was a single counter shared across all
   symbols in a batch. In the multi-symbol `find_dead_code` path, an earlier symbol (e.g. `farewell`, sorted
   first) could exhaust the cap, leaving a later, *genuinely-consumed* symbol (`greet`) with an empty
   consumer list — so it was reported as candidate-**dead** despite a real cross-repo consumer (a confidently-
   wrong "safe to delete"). Fixed so the cap bounds the consumer *list* but never zeroes a symbol's liveness
   signal: each consumed symbol keeps at least one consumer past the cap, with the remainder truncated and
   disclosed. Regression test in `resolver.test.ts`.

2. **`find_path` `landmark:<exact-name>` did not resolve cross-repo** where bare `greet` / `name:greet` did
   (`pathfind.ts`). The kind-selector regex lumped `landmark:` with `role:`/`file:` and forced the cross-repo
   symbol lookup off, so `to:"landmark:greet"` gave a bare "resolved to no functions" while `name:greet`
   returned the full producer + bridge. A `landmark:` whose id is a plain symbol name (not a `file::name`
   node id) is a symbol reference, so it now resolves cross-repo identically to `name:`. `role:`/`file:`
   still correctly carry no symbol name. Verified end-to-end.

3. **`find_path` cross-repo `note` echoed the raw `name:` selector** (`pathfind.ts`) — `to:"name:greet"`
   produced `"name:greet" is not defined…` instead of `"greet" …`. Now reports the stripped name
   (`federation.to`). Cosmetic; verified end-to-end.

Docs reconciled to reality: the `select_tests` scenario block above corrected (`testWelcome` → `app.test`,
matching the file's own session-2 fix note and real analyzer output); stale full-surface tool counts fixed
(`docs/cli-reference.md`, the `--preset` help in `mcp.ts`: `~45` → `58`); stale `tools/list` size figures
fixed (`docs/mcp-tools.md`, `docs/agent-setup.md`: `~48 KB / ~12k tokens` → `~55 KB / ~14k tokens`). The
tool-count guard was broadened to cover `docs/cli-reference.md` and to tie the documented KB/token figures
to the measured payload, so neither the count nor the size can silently drift again.

Full suite green: 3926 passed, 2 skipped (+3 guards/regressions).

## Adversarial re-dogfood (2026-06-19, session 5)

Fifth pass on the patched branch (post commit 15f46f0), three fresh probes: a regression-hunt of the
session-4 cap-liveness fix, previously-underexplored territory (3+ repo fleets, `federationRepos` subset
through the real tools, cross-repo `readCachedContext` caching, `valueLevel`+federation, `diffRef`-based
cross-repo `select_tests`, bounds/safety on non-OpenLore dirs), and a verification that the new doc guards
actually fail on drift.

- **Cap-liveness fix: no regression.** Verified the single-symbol `analyze_impact` truncation is byte-
  identical to the pre-fix behavior (the guard only relaxes the cap for a symbol's *first* consumer), that
  `truncated` still counts only dropped consumers (not force-added ones), that over-return stays bounded by
  symbol count, and — by re-running the *old* rule on the same indexes — that the fix rescues 50/50 live
  symbols the old code would have falsely reported dead. The KB/token doc guard was proven to FAIL on the
  stale `~48 KB / ~12k` figure and pass on the current `~55 KB / ~14k`.

Two further gaps fixed with a regression test:

1. **`find_path` cross-repo note over-claimed a bridge that doesn't exist** (`pathfind.ts`). The note was
   hardcoded to assert "the home path reaches it at the external call site(s)…" whenever a scoped repo
   merely *defined* the `to` symbol — even when `bridge.present` was false (the home repo has no call site
   to it). E.g. from repo-a, `find_path greet→welcome --federation` located `welcome` in repo-b but the
   home repo never calls it, yet the note claimed a reaching bridge. The note is now conditional on
   `bridge.present`: with a bridge it names `bridge.fromHomeCallers`; without one it states plainly that
   the home repo has no bridging call site and there is no cross-repo path. Verified both directions e2e.

2. **`analyze_impact` crashed on a missing `symbol` arg** (`graph.ts`, pre-existing, not federation-
   specific). `symbol` is required by the MCP inputSchema but `dispatchTool` enforces nothing, so a
   non-conformant caller reaching the handler with an undefined symbol hit `undefined.toLowerCase()` — an
   uncaught `TypeError` instead of a clean error. Surfaced while driving the federation tools directly;
   fixed with a guard returning `{ error: 'symbol is required.' }`. Regression test in `graph.test.ts`.

The Setup section's stale `testWelcome()` framing (the lone remaining echo of the hand-built-edge model
that session 2 corrected) was reconciled to the real inline-`it()` / `tested_by` / `app.test` behavior.

Full suite green: 3927 passed, 2 skipped (+1 regression).
