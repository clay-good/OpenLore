# mcp-handlers spec delta

## ADDED Requirements

### Requirement: GroundingCertificateOnFreshFacts

When `recall` or `orient` returns a `fresh` memory or structural fact, the response SHALL attach a
compact grounding certificate: `{ symbol, filePath, lineSpan, contentHash }`, where `contentHash` is
the hash of the exact source span OpenLore already compared to produce the `fresh` verdict. The
certificate is evidence behind the verdict, not a new computation, and lets a caller confirm currency
without re-reading the source. A `drifted` or `orphaned` fact SHALL NOT carry a certificate.

#### Scenario: A fresh fact carries a verifiable certificate

- **GIVEN** a `fresh` memory returned by `recall`
- **WHEN** the response is produced
- **THEN** it includes `{ symbol, filePath, lineSpan, contentHash }`, and an independent hash of the
  cited span equals the certificate's `contentHash`

#### Scenario: Non-fresh facts carry no certificate

- **GIVEN** a `drifted` or `orphaned` fact
- **WHEN** the response is produced
- **THEN** no grounding certificate is attached

### Requirement: VerifiedCurrentMarker

A fact carrying a `fresh` grounding certificate SHALL be marked `verified-current`, signaling that the
underlying span is provably unchanged since analysis and re-reading it is unnecessary. A `drifted` or
`orphaned` fact SHALL NOT be marked `verified-current`. This marker is the token lever: it converts an
advisory verdict into an actionable permission to skip re-derivation.

#### Scenario: Only fresh facts are verified-current

- **GIVEN** a mix of `fresh`, `drifted`, and `orphaned` facts in a recall response
- **WHEN** the response is produced
- **THEN** exactly the `fresh` facts are marked `verified-current`

### Requirement: BudgetAwareTieredRecall

`recall` SHALL accept an optional `tokenBudget` and, when given, return the highest grounding-density
facts first: a `core` tier (`verified-current` facts) always returned at least one item, then the
recall-on-demand tail as the budget allows. Grounding density SHALL be ordered by the
`verified-current` marker first (a fact with a grounding certificate is maximally grounded), preserving
the existing relevance order within each tier; the budget SHALL be a caller-supplied cap, not a hidden
weight or new tuning constant. When the budget truncates the tail, the response SHALL report what was
withheld — no silent cap.

> Implementation note: ordering uses the `verified-current` grounding signal rather than the
> hub/chokepoint/volatile salience classifiers (decision `61c2ea7d`); salience-label ordering is a
> noted future refinement. `orient` is excluded until it surfaces memory (it has no recall surface
> today).

#### Scenario: A tight budget returns core and reports the remainder

- **GIVEN** a `recall` call with a `tokenBudget` smaller than the full result
- **WHEN** the response is produced
- **THEN** the `core` tier is returned and the response states the count of withheld facts

#### Scenario: No budget returns the full result

- **GIVEN** a `recall` call with no `tokenBudget`
- **WHEN** the response is produced
- **THEN** the full result is returned with no truncation
