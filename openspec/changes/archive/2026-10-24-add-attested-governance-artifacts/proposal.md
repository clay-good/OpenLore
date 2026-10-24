# Attested governance artifacts: signed certificates, tamper-evident decision history

> Status: PROPOSED (2026-07-27, field research sweep — `FIELD-RESEARCH-2026-07.md`). Make the
> governance face's *outputs* trustworthy at a distance: an emitted certificate becomes an
> in-toto-style signed statement a downstream gate can verify without re-running analysis, and
> the decision store's status history becomes hash-chained so tampering is detectable. Prior
> art: the in-toto attestation envelope (ITE-6 statement + DSSE signing, https://in-toto.io/)
> — the borrow is the envelope shape and a repo-local key only, none of the surrounding
> supply-chain infrastructure.

## The gap

- `change_impact_certificate`, `certify_public_surface`, and `openlore review` emit verdicts as
  plain JSON/Markdown. A downstream consumer (CI gate, merge queue, another repo in the
  federation) that wants to trust "this diff was certified against this graph" has exactly one
  option: **re-run the analysis itself**. The verdict carries no binding to the diff it certified
  or the graph state it was computed from that anyone can verify after the fact.
- The decision store's status transitions are guarded at write time (the shipped shared
  transition table locks all four promotion doors), but the *history* is mutable at rest: a
  direct file edit that flips `rejected` → `approved` after the fact is undetectable, and
  `verify_claim decision-current` would faithfully report the tampered state as authoritative.
  For teams adopting the commit gate in regulated settings, "the gate's own ledger can be
  silently rewritten" is a real objection.
- The adjacent proposal `harden-bundle-import-trust` covers the *import* direction (is this
  bundle authentic?). Nothing covers the *emit* direction: is this verdict authentic?

## What changes

- **Opt-in attestation on emitted certificates.** `openlore impact-certificate --attest`,
  `certify-public-surface --attest`, and `review --attest` wrap the existing verdict, unchanged,
  in a statement whose subject is the content digest of the certified diff plus the graph
  fingerprint it was computed against, with the OpenLore version as producer — signed with a
  repo-local ed25519 key via `node:crypto` (the same primitive `harden-bundle-import-trust`
  selects; shared key config `attestation.privateKeyPath` / `trustedSigners`). A new
  `openlore verify-attestation <file>` checks signature, subject-digest match against a supplied
  diff, and graph-fingerprint match against the local index, reporting each check separately.
- **Hash-chained decision history.** Each decision status transition appends a ledger entry
  carrying the hash of the previous entry (per decision id). `verify_claim decision-current`
  gains an additive `historyIntact: true | violated | not-chained` field: `violated` when the
  chain does not replay to the current state, `not-chained` for pre-change stores (never a
  retroactive claim). Chain verification is a local hash replay — no signing required for this
  half, no infrastructure.
- **Honesty contract.** Attestation binds *what was certified*, not *that the verdict is
  correct* — the statement's predicate says so verbatim. An unattested certificate is exactly
  today's output, byte-identical. A missing/invalid key fails the `--attest` invocation loudly
  (never emits an unsigned artifact labeled attested).
- **Deliberately NOT borrowed / NOT built:** keyless signing and transparency logs (network
  services — OpenLore is local-first; the DSSE envelope leaves room for a user to countersign
  externally); SLSA build-level provenance claims (OpenLore attests analysis outputs, not
  builds); any key distribution/management beyond a config path; attestation of navigation
  tool outputs (certificates only — the artifacts a downstream gate consumes).

## Why this is in scope

The governance face's value is that its conclusions can be *relied on*; reliance across a
process boundary (CI, teammates, federation) requires integrity the artifact itself carries.
Both halves are deterministic, local, additive, and fail-loud — a few dozen lines of
`node:crypto` over shapes that already exist, closing the "chain of custody" gap the 2026
agent-governance field treats as table stakes.

## Impact

- Files: a small attestation module (statement assembly, DSSE sign/verify, key load), `--attest`
  wiring on three CLI commands + `verify-attestation`; ledger append + chain replay in the
  decision store; additive `historyIntact` in claim verification; config types.
- Specs: `cli` — 1 ADDED requirement; `mcp-security` — 1 ADDED requirement.
- Tool surface: no new MCP tool (CLI flags + one CLI command); one additive `verify_claim`
  response field.
- Risk: key loss (mitigated: attestation is opt-in and additive — losing the key loses only the
  ability to sign new statements); false confidence in attested-but-wrong verdicts (mitigated:
  the predicate wording and `verify-attestation` output both scope the claim to binding, not
  correctness); ledger growth (bounded: one small entry per transition, same store).
