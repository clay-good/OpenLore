# Dogfood — bitemporal / typed / lifecycle memory ops

> 2026-06-18 · branch `feat/bitemporal-typed-memory-operations` · against the **built** `dist/`
> handlers, a real temp git repo, and a real `openlore analyze` run (not unit fixtures).

## Method

1. `npm run build` (tsc + copy-assets) — green.
2. Created a throwaway repo `/tmp/ol-dogfood` with `src/cache.ts` (`getCache` / `setCache`),
   `git init` + commit → **C1**.
3. `openlore init .` then `openlore analyze . --no-embed` via the built CLI → real
   `.openlore/analysis/call-graph.db` (so anchors resolve to real call-graph symbols, with real
   `stableId`s).
4. Drove the built `handleRemember` / `handleRecall` through the full lifecycle and inspected the
   raw JSON. Clean-store (first) run results below.

## Results (clean-store run)

| Behavior | Expectation | Observed | ✓ |
|----------|-------------|----------|---|
| `validFromCommit` stamping | = HEAD at record time | `m1.validFromCommit === C1` → `true` | ✓ |
| Typed write | stored as given | `m1.type === "invariant"` | ✓ |
| Contradiction surfacing | two fresh notes on `getCache` → `unreconciled` | group keyed by **stableId** `sid:getCache(key: string)`, `note: "…reconcile or supersede one"` | ✓ |
| Supersede | retires prior; message names it | `"Superseded prior memory 33e240bc (now invalidated; queryable via asOf)."` | ✓ |
| Supersede ⇒ authoritative | invalidated note leaves the set | superseded id absent from `authoritative`, `total` drops | ✓ |
| `asOf C1` (history) | superseded note reappears as-of its valid window | `asOf` recall includes the invalidated id (`hasM2: true`) | ✓ |
| `changedSince C1` | only recorded/invalidated **after** C1 | returns the post-C1 record + the invalidated-at-C2 id; excludes the at-C1 record | ✓ |
| `type=invariant` filter | only invariant notes | returns just the invariant-typed ids | ✓ |
| Content+anchor dedup | re-record identical → same id | `dup.id === m1.id` → `true` | ✓ |

## Notes / observed semantics

- **Contradiction grouping uses the content-addressed `stableId`** when the symbol has one
  (`sid:getCache(key: string)`), so it survives a file move/rename — not just the path-based `nodeId`.
  Confirms reuse of `add-content-addressed-stable-symbol-ids`.
- **`asOf` / `changedSince` shell out to git only when supplied** (`merge-base --is-ancestor`); the
  common recall path makes zero git calls. Comparison is ancestry-based, so it is reproducible for a
  fixed repo state rather than wall-clock dependent.
- **Re-recording identical content+anchor revives a previously-superseded memory** (the dedup upsert
  replaces in place with a fresh, non-invalidated record). This is intentional "update in place" /
  re-assertion semantics, not a regression: explicitly re-stating a fact makes it current again. It
  only surfaces when the same store is reused across runs; unit tests use fresh temp stores.

## Follow-up review fixes (2026-06-18, post-implementation)

A correctness/coverage pass over the diff surfaced two issues, both fixed in this PR:

1. **Literal NUL byte in `makeMemoryId`** (`memory-store.ts`) — the dedup hash used a raw `\x00`
   delimiter written as a literal control byte, which made git treat the whole file as **binary**
   (no diff, no blame, renders as "Binary file" on GitHub). Replaced with the `\x00` escape sequence;
   runtime-identical (template literals decode `\x00` to the same NUL char, so existing ids are
   unchanged), source is text again.
2. **Self-supersede reported a false retirement** (`memory.ts`) — calling `remember` with
   `supersedes` set to the memory's own (re-)computed id (identical content+anchor) invalidated then
   immediately overwrote the same record, yet returned "now invalidated; queryable via asOf." Now
   guarded: a self-supersede is reported honestly as an in-place update with nothing retired. Also
   hardened `supersededFound` to derive from the committed store rather than a closure side-effect.

Both confirmed against the **built** handlers on a real repo (self-supersede now returns
`"…is this same memory (identical content+anchor) — updated in place, nothing retired."`).

A second (cross-cutting) review pass found three more, all fixed:

3. **`detectMemoryStaleness` flagged superseded notes as stale** (`drift/drift-detector.ts`) — the
   note loop scanned every record but, unlike the decisions loop above it (which skips inactive
   decisions), never skipped `invalidatedAt` notes. A retired note whose anchored code later moved
   would surface as `memory-orphaned`/`memory-drifted`, telling the user to re-record or reject a
   memory that was already superseded. Now skips invalidated notes, matching recall/orient and the
   memory-integrity invariant.
4. **Legacy id-scheme records silently duplicated on re-record** (`memory.ts`) — dedup matched on
   the stored id string, so a record written under the old `hash(content+recordedAt)` scheme would
   not match a re-record's new `hash(content+anchors)` id, leaving two copies. Dedup now keys on
   content+anchor identity (recompute `makeMemoryId`), so re-recording updates in place for
   pre-existing stores too — zero behavior change for new-scheme records.
5. **Combined `asOf` + `changedSince` empty-by-construction window returned a silent empty set**
   (`memory.ts`) — the intersection is non-empty only when `changedSince` is a strict ancestor of
   `asOf`; otherwise recall now warns instead of returning an indistinguishable `total:0`.

Cross-cutting audit also confirmed (no change needed): `saveMemoryStore`/atomic-store round-trip all
new optional fields; `tool-contract` classification for recall/remember unaffected; no CLI/API/view
surface reads the raw memory store; vanished-commit anchors fail closed (excluded from temporal scope).

## Adversarial dogfood + review pass (2026-06-19)

A third, adversarial pass spawned parallel audits (logic, docs/spec, cross-cutting consumers) and
re-dogfooded the **built** handlers against a fresh `/tmp/ol-dogfood163` repo with a real
`openlore analyze --no-embed` call-graph DB. Findings and resolution:

| Probe (real repo + real graph) | Result |
|---|---|
| `validFromCommit` = HEAD, typed write, anchored to real `stableId` | ✓ |
| Contradiction on `getCache` keyed by `sid:getCache(key: string)` in both `recall` **and** `orient` | ✓ |
| Supersede names retired id; contradiction clears; retired note leaves `authoritative` | ✓ |
| `asOf` history (HEAD advanced before supersede) revives the retired note | ✓ |
| `changedSince`, `type` filter, content+anchor dedup | ✓ |
| **Arg-injection probe**: `asOf = "$(touch /tmp/PWNED163);HEAD"` | ✓ rejected with a "did not resolve" warning, no shell side-effect (`execFile` + `validateGitRef` + `--end-of-options`) |
| Empty-window combined `asOf`/`changedSince` | ✓ warns |

Two behaviors were **defensible-by-design but untested**; both are now locked with tests + spec text
(no runtime change — changing either risks a worse failure mode):

1. **Type-filter scopes contradiction surfacing.** Contradiction detection runs over the set the
   query already selected (consistent with the existing task/score scoping), so a cross-type
   contradiction is flagged under unfiltered `recall` but not under a `type` filter. Documented on
   `DeterministicContradictionSurfacing`; test `contradiction surfacing reflects the active recall scope`.
2. **Invalidated-without-`invalidatedByCommit` is fail-closed under `asOf`.** A retirement that cannot
   be placed on the commit axis excludes the memory from every `asOf` window rather than revive it
   into a result we cannot prove. Documented on `BitemporalMemoryValidity`; test
   `an invalidated memory with no invalidatedByCommit is excluded from asOf history (fail-closed)`.

Cross-cutting consumer audit (10 files touching the store/type) confirmed **zero breaking changes**:
load/save/CAS pass fields through generically (no whitelist), and every reader uses optional-aware
access (`m.type ?? 'note'`, `!m.invalidatedAt`). The `ChangedSinceRecall` spec wording was tightened
("most-recent first" → recency-as-tiebreak after task relevance, exclusive boundary, fail-closed).

## Verification gates

- `vitest run src examples` → **3,923 passed, 2 skipped** (incl. `bitemporal-memory.test.ts` 28 cases
  + the orient contradiction case).
- `eslint src` → clean. `tsc --noEmit` → clean.
- tools/list payload budget (spec-28): full surface < the bumped 57,000 B ceiling; default
  and `minimal` surfaces unchanged (no new tool).
