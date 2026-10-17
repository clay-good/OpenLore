## 1. Shared Composite Contracts

- [x] 1.1 Add typed workflow envelopes for generation and repair, including stable provenance, `complete`/`partial`/`unavailable` receipts, included/omitted section identifiers, remediation follow-ups, and typed error states.
- [x] 1.2 Add deterministic, analysis-fingerprint-bound continuation cursors and tests for partition order, stale-cursor rejection, bounded response size, and absence of silent post-serialization truncation.
- [x] 1.3 Define one closed observation/section vocabulary shared by MCP, Pi, and host-skill conformance tests.

## 2. Generation Preparation

- [x] 2.1 Implement a shared generation-preparation service over the canonical reconciled domain-evidence builder, returning defining/supporting roles, inventories, signatures, relationships, provenance, and completeness without reading spec-state artifacts.
- [x] 2.2 Add deterministic pagination for oversized domains and typed unknown-domain responses that list available domains without falling back to repository-wide evidence.
- [x] 2.3 Add equivalence tests proving generation composite observations match the corresponding atomic evidence and the standalone generator's deterministic domain representation without invoking an LLM.

## 3. Repair Preparation

- [x] 3.1 Implement a shared repair-preparation service that composes the existing spec, mapping provenance, coverage availability, drift, structural changes, and reconciliation observations without assigning semantic dispositions.
- [x] 3.2 Sequence spec and mapping reads before structural diff, build the normalized scope from current domain files plus historical spec/mapping paths, and test deleted and moved files outside current membership.
- [x] 3.3 Preserve Repair when current domain evidence is absent; distinguish possible orphan specs, truly absent specs, unavailable analysis, stale artifacts, and empty recoverable footprints with stable states.
- [x] 3.4 Add mapping-missing/invalid/stale/scoped tests proving unavailable conclusions remain withheld while independent spec and drift evidence remains present.

## 4. MCP Surface

- [x] 4.1 Register `prepare_spec_generation` and `prepare_spec_repair` with machine-readable schemas, structured content, cancellation propagation, and read-only/non-destructive annotations.
- [x] 4.2 Dispatch both tools through the shared composition services and add them to the default and full surfaces while leaving the explicit navigation-only preset narrow.
- [x] 4.3 Add MCP contract, preset-selection, argument-validation, response-budget, and live-data driver coverage for both tools.
- [x] 4.4 Verify existing atomic MCP tools and their response contracts remain backward compatible and usable as receipt-directed follow-ups.

## 5. Pi And Host Skills

- [x] 5.1 Refactor Pi's existing Generate and Repair entry points to call the public composite tools through the daemon and remove their local evidence-composition logic without changing their user-facing names.
- [x] 5.2 Update the supported `openlore-generate` skill and add an `openlore-repair` skill that fetch continuation pages, honor unavailable evidence, use receipt-directed atomic follow-ups, author one spec through native editing, and validate it.
- [x] 5.3 Add a shared protocol checklist and parity tests proving Pi and packaged host skills do not classify files, reconstruct domains, recompute observations, or routinely replay the atomic sequence.
- [x] 5.4 Update installation/generated agent configuration assets so supported hosts receive the thin skills without requiring a provider-specific integration.

## 6. Verification And Documentation

- [x] 6.1 Document the composite MCP workflow, the host-authoring boundary, default/full preset availability, continuation behavior, and the continued role of atomic tools.
- [x] 6.2 Run focused composition, MCP, Pi, skill-installation, and standalone-domain-evidence suites plus typecheck, lint, and build.
- [x] 6.3 Run an end-to-end generic MCP fixture for Generate and Repair, including a large paginated domain and an orphaned spec with a deleted or moved historical file.
- [x] 6.4 Validate the OpenSpec change strictly and run final diff review, addressing every CRITICAL/HIGH finding before handoff.
