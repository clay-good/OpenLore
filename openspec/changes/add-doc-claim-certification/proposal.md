# Certify documentation claims against the graph: the repo's own guard, generalized

> Status: PROPOSED (2026-07-27, substrate-whitespace sweep). OpenLore already runs this check on
> itself — by hand, one hardcoded assertion at a time. Prior art for the category: AST-anchored
> documentation-drift governance (e.g. https://github.com/pallaprolus/drift-vscode) and
> signature-validating doc drift detectors; all of them check *doc blocks next to code*, none
> resolves *prose claims about the system* against a call graph.

## The gap

`src/doc-claim-sync.test.ts` is a hand-written test that pins README badges, a documented language
count, a test-count floor, and package metadata to the code that makes them true
(`doc-claim-sync.test.ts:51`, `:80`, `:100`). It exists because those claims silently rotted. It is
also the whole mechanism: every new documented claim needs a new bespoke assertion by a human who
remembers to write it. Nothing checks the hundreds of other claims in `README.md`, `docs/`, and
every proposal — a named CLI flag, an MCP tool name, a `file.ts:line` citation, a documented
function that no longer exists.

This matters twice over for OpenLore specifically. Its docs are consumed by *agents*, so a stale
documented flag becomes an agent's failed command. And the substrate already holds the ground
truth for most of these claims — the symbol table, the export surface, the tool registry, the
file tree — it just never reads its own documentation.

## What changes

**`certify_doc_claims`** (`--preset full`; CLI `openlore certify-docs [--path <glob>] [--json]`):
extract machine-checkable claims from Markdown and resolve each against the substrate.

The claim vocabulary is **closed and syntactic** — a claim is extracted only when its shape is
unambiguous, never inferred from prose meaning:

| Claim | Extracted from | Resolved against |
|---|---|---|
| symbol exists | a backticked identifier matching a declared symbol form | the symbol table |
| file/path exists | a path-shaped token or markdown link target | the file tree |
| line citation | `path.ts:123` | file length, and whether the cited line is still inside the named symbol's span |
| CLI flag / command exists | a fenced command invoking this repo's own binary | the command registry |
| tool exists | a name matching a registered MCP tool form | the tool definitions |

Each claim returns `holds`, `refuted` (with the counter-evidence: the symbol that no longer
exists, the file that moved, the line now outside the span), or `uncheckable` (the shape matched
but the subject is external, e.g. another project's flag) — and `uncheckable` is a first-class,
counted outcome, not a silent skip. Symbol-identity continuity is honored: a documented symbol
that was renamed is reported as **renamed, with its new name**, not as missing.

Deliberately NOT built: any judgment of prose accuracy, tone, or completeness (no LLM anywhere in
this path); documentation generation or rewriting; docstring/JSDoc signature checking, which is a
linter's job and a different anchor; and any default gating — this is advisory, with one
registered finding code (`doc-claim-refuted`) an operator may opt into via `enforcement.policy`
exactly like every other finding.

## Why this is in scope

The honesty contract is the product's core claim, and documentation is the one surface where
OpenLore currently has no way to keep it. The capability is a pure join of artifacts the substrate
already owns, it dogfoods immediately (the bespoke test becomes the first conforming client, and
the 138 files in `openspec/changes/` become checkable), and it serves the same conclusion shape as
`verify_claim` — one level up, on prose instead of structure.

## Impact

- Touches: a new handler + CLI command; readers for the file tree, symbol table, command registry,
  and `TOOL_DEFINITIONS`; one finding code registered in `FINDING_CODE_REGISTRY`.
- Tool surface: +1 tool in `--preset full` only; family `verify`; `conclusion` class; cross-
  references `verify_claim` (structural claims) and `check_spec_drift` (spec↔code).
- Specs: `mcp-handlers` — 1 ADDED (DocumentationClaimsAreCertifiedAgainstTheSubstrate).
- Risk: false refutations from over-eager extraction (mitigated: the vocabulary is closed and
  syntactic, and an ambiguous match is `uncheckable`, never `refuted` — the failure mode is
  under-claiming); noise on repos documenting external tools (mitigated: same — external subjects
  resolve to `uncheckable`, counted and disclosed).
