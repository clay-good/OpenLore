# Harden federation freshness: baseline the empty fingerprint, degrade a corrupt registry

> Status: SHIPPED (2026-07-19). `evaluateRepoState` now returns an explicit `unbaselined` state for
> an empty-fingerprint entry with a live index (never a false forever-`indexed`); `federation_status`
> adopts the live hash on observation (`adoptEmptyFingerprints`) so later drift is caught as `stale`,
> and degrades a corrupt registry to a `registry-unreadable` conclusion instead of throwing;
> `spec_store_status` surfaces the `index-unbaselined` finding. Consultability gates in the resolver,
> fleet-memory, working-set, and the CLI treat `unbaselined` as consultable-but-labeled (no regression
> for pre-analyze registrations that were previously `indexed`). Two findings, one theme — the federation
> surface must be as honest about its own staleness as the tools it reports on. A repo registered
> before its first `openlore analyze` keeps an empty stored fingerprint forever, so the staleness
> check can never fire and it reports `indexed`/consultable as its index drifts arbitrarily. And
> `federation_status` throws raw on a corrupt registry file instead of degrading to the
> conclusion-shaped finding its sibling `spec_store_status` already returns.

## The gap

- **The empty fingerprint is a permanent staleness blind spot.** A repo registered before its
  first analyze is stored with `fingerprint: ''` (`src/core/federation/registry.ts:138`,
  `readRepoFingerprint(absRepo) ?? ''` — deliberately allowed, per the `addRepo` docblock). The
  staleness check in `evaluateRepoState` is gated on a truthy stored fingerprint:
  `if (entry.fingerprint && live !== entry.fingerprint) return 'stale'` (`:175`), so an
  empty-fingerprint entry with a now-present index always returns `indexed` (`:169-177`). The code
  comment (`:173-174`) says "adopt the live hash on next refresh" — but the only refresh path is a
  manual `federation add` re-run (`:142-143`; its sole caller is the CLI at
  `src/cli/commands/federation.ts:35`). Nothing ever writes the real hash back automatically, so
  the promised refresh never happens: the entry reports `indexed` and consultable FOREVER while
  its index drifts arbitrarily. Both status surfaces inherit the blind spot —
  `federation_status` (`src/core/services/mcp-handlers/federation.ts:14-25`, counting such an
  entry as "indexed and consultable" in its note, `:31-33`) and `spec_store_status`, whose
  `index-stale` finding (`src/core/services/mcp-handlers/spec-store.ts:220-226`) fires off the
  same gated check.
- **A corrupt registry throws raw out of `federation_status`.** `handleFederationStatus` calls
  `listRepos(absDir)` with no try/catch (`federation.ts:13`); a corrupt or wrong-shaped
  `.openlore/federation.json` throws from `loadRegistry` (`registry.ts:80-88`) and propagates
  unchanged through dispatch (`src/core/services/tool-dispatch.ts:114` — "propagates any handler
  error unchanged" — the `dispatchTool` body, `:123-`, has no wrapper) to the transport, instead
  of degrading to a conclusion. Its sibling handles the identical failure honestly:
  `spec_store_status` catches the same throw and returns a `registry-unreadable` finding with
  remediation (`spec-store.ts:300-309`).

## What changes

- **Adopt-the-live-hash-on-observation.** When a status/consult path computes the live fingerprint
  for a repo whose stored fingerprint is empty and finds an index present, it writes the live hash
  back to the registry (the atomic `saveRegistry` path), making the comment at `registry.ts:173-174`
  true — the baseline is established the first time the index is observed. Additionally (or
  alternatively for repos analyzed while registered elsewhere), `openlore analyze` completion MAY
  refresh the entry's fingerprint in registries that reference it; the observation-time adoption is
  the required minimum since it needs no cross-repo hook.
- **`unbaselined` is disclosed, never `indexed`.** Until the baseline is adopted, an
  empty-fingerprint entry with a live index reports an explicit `unbaselined` state (with
  remediation: re-run `federation add`, or simply query status to adopt) — never plain `indexed`.
  `federation_status` and `spec_store_status` surface it; `unbaselined` counts as consultable but
  is labeled, so the caller knows staleness cannot yet be assessed.
- **`federation_status` degrades a corrupt registry to a conclusion.** Wrap the `listRepos` call
  exactly as `spec_store_status` does (`spec-store.ts:300-309`): a throw from `loadRegistry`
  becomes a `registry-unreadable`-shaped result with the file path and remediation, never a raw
  transport error.

## Why this is in scope

Federation's whole value is trustworthy cross-repo freshness verdicts; a state machine that can
report `indexed` forever regardless of drift is the exact silent-degradation class this audit
closes, and the throw-vs-finding asymmetry between two sibling status tools is a solved problem
being applied inconsistently. Both fixes are deterministic, surgical, and reuse existing
mechanisms (`saveRegistry`, the `spec_store_status` degradation shape).

## Impact

- Files: `src/core/federation/registry.ts` (`evaluateRepoState` gains `unbaselined`; a
  baseline-adoption helper), `src/core/services/mcp-handlers/federation.ts` (adoption on
  observation + try/catch degradation), `src/core/services/mcp-handlers/spec-store.ts`
  (`unbaselined` finding surfaced); tests in the registry and both handlers' suites.
- Specs: `mcp-handlers` — 2 ADDED requirements (RegisteredRepoFreshnessIsBaselined,
  FederationStatusDegradesToConclusion).
- Risk: low. New `unbaselined` state is additive to `RepoIndexState`; existing `stale`/`unindexed`/
  `missing` verdicts unchanged; the registry write on observation reuses the existing atomic
  write-tmp-then-rename path (`registry.ts:97-104`).
