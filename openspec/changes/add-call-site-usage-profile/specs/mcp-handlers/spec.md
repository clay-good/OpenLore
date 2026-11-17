# mcp-handlers spec delta

## ADDED Requirements

### Requirement: CallSiteUsageProfileIsDescriptive

`orient` SHALL carry a `callProfile` for each target function whose resolved call sites meet the
existing style evidence floor: counts of argument number, named options passed, result use, and
enclosing `try`, with up to three example call sites as `file:line`. `blast_radius` SHALL carry the
same profile for a changed function whose parameter list differs from the merge-base. The profile
SHALL report observed counts only, never a correctness judgment. Below the floor, or in an
unsupported language, the field SHALL be absent. A site that cannot be counted for a facet, or that
is reached only through a synthesized or name-only edge, SHALL be disclosed as a count and not
guessed.

#### Scenario: The agent sees how the codebase calls the function

- **GIVEN** a function with twenty resolved call sites, seventeen that pass `timeout` and all awaited
- **WHEN** `orient` runs for a task that targets it
- **THEN** `callProfile` reports `timeout` in 17/20 and awaited in 20/20, with example call sites

#### Scenario: Thin evidence yields no profile

- **GIVEN** a function with two call sites
- **WHEN** `orient` runs
- **THEN** the function has no `callProfile`

#### Scenario: A signature change shows the callers' shape

- **GIVEN** a diff that adds a required parameter to a function with enough call sites
- **WHEN** `blast_radius` runs
- **THEN** the changed function carries `callProfile`, and a call site with spread arguments is
  counted as uncountable for argument number
