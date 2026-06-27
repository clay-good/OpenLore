# cli spec delta

## ADDED Requirements

### Requirement: ReviewCommandRendersADeterministicChangeBriefing

The CLI SHALL provide an `openlore review` command that, for a `base..head` git range, composes the
existing deterministic analyses — structural diff, blast radius, and spec/ADR/anchored-memory drift —
into a single conclusion-shaped briefing. The command SHALL support `--base <ref>` (default: resolved
via the standard fallback chain requested → main → master → HEAD~1), `--head <ref>` (default: working
tree), and `--format markdown|json` (default: `markdown`). The briefing SHALL be a briefing (named
risks, counts, and the tests to run), never a graph dump, and SHALL invoke no LLM and add no new
structural computation beyond the analyses it composes.

#### Scenario: A change is briefed for human review

- **GIVEN** a repository with an analysis index and a diff that removes a symbol with live callers
  and changes another symbol's signature
- **WHEN** the user runs `openlore review --base main`
- **THEN** the command emits a markdown briefing naming the removed and signature-changed symbols,
  their stale callers, the hubs and layers crossed, the tests to run, and any governing decision or
  spec the change makes stale

#### Scenario: JSON output for programmatic consumers

- **GIVEN** the same change
- **WHEN** the user runs `openlore review --base main --format json`
- **THEN** the command emits the composed briefing as JSON on stdout, with all human-readable output
  redirected to stderr

### Requirement: ReviewDegradesHonestlyWhenItCannotCompute

When `openlore review` cannot compute a complete briefing — no analysis index, a base ref that is
unreachable (for example, a shallow CI checkout), or no git range — it SHALL state in the briefing
what it could not compute and why, and SHALL NOT emit a misleading empty or partial briefing as if it
were complete.

#### Scenario: Missing index is disclosed, not hidden

- **GIVEN** a repository with no analysis index
- **WHEN** `openlore review` is run
- **THEN** the briefing states that no index is present and that `openlore analyze` is required,
  rather than reporting zero structural changes

#### Scenario: Unreachable base on a shallow checkout is disclosed

- **GIVEN** a shallow checkout where the requested base ref is not present
- **WHEN** `openlore review --base <ref>` is run
- **THEN** the briefing states that the base was unreachable and which fallback (if any) was used

### Requirement: PrReviewActionPostsOneStickyAdvisoryComment

The project SHALL ship a bundled GitHub Action (and a copy-paste `pull_request` workflow) that runs
`openlore review` for the pull request's `base..head` range and posts the briefing as a single sticky
PR comment, identified by a hidden marker. On the first run for a PR it SHALL create the comment; on
every subsequent run it SHALL update that same comment in place rather than posting a new one. The
Action SHALL be advisory by default and exit 0 (it informs, it does not fail the check). A repository
MAY opt into failing the job on configured high-severity findings, reusing the
`.openlore/config.json` block-pattern convention defined for the blast-radius hook; blocking SHALL
never be the default posture.

#### Scenario: Sticky comment is updated, not duplicated

- **GIVEN** the OpenLore review Action installed on a repository
- **WHEN** a pull request receives a first push and then a second push
- **THEN** the first push creates one review comment and the second push updates that same comment in
  place, leaving exactly one OpenLore review comment on the PR

#### Scenario: Advisory by default

- **GIVEN** the Action installed with default configuration
- **WHEN** a pull request introduces a high-blast-radius change
- **THEN** the briefing is posted and the check exits 0 (the PR is not blocked)

#### Scenario: Opt-in gating fires only on its configured pattern

- **GIVEN** a repository configured to fail the job when a change orphans a governing decision
- **WHEN** a pull request orphans a governing decision
- **THEN** the job fails; and for any other high-blast-radius change it remains advisory
