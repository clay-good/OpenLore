---
status: shipped
date: 2026-07-18
---

# Scope the decision syncer and delegate change lifecycle to OpenSpec

> Status: SHIPPED (2026-07-18, PR #236; status reconciled 2026-07-19). Originally proposed (2026-07-03, e2e audit; rescoped 2026-07-18). The original draft proposed an
> `openlore change archive` / `openlore change list` CLI with a bespoke spec-delta fold engine.
> That re-implements the OpenSpec CLI — a **distinct product** (`@fission-ai/openspec`) OpenLore
> already depends on and uses as its spec-driven-development framework. `openspec archive` already
> "archives a completed change and updates main specs" (folds deltas, moves to `archive/`, with
> `--json` / `--skip-specs` / `--no-validate`); `openspec list --json` already reports the change
> lifecycle. Rebuilding those inside OpenLore is out of scope for a deterministic structural-memory
> substrate. This change is rescoped to the one genuinely OpenLore-native fix and to *adopting* the
> OpenSpec lifecycle we were bypassing.

## The boundary (why this was rescoped)

OpenLore and OpenSpec are two products with one contract:

- **OpenSpec** owns the spec-driven-development **workflow**: authoring change proposals, the
  change→archive lifecycle, folding a change's spec deltas into the main corpus, and
  listing/validating/showing changes and specs. OpenLore consumes this workflow to govern its own
  development.
- **OpenLore** owns **deterministic, locally-computed structural memory from code**: the call
  graph, reachability/impact, symbol-anchored memory and decisions, and code↔spec drift. It
  *generates* OpenSpec-format specs from code and *reads* the OpenSpec corpus — it does not
  reimplement OpenSpec's lifecycle commands.

The original draft crossed that line. Its founding premise — "the delta-merge step does not exist
in this repo" — was wrong: the step exists in `openspec archive`; the repo had simply been doing a
manual `mv` instead of running it. The fix is to run OpenSpec's archive, not to build a second one.

## What changes

1. **Adopt `openspec archive` at ship time** (process, no OpenLore product code). Archiving a
   shipped change is `openspec archive <name>` — it folds the change's ADDED/MODIFIED deltas into
   `openspec/specs/<domain>/spec.md` and moves the directory to `changes/archive/`. Tooling- or
   doc-only changes use `--skip-specs`. The one-time backfill of the ~24 stranded changes whose
   deltas never landed is a batched run of `openspec archive` per change, tracked by the sibling
   `restore-spec-corpus-integrity`.

2. **Scope the decision syncer to one owning domain** (OpenLore-native; the real bug). Today
   `syncDecision` (`src/core/decisions/syncer.ts:133`) loops over *every* `affectedDomains` entry
   and appends the full requirement + Decisions block to each spec, producing verbatim cross-domain
   duplicates (MCP-preset requirements bolted onto the drift, analyzer, and cli specs). The syncer
   SHALL write the full requirement to exactly one owning domain (an explicit `domain` on the
   decision, else the spec-map's best match) and a one-line pointer reference to the other affected
   domains. This is OpenLore's own governance surface (decisions-as-graph-nodes, spec-16); OpenSpec
   has no equivalent.

3. **Record the boundary as an architectural requirement** so OpenLore never re-grows an
   `openlore change` / `openlore archive` / `openlore validate-changes` surface. Change-lifecycle
   management is delegated to OpenSpec by contract.

## Explicitly out of scope (removed from the original draft)

- `openlore change archive` and the bespoke fold engine → **use `openspec archive`.**
- `openlore change list` and machine-readable status front-matter → **use `openspec list --json`**
  (and `openspec status` / `openspec validate`) for lifecycle reporting.
- A CI "implemented-but-unarchived grace period" guard is **not** OpenLore product code; if the
  team wants it, it is a repo CI script that shells out to `openspec list --json`, not a new
  OpenLore capability or MCP tool.

The orphan implementation started for the removed scope (`src/core/changes/spec-fold.ts`,
`change-status.ts`, and their tests, plus the `OPENSPEC_CHANGES_SUBDIR` / `OPENSPEC_ARCHIVE_SUBDIR`
constants) is deleted by this change.

## Impact

- **Code:** decision-syncer scoping (`src/core/decisions/syncer.ts`) + tests. Removal of
  `src/core/changes/**` and the two constants (no external importers; nothing was wired to the
  CLI). No new CLI subcommand, no new MCP tool.
- **Specs:** `architecture` — 1 ADDED requirement (SpecDrivenDevelopmentDelegatedToOpenSpec);
  `openspec` — 1 ADDED requirement (DecisionSyncWritesOneOwningDomain).
- **Risk:** low. The syncer change narrows what is written (one canonical copy + pointers); the
  lifecycle delegation removes code rather than adding it.
