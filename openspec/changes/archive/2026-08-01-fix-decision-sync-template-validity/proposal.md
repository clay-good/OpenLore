# Fix decision-sync template validity: the syncer must emit schema-valid requirements

> Status: IMPLEMENTED (2026-08-01). The 2026-07-27 corpus repair fixed 39
> requirements that failed `openspec validate` — and every one of them was emitted by the decision
> syncer. The syncer's own template is the defect: it writes requirements the schema rejects, so
> the corpus rots again on every future `openlore decisions --sync`. This change fixes the
> template; the one-time corpus repair has already been applied by hand.

## The gap

All three defect shapes trace to `appendRequirement` / the cross-domain stub writer in
`src/core/decisions/syncer.ts`:

- **No scenario, ever.** The emitted block (`syncer.ts:269-276`) is heading + statement +
  provenance blockquote. The OpenSpec schema requires at least one `#### Scenario:` per
  requirement, so every synced decision adds a validation error to its target spec — 28 of the 39
  repaired requirements were this shape. These errors were what blocked `openspec archive` for
  every "built, blocked on bookkeeping" change.
- **Blind `The system SHALL` prefixing.** `reqText` prepends `The system SHALL ` unless the text
  already starts with exactly "the system shall" (`syncer.ts:267`) — a `proposedRequirement`
  phrased "The orient command SHALL …" becomes "The system SHALL The orient command SHALL …".
  Three such double-prefix glitches were repaired by hand.
- **Cross-domain stubs are not requirements.** For a decision whose canonical statement lives in
  another domain, the syncer writes a `### Requirement:` heading whose body is only "The
  canonical statement of this decision lives in the `X` domain — see …" — no SHALL, no scenario;
  11 of the 39. The repaired form (a normative deferral sentence plus a pointer scenario) is now
  in the corpus; the syncer must emit that form.

## What changes

- **The template emits a valid requirement.** The synced block gains a minimal deterministic
  scenario derived from the decision (no LLM): a `#### Scenario:` whose THEN restates the
  requirement statement as an observable outcome.
- **Prefixing becomes grammar-aware.** The `The system SHALL` prefix is applied only when the
  proposed requirement does not already contain a SHALL/MUST clause with its own subject.
- **Stubs use the repaired cross-reference form.** The cross-domain writer emits the normative
  deferral sentence ("This domain SHALL conform to the canonical statement of decision `<id>` …")
  plus the pointer scenario — the exact shape now in the corpus — keeping the requirement-name
  dedupe key unchanged.
- **The syncer validates what it writes.** After appending, the syncer parses its own emitted
  block against the requirement schema (heading + SHALL + ≥1 scenario) and fails the sync with a
  named error rather than persisting an invalid spec — the writer-side guard the
  `harden-openspec-writer-fidelity` sibling asks for at the file level, applied to this template.

Dedup behavior is unchanged: the `> Decision recorded: <id>` marker stays the append key, so
already-synced decisions (including all 39 hand-repaired ones) are never rewritten.

## Impact

- Affected specs: `openspec`
- Affected code: `src/core/decisions/syncer.ts` (`appendRequirement`, the cross-domain stub
  writer), `src/core/decisions/syncer.test.ts`
- Sibling: `harden-openspec-writer-fidelity` (writer-level validation and merge fidelity —
  broader scope, named, not duplicated)
