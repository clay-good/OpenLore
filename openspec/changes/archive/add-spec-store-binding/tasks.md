# Tasks — Spec-store binding

> Status: IMPLEMENTED (2026-06-21). First of three in `SPEC-STORE-INTEGRATION.md`. Builds on
> `add-multi-repo-federation`. Decision `c6e36101` recorded before the config shape + resolution
> contract.

## 1. Binding configuration
- [x] Extend `OpenLoreConfig` with an optional, additive `specStore` block: `{ name, path,
      targets: string[], references?: string[] }`. Absent block ⇒ unchanged single-repo behavior.
      → `src/types/index.ts` (`SpecStoreConfig`). `readOpenLoreConfig` left untouched (no new throw).
- [x] Validate the block: reject duplicate target/reference names, empty name/path, and a
      self-referential store path; never throw for a missing binding (it is optional).
      → `validateSpecStoreConfig()` in `spec-store.ts` (returns findings, does not throw).
- [x] Test: config with/without `specStore`; invalid blocks produce a `binding-invalid` finding with a
      stable code. → `spec-store.test.ts` (validateSpecStoreConfig block).

## 2. Name resolution onto the federation set
- [x] Resolve declared `targets`/`references` by name against the federation registry
      (`.openlore/federation.json`); resolved targets carry their live index state.
      → `resolveTarget`/`resolveReference` reuse `listRepos` + `evaluateRepoState`.
- [x] Unresolvable names resolve to a finding (`target-unresolved` / `reference-missing`), not an error.
- [x] Test: two targets resolve; one unregistered target yields exactly one `target-unresolved`
      finding and the others still resolve. → `spec-store.test.ts`.

## 3. Binding health check (conclusion-shaped, read-only)
- [x] Compute a single report: per target — resolved? index present? index fresh vs working tree?
      per reference — present? plus the store path's presence and any invalid-binding findings. Each
      finding has a stable code and a pasteable remediation. → `handleSpecStoreStatus()`.
- [x] The check is read-only and never blocks. Infrastructure failure degrades to a finding, never a
      throw (the CLI also wraps the call defensively and exits 0).
- [x] Test: healthy binding ⇒ zero findings; stale target index ⇒ one `index-stale`; missing reference
      ⇒ one `reference-missing`; missing store path ⇒ one `store-path-missing`; unindexed target ⇒
      `index-missing`. → `spec-store.test.ts`.

## 4. Surfaces (MCP tool + CLI), machine contract
- [x] MCP tool `spec_store_status` classified `conclusion` in `tool-contract.ts`; registered in
      `tool-dispatch.ts`, `TOOL_DEFINITIONS`, `tool-driver.ts`; added to the opt-in `federation` preset;
      kept OUT of `minimal`/`navigation`/`memory`. Full surface 60 → 61 (payload ceiling 61k → 62k).
- [x] CLI `openlore spec-store status [--json]` emitting documented finding codes; read-only, exits 0.
      → `src/cli/commands/spec-store.ts`, registered in `src/cli/index.ts`.
- [x] Test: tool output is conclusion-shaped (`assertConclusionShape`); `--json` finding codes are
      stable; `tool-contract.test.ts` + `tool-driver.test.ts` + `mcp-presets.test.ts` cross-checks pass.

## 5. Docs
- [x] Documented the binding, health check, finding codes, and read-only posture in the `mcp-handlers`
      and `cli` specs, the CLAUDE.md tool table, and the dogfood report
      (`DOGFOOD-spec-store-binding.md`). Tracked spec files under the spec directory need `git add -f`.
