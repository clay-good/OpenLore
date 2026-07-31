# Config schema validation: typo'd keys disclosed, version drift visible

> Status: SHIPPED (2026-07-18). Implemented as `src/core/services/config-schema.ts` (type-bound
> validator + version check), wired into `readOpenLoreConfig`, and surfaced by `openlore doctor`
> as a `Config schema` check. Deviation from the note below: validation warnings emit to **stderr**
> (honoring quiet/noColor), not stdout — `readOpenLoreConfig` is read by machine-output paths
> (`--json`, `orient`, the MCP JSON-RPC stream), and a warning on stdout would corrupt them. The
> logger's intent (standard, quiet-respecting, deduplicated diagnostics) is preserved.
>
> Original: PROPOSED (2026-07-03, e2e audit). `.openlore/config.json` is parsed with a bare
> `JSON.parse(...) as OpenLoreConfig` — a typo'd key (`pancResponse`, `embeding`) is silently
> dropped and defaults win, and the `version` stamp written at init is never read back, so
> config-schema drift across OpenLore versions is invisible. Deterministic validation at read,
> warnings never hard failures, forward-compatible by construction. No LLM, no network.

## The gap

- **No validation, no unknown-key detection.** `readOpenLoreConfig`
  (`config-manager.ts:77-92`) reads the file and does `JSON.parse(content) as OpenLoreConfig`
  (`:86`) — a type *assertion*, checked by nothing at runtime. A user who writes `pancResponse`
  or `embeding` gets no warning anywhere: the misspelled section is ignored, the default
  (`mode: 'off'`, keyword-only retrieval) silently applies, and the user believes the feature is
  configured. Only JSON *syntax* errors are reported (`:87-90`).
- **The version stamp is write-only.** `getDefaultConfig` writes `version: '1.0.0'`
  (`config-manager.ts:54-56`); no code path reads it back, compares it, or migrates anything. The
  config schema has in fact grown for years (panicResponse, embedding, enforcement, specStore,
  impactCertificate…) while every config on disk still says `1.0.0` — the stamp can neither
  detect an older config under a newer openlore nor a newer config under an older openlore.

This is the config-file instance of a gap the substrate has already closed elsewhere: the decision
store validates on load and quarantines, the index attests integrity — but the file that *governs
all of them* is trusted blindly.

## What changes

**Deterministic schema validation at read, derived from the `OpenLoreConfig` type; disclosure,
never a hard failure.**

- A validator for `OpenLoreConfig` — either a JSON schema generated from the type at build time or
  a hand-maintained structural validator — with a **completeness test binding it to the type**: a
  field added to `OpenLoreConfig` without a validator entry fails CI (guarded-claims rule; the
  mechanism is chosen at implementation, the CI bind is the requirement).
- On read, the validator classifies: **unknown keys** (with a did-you-mean suggestion computed by
  edit distance against known keys — deterministic, no new tuning constant beyond the standard
  distance bound stated in code), **type-mismatched values**, and **version skew**. Findings
  surface as warnings on CLI config reads and in `openlore doctor` — never a hard failure:
  a NEWER config read by an older openlore MUST degrade gracefully (unknown keys disclosed as
  "possibly from a newer version", then ignored — disclose, don't crash), preserving today's
  forward-compat behavior while ending its silence.
- **Version-stamp handling:** the stamp becomes meaningful — bumped when the config schema
  changes; an older-version config is migrated where a deterministic migration exists, otherwise
  explicitly reported ("config written by openlore <X; field F renamed — update it or re-run
  init"); a newer-version stamp triggers the graceful-degradation disclosure above.

## Why this is in scope

The honesty contract says absence is disclosed, never presented as fact — but a typo'd config key
today produces exactly that: the user *asserted* a setting and the system silently behaves as if
they hadn't. Validation derived from the type keeps the claim guarded (CI-bound completeness), the
mechanism deterministic, and the posture advisory — warnings and doctor findings, no new gate, no
behavior change for any currently-valid config.

## Impact

- Files: `src/core/services/config-manager.ts` (validate in `readOpenLoreConfig`), a new
  dependency-light validator module + its type-completeness test, `openlore doctor` surfacing,
  version bump/migration table.
- Specs: `config` — 2 ADDED requirements (ConfigUnknownKeysAreDisclosed, ConfigVersionIsChecked).
- Tool surface: unchanged. `readOpenLoreConfig` has ~45 callers (it is a hub) — validation runs
  once per read and must stay allocation-light; warnings are emitted through the existing logger,
  deduplicated per process so a hub caller does not spam.
- Risk: low. No currently-valid config changes behavior; the only new output is warnings on
  configs that were already being silently misread.
