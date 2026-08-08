# Tasks — bound-served-content-trust

> Status: BUILT (2026-08-08). Proof: 361 test files passed (6,889 tests passed, 2 skipped),
> plus lint, typecheck, build, strict OpenSpec validation, and scoped drift verification for the
> `mcp-security` and `architecture` domains.

## Implementation
- [x] Provenance class as an additive field where content is assembled for serving:
      `src/core/services/mcp-handlers/memory.ts` (recall), `orient.ts`, `interference-map.ts`
      (foreign branch/PR titles), `spec-store.ts`, and the bundle-import read path.
      Classes: `reviewed-corpus | local-unreviewed | foreign-actor | imported | source-derived`
- [x] No trust score anywhere: a shape assertion forbids a trustworthiness / safety / confidence
      field on served content metadata
- [x] No-rewrite guard: a test asserts served bytes equal recorded bytes for content containing
      instruction-shaped text (no sanitizing, stripping, or escaping in the serving path)
- [x] Unforgeable delimiters + a data-not-instructions statement on composed blocks:
      `src/cli/commands/orient-inject-render.ts`, the Pi `before_agent_start` injection block, and
      the review comment renderer. Framing only — enclosed bytes unchanged
- [x] Injection-shape check in `src/cli/commands/doctor.ts`: deterministic lexical detection of
      imperative overrides, system/agent/tool impersonation, and decision-steering language;
      advisory finding registered in `enforcement-policy.ts`; never mutates, never gates
- [x] Every report of the finding states its limits: lexical, incomplete, an aid to review, not a
      guarantee
- [x] `SECURITY.md` section: what the read-only guarantee covers, that human review is the trust
      boundary, and that unreviewed content is outside it
- [x] Pi parity: the extension's injection block gets the same framing and provenance treatment as
      the CLI path, per the MCP↔Pi parity invariant

## Verification
- [x] Each provenance class is exercised by a fixture and appears on the right field; an unreviewed
      memory is never presented with reviewed-corpus authority
- [x] Byte-identity: instruction-shaped recorded content is served unchanged
- [x] Delimiter forgery: content containing the delimiter string does not escape the enclosure
- [x] Injection-shape check fires on fixtures for each shape, leaves files unchanged, and does not
      alter any exit code under the default policy
- [x] Shape assertion: no trustworthiness / safety / confidence field exists on served content
- [x] Docs: `SECURITY.md` states the boundary; a doc-claim guard asserts the specs and
      `SECURITY.md` do not describe the read-only guarantee as protecting the agent
- [x] Full suite green

## Spec
- [x] `mcp-security` delta: ADD ServedContentIsUntrustedAndCarriesItsProvenance and
      InjectionShapedContentIsFlaggedForReviewNeverRewritten
- [x] `architecture` delta: ADD TheTrustBoundaryForServedKnowledgeIsHumanReview
- [x] Cross-reference in the proposal trail: `harden-llm-prompt-injection-boundary` owns the LLM
      prompt paths; `add-secret-redaction-boundary` owns secrets leaving;
      `harden-bundle-import-trust` owns bundle structure; this owns served-content status
