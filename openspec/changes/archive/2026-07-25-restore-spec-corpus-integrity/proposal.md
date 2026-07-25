# Restore spec-corpus integrity: purge the phantom layer, regenerate the overview, dedupe synced decisions

> Status: IMPLEMENTED (2026-07-18). The committed spec corpus is bimodal: a 2026-Q1
> auto-generated layer describing a product OpenLore is not (JWT auth, task/project/membership
> APIs, an "OpenSpec CLI") sits under the genuinely-current hand-written and decision-synced
> layer, and the two have never been reconciled. This change is the one-time repair; the ongoing
> discipline that keeps it repaired is running OpenSpec's own `openspec archive` at ship time (a
> distinct product — OpenLore does not reimplement it), with the decision-syncer scoping fix in the
> sibling `delegate-lifecycle-scope-decision-sync`. OpenLore *sells* spec/code drift detection — its own
> spec corpus must survive its own tools.

## The gap

Verified against `src/` (no matching code exists for any of these):

- **Phantom domains.** `auth/spec.md` (JWT bearer validation — OpenLore has no user auth;
  `mcp-security` lists it as a non-goal), `task/spec.md` (`Createtask`/`Updatetask`/`Listtasks`
  with literal "GIVEN the system is in a valid state / THEN the expected outcome occurs"
  scenarios), `validator/spec.md` (`validateAgainstOpenSpec` against "openapi 3.x"), half of
  `project/spec.md` (owner/membership model; the `ProjectTypeValidation` half is real).
- **Fabricated requirement.** `api/spec.md` `APIAuthentication` mandates Bearer JWT + 401
  responses for an HTTP API that does not exist — contradicting both `overview` ("no user
  authentication") and `mcp-security` (the daemon's optional `x-openlore-token`).
- **Rotten overview.** `overview/spec.md` (generated 2026-04-05 by "openlore v1.0.0") opens
  "OpenSpec is a CLI tool…", lists seven domains that do not exist on disk (Types, Spec, App,
  Import, Chat, Services, Utilities — every link dead), contains `[PARTIAL SPEC — file too large]`
  placeholders, and contradicts its own appended north-star requirement two paragraphs later.
  This file is loaded into agent context via CLAUDE.md's `@openspec/specs/overview/spec.md`.
- **Vacuous auto-gen tops.** The large specs (`analyzer` 6.6k lines, `api`, `cli`, `generator`,
  `openspec` — the last with duplicated `Loadconfig`/`Saveconfig` requirements) lead with hundreds
  of "The system SHALL validates…" requirements with "Unnamed" scenarios, burying the current
  content that starts thousands of lines down.
- **Cross-domain decision spam.** The decision syncer appends an approved decision to *every*
  spec in its `specMap` (`src/core/decisions/syncer.ts`, append at ~`:166`), so
  `LeanDefaultMcpSurface…`, `FlipDefaultMcpSurface…`, `ExcludeSupersededDecisions…` and others
  appear verbatim in `analyzer`, `drift`, `cli`, `config`, and `mcp-handlers` — MCP-preset
  requirements bolted onto the drift spec.

## What changes

One-time corpus repair, reviewed domain by domain:

1. **Delete** `auth`, `task`, `validator` specs and the phantom half of `project`; delete the
   `APIAuthentication` requirement and the other phantom `api` requirements. Deletions are listed
   in the change so `openlore drift`'s mappings are updated in the same PR.
2. **Rewrite `overview/spec.md` by hand** (not regenerate-with-LLM): correct purpose, the real
   domain table (the 14 surviving domains, live links), the real architecture (substrate, two
   faces, six capability families), keeping the north-star requirement and decision block intact.
3. **Prune the vacuous auto-gen tops** of `analyzer`/`api`/`cli`/`generator`/`openspec`/`drift`:
   a requirement whose scenario is the literal "valid state → expected outcome" template and whose
   subject has no matching symbol in `src/` is deleted; auto-gen requirements that DO describe real
   code (e.g. `drift`'s `Getgitdiff`) are kept and tightened. Every deletion is itemized in the PR.
4. **Dedupe synced decisions to their owning domain**: each cross-domain duplicate keeps one
   canonical copy (the domain whose subject it governs) and the copies elsewhere are replaced by a
   one-line pointer. (The syncer behavior fix — scoping future appends — lives in
   `delegate-lifecycle-scope-decision-sync`.)
5. **Verification gate for the repair itself:** after the purge, `openlore audit` /
   `audit_spec_coverage` runs clean (no requirement without code, no dead domain links), and a new
   CI check asserts no spec file contains the vacuous-scenario template or a dead domain link.

## Why this is in scope

The corpus is the substrate's governance face; agents read these specs via `get_spec` and
CLAUDE.md. Serving an agent a spec that mandates JWT auth for a product with no HTTP API is the
exact confident-but-wrong failure the epistemic lease exists to prevent — self-inflicted.

## Impact

- `openspec/specs/*` (deletions + rewrites; no source-code behavior change), drift mappings, one
  CI corpus-lint check.
- Specs: `openspec` — 1 ADDED requirement (SpecCorpusContainsOnlyCodeBackedRequirements);
  `overview` — the rewrite itself.
- Risk: deleting a requirement someone depended on — mitigated by the itemized-deletion review and
  git history; the phantom layer has no code to break.
