# Service contract certification: schema-level breaking changes, joined to the consumers they strand

> Status: PROPOSED (2026-07-27, field research sweep — `FIELD-RESEARCH-2026-07.md`). Certify the
> *interface schema* layer (OpenAPI, protobuf, GraphQL SDL) the way `certify_public_surface`
> certifies code exports: a deterministic rule-table verdict per changed schema element — then do
> the join no schema-diff tool can: name the in-index consumers each breaking change strands, via
> the shipped cross-service HTTP topology. Prior art: the open schema-diff ecosystem (oasdiff's
> classified change rules for OpenAPI, buf's breaking-change checks for protobuf,
> graphql-inspector for SDL) proves the closed-rule-table approach; the borrow is the concept of
> a closed deterministic rule table, not any tool's rule set, plugin system, or registry.

## The gap

- `certify_public_surface` answers "did my diff break my consumers' *code-level* contract"
  (exports, signatures). But services increasingly bind through **schema files** — an OpenAPI
  document, `.proto` definitions, a GraphQL SDL — and those are opaque to OpenLore today: a
  removed operation, a field turned required, or a narrowed type ships with no structural signal
  at all.
- The shipped `crossServiceHttp` projection already maps client call-sites → server routes,
  within and across federated repos. That graph knows *who consumes what*. Standalone schema-diff
  tools know *what broke* but have no consumer graph. Nobody joins the two — and the join is
  what turns "breaking change detected" into "breaking change that strands these 3 call sites in
  repo B, reached by these tests".

## What changes

- **One new tool + CLI, `certify_service_contract [--base <ref>]`** (`full` preset, family
  `change`). With no base ref: the current contract surface (operations/messages/types per
  discovered schema file). With a base ref: a verdict for the working-tree diff.
- **Discovery is deterministic:** OpenAPI documents (by `openapi:` root key), protobuf (`.proto`),
  GraphQL SDL (`.graphql`/`.gql`, `schema` blocks) inside the analyzed corpus. Discovered files
  and *undiscovered contract-like candidates* are both listed, so scope is visible.
- **Classification is a closed rule table**, one verdict per changed element:
  `breaking` (removed operation/field/enum value, added required field/param, narrowed type,
  changed wire number), `dangerous` (deprecation, widened response, added enum value consumed in
  a closed match), `non-breaking` (additive optional). A change the table cannot PROVE
  compatible is `potentially-breaking`, never silently safe — the same conservative construction
  as `certify_public_surface`, restated in the output.
- **The consumer join:** each `breaking`/`dangerous` element is matched to in-index consumers —
  route-keyed client call sites from the cross-service HTTP graph (federated repos included by
  stable id), plus imports of generated-client modules where the generator target is declared in
  config. Each stranded consumer carries file:line and the reaching tests (`select_tests`
  composition). External/unindexed consumers are disclosed as a known-unknowable boundary,
  never implied absent — verbatim the `certify_public_surface` discipline.
- **Honesty contract:** an unparseable or partially-parsed schema yields `not-assessed` for its
  elements with the parse failure disclosed — never an empty "no changes". Dialect features
  outside the closed rule table (e.g. OpenAPI `callbacks`, proto custom options) are enumerated
  as unassessed element classes per file.
- **Deliberately NOT borrowed / NOT built:** registry/network fetches (schemas are read from the
  working tree and `--base` via git only); runtime schema introspection; GraphQL federation
  composition; client/server code generation; any tool's output format or plugin ecosystem; no
  LLM.

## Why this is in scope

This is the third face of one certification discipline — code exports (`certify_public_surface`),
newly-opened paths (`change_impact_certificate`), and now declared interface schemas — sharing
the conservative-verdict construction, the consumer-join differentiator, and the disclosed-
boundary contract. It rides two shipped substrates (cross-service HTTP topology, git-based base
resolution via the shared `resolveBaseRefDisclosed` helper) and adds exactly one deterministic
new piece: the rule table.

## Impact

- Files: schema readers (OpenAPI/proto/SDL — parse to a normalized element model), the closed
  rule table + differ, consumer join over the http-endpoint projection + generated-client
  imports, handler + CLI command, tool-contract classification, presets/docs.
- Specs: `analyzer` — 1 ADDED requirement; `mcp-handlers` — 1 ADDED requirement.
- Tool surface: +1 tool in `full` preset only; adjacent-tool cross-references name
  `certify_public_surface` (code contract shape) and `change_impact_certificate` (paths into
  surfaces) per NoRedundantConclusions.
- Risk: dialect breadth (mitigated: closed table + per-file unassessed-class disclosure);
  route-key mismatch producing a missed consumer (mitigated: the boundary statement covers
  unmatched consumers; the join only ever ADDs evidence); schema files outside the analyzed
  corpus (mitigated: discovery scope is printed, config include patterns apply).
