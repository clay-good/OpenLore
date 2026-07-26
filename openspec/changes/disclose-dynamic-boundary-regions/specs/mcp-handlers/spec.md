# mcp-handlers spec delta

## ADDED Requirements

### Requirement: ConclusionsDiscloseDynamicBoundariesInScope

Every conclusion whose soundness depends on reachability completeness — dead-code candidates,
coverage gaps, impact and blast radius, test selection, error propagation, and the change-impact
certificate — SHALL disclose the dynamic-boundary sites that lie **inside the subgraph it
traversed**, in the disclosure field the tool already returns. Each disclosed entry SHALL name
the file, line, and `kind`. The disclosure SHALL be bounded and deduplicated by kind and file,
and a bounded disclosure SHALL carry a truncation receipt naming the omitted count. A conclusion
with no sites in scope SHALL disclose nothing new.

The disclosure SHALL be scoped to the traversal, never to the repository: a conclusion over a
region with no dynamic constructs SHALL NOT inherit boundaries from elsewhere in the repository.

#### Scenario: A blast radius names the boundary that bounds it

- **GIVEN** a changed symbol whose caller closure includes a file containing a
  `container-resolution` site
- **WHEN** the blast radius is computed
- **THEN** the briefing's boundary disclosure names that file, line, and kind, and the result is
  still returned (the disclosure never blocks or empties the answer)

#### Scenario: A clean region stays clean

- **GIVEN** a traversal over a subgraph containing no dynamic-boundary sites, in a repository
  that has sites elsewhere
- **WHEN** the conclusion is assembled
- **THEN** no dynamic-boundary disclosure is attached

#### Scenario: A large boundary set is bounded with a receipt

- **GIVEN** a traversal crossing more sites than the disclosure bound allows
- **WHEN** the conclusion is assembled
- **THEN** the disclosed subset is accompanied by the count of omitted sites, never silently
  truncated

### Requirement: DeadAndSafeVerdictsAreCappedNearADynamicBoundary

A verdict that asserts the **absence** of a caller or of risk SHALL NOT be issued at full
confidence when a dynamic-boundary site lies in the subject's neighborhood.

Specifically: a dead-code candidate whose own file, or whose potential callers' files, contain a
`reflective-invoke`, `computed-member`, or `container-resolution` site SHALL be reported at a
reduced confidence carrying that site as its stated reason; the `also-dead` label in the
coverage-gap report SHALL be withheld for such a symbol in favor of the plain gap label; and a
`dead` or `safe-to-change` claim verified against such a neighborhood SHALL resolve to
`unverifiable` rather than `confirmed`, with the boundary named in the receipt.

A boundary SHALL NEVER be used to assert the opposite conclusion: the system SHALL NOT report a
symbol as live, tested, or unsafe merely because a dynamic boundary is nearby. The effect is
strictly a downgrade of a negative assertion.

#### Scenario: A plugin behind a DI container is not confidently dead

- **GIVEN** a class with no statically-resolved callers, in a repository where a
  `container-resolution` site appears in the module that wires plugins
- **WHEN** dead-code candidates are computed
- **THEN** the class appears at reduced confidence with the container-resolution site as its
  reason, rather than at the confidence given to a symbol with no dynamic neighborhood

#### Scenario: verify_claim refuses to confirm a negative next to a hole

- **GIVEN** a `dead` claim about a symbol whose file contains a `reflective-invoke` site
- **WHEN** the claim is verified
- **THEN** the verdict is `unverifiable`, the receipt names the site, and the verdict is not
  `confirmed`

#### Scenario: The downgrade is one-directional

- **GIVEN** a symbol with a dynamic-boundary site in its file and no reaching test
- **WHEN** the coverage-gap report is assembled
- **THEN** the symbol is still reported as a gap; the boundary only withholds the `also-dead`
  label and never implies the symbol is tested or reached
