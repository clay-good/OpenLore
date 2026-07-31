# Tasks — bound-served-content-trust

## Implementation
- [ ] Provenance class as an additive field where content is assembled for serving:
      `src/core/services/mcp-handlers/memory.ts` (recall), `orient.ts`, `interference-map.ts`
      (foreign branch/PR titles), `spec-store.ts`, and the bundle-import read path.
      Classes: `reviewed-corpus | local-unreviewed | foreign-actor | imported | source-derived`
- [ ] No trust score anywhere: a shape assertion forbids a trustworthiness / safety / confidence
      field on served content metadata
- [ ] No-rewrite guard: a test asserts served bytes equal recorded bytes for content containing
      instruction-shaped text (no sanitizing, stripping, or escaping in the serving path)
- [ ] Unforgeable delimiters + a data-not-instructions statement on composed blocks:
      `src/cli/commands/orient-inject-render.ts`, the Pi `before_agent_start` injection block, and
      the review comment renderer. Framing only — enclosed bytes unchanged
- [ ] Injection-shape check in `src/cli/commands/doctor.ts`: deterministic lexical detection of
      imperative overrides, system/agent/tool impersonation, and decision-steering language;
      advisory finding registered in `enforcement-policy.ts`; never mutates, never gates
- [ ] Every report of the finding states its limits: lexical, incomplete, an aid to review, not a
      guarantee
- [ ] `SECURITY.md` section: what the read-only guarantee covers, that human review is the trust
      boundary, and that unreviewed content is outside it
- [ ] Pi parity: the extension's injection block gets the same framing and provenance treatment as
      the CLI path, per the MCP↔Pi parity invariant

## Verification
- [ ] Each provenance class is exercised by a fixture and appears on the right field; an unreviewed
      memory is never presented with reviewed-corpus authority
- [ ] Byte-identity: instruction-shaped recorded content is served unchanged
- [ ] Delimiter forgery: content containing the delimiter string does not escape the enclosure
- [ ] Injection-shape check fires on fixtures for each shape, leaves files unchanged, and does not
      alter any exit code under the default policy
- [ ] Shape assertion: no trustworthiness / safety / confidence field exists on served content
- [ ] Docs: `SECURITY.md` states the boundary; a doc-claim guard asserts the specs and
      `SECURITY.md` do not describe the read-only guarantee as protecting the agent
- [ ] Full suite green

## Spec
- [ ] `mcp-security` delta: ADD ServedContentIsUntrustedAndCarriesItsProvenance and
      InjectionShapedContentIsFlaggedForReviewNeverRewritten
- [ ] `architecture` delta: ADD TheTrustBoundaryForServedKnowledgeIsHumanReview
- [ ] Cross-reference in the proposal trail: `harden-llm-prompt-injection-boundary` owns the LLM
      prompt paths; `add-secret-redaction-boundary` owns secrets leaving;
      `harden-bundle-import-trust` owns bundle structure; this owns served-content status
