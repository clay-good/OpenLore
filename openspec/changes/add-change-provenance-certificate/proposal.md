# Change provenance certificate: a reproducible record of what a change does, not just who made it

> Status: PROPOSED (2026-10-24, roadmap direction ADR-0035). `openlore certify-provenance` emits a
> deterministic, reproducible, content-addressed certificate of what a change *does* — blast
> radius, surfaces crossed, specs touched and drifted, tests reaching it — shaped to attach to the
> identity/build provenance a repo already produces (in-toto / SLSA). Supersedes and absorbs the
> deferred `add-attested-governance-artifacts`. Trend evidence: supply-chain provenance attests
> identity, not behavior — "signed provenance is an attestation, not proof the signer was honest" —
> and MCP has no standardized audit trail, so teams build their own
> (https://dev.to/traceseal/in-toto-and-slsa-for-ai-agents-what-build-provenance-teaches-us-about-agent-records-4247,
> https://workos.com/blog/everything-your-team-needs-to-know-about-mcp-in-2026,
> https://dzone.com/articles/verifiable-provenance-ai-code).

## The gap

The provenance stack the industry is standardizing on — SLSA, in-toto, C2PA, Sigstore — records
**who and what** produced a change: the signer, the builder, the model, the prompt hash, the human
approval. None of it records **what the change does to the code**. A signed attestation proves the
record came from the claimed source; it does not prove the change is safe, in scope, or consistent
with the spec. As agents gain commit rights and AI-written code shows elevated vulnerability rates,
the missing half is a *semantic* provenance record — one a reviewer, a CI gate, or a downstream
consumer can check without trusting the author's word. OpenLore already computes that content for
its own pending diff (`change_impact_certificate`: blast radius, the paths a change newly opens
into a covered surface, drifted specs, tests to run), but it is an advisory briefing for the author,
not a portable, reproducible, verifiable artifact that travels with the commit and attaches to the
identity attestation.

## What changes

`openlore certify-provenance [--base <ref>] [--format in-toto|json] [--out <path>]` + a
`certify_provenance` conclusion (opt-in `verify` preset) that emits a **semantic change
certificate** for a commit range:

- **Content**: the structural delta (`structural_diff`), blast radius, public-surface verdict
  (`certify_public_surface`), specs touched and any drift, the tests reaching the change
  (`select_tests`), and declared-footprint escapes — each as evidence with its rule, computed over
  the range's base via `resolveBaseRefDisclosed`.
- **Reproducible and content-addressed**: same inputs produce a byte-identical document (reusing
  the seeded-determinism discipline that makes analyze artifacts byte-stable), with a digest, so
  **any consumer can recompute and verify it** — the certificate is checkable, not merely signed.
- **Interoperable, not a new standard**: the document is shaped as an in-toto predicate (a stable
  `predicateType`) so it attaches as a materials/predicate to the SLSA/in-toto attestation the repo
  already produces; the `json` format is the same content standalone. OpenLore emits the document;
  signing stays with the repo's existing Sigstore/cosign flow.
- **Honest boundaries**: unresolved dynamic dispatch, unindexed languages, and a stale index are
  disclosed in the certificate, so its claims are a sound lower bound ("no detected surface break",
  never "safe"); a bad base is fatal.

Deliberately NOT borrowed: identity attestation, the signing/transparency-log infrastructure, and
SBOM generation — those stay with SLSA / in-toto / Sigstore. OpenLore contributes only the semantic
predicate those formats have nowhere to source today.

## Addendum (2026-10-31): the certificate is the session's closing receipt

Source: `CONTRACT-GRAPH-AND-AGENT-LOOP-2026-10.md`. The design note asked for an
`attest_session_delta` that compares the start and end graph of an agent session and yields a
tamper-evident receipt. That is this certificate over the range from the merge-base, so no second
tool. To cover what the note listed, the certificate also folds in, as each ships:

- contract verdicts and parity (`add-service-contract-certification`): changed operations, breaking
  elements, and the parity state after the change;
- architecture-rule violations and import cycles the change introduces, and check-weakening,
  phantom-reference, generated-file, and `secret-added` findings (the `verify_change` 2026-10-31
  addenda);
- decisions anchored to changed or removed symbols, with their freshness verdict (from
  `blast_radius`), so "no ADR was broken or orphaned" is a checked fact, not a claim;
- the session counts from `add-session-structural-ledger`, when a ledger exists for the range.

"Tamper-proof" stays as designed above: the certificate is reproducible and content-addressed, so any
consumer can recompute it and compare digests. A signature, when wanted, is the existing in-toto /
Sigstore layer.

## Why this is in scope

It composes shipped deterministic conclusions into a reproducible, verifiable document — no LLM, no
new crypto, local. It fills the semantic-provenance white space with a format that interoperates
with the standard everyone is adopting, and it answers a question `change_impact_certificate` does
not: that tool briefs *your pending diff* in-session; this emits a *portable, recomputable
attestation* for a landed or landing change that a third party can verify
(`NoRedundantConclusions` — each names the other). It subsumes the deferred
`add-attested-governance-artifacts`, which proposed signed certificates without the interop target
or the recompute-to-verify guarantee.

## Impact

- New: `certify_provenance` handler + `openlore certify-provenance` CLI; a versioned in-toto
  predicate schema; the reproducibility/content-address guarantee. Registered in
  `TOOL_CAPABILITY_FAMILY` (`change` — it reasons about a diff, like its sibling
  `change_impact_certificate`; `verify` is the opt-in preset it ships in, not its capability
  family), classified `conclusion`, cross-referencing
  `change_impact_certificate`; tools/list payload budget re-asserted or bumped.
- Specs: `mcp-handlers` — 1 ADDED requirement.
- Supersedes: `add-attested-governance-artifacts` (archive as superseded).
- Risk: coupling to the in-toto predicate shape as it evolves (mitigated: the shape is versioned
  and the `json` format is independent of it); a false sense of "signed = safe" (mitigated: the
  certificate is recompute-verifiable and states its boundaries as a lower bound, exactly the gap
  identity attestation leaves).
