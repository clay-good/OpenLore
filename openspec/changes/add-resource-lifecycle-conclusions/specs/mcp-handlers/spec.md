# mcp-handlers spec delta

## ADDED Requirements

### Requirement: ResourceLifecycleVerdictsAreProvenLeakPathsOnly

The system SHALL provide a resource-lifecycle conclusion that, for each resource acquisition site
within a function, traverses the persisted control-flow graph to every function exit and reports
per path `released-on-all-paths`, `unreleased-on-path` with the escaping path's branch or throw
line and the exit it reaches, or `undecidable`. Acquire and release forms SHALL come from a closed
per-language table, and scope-based automatic release forms SHALL be recognized as releasing on
every path. A resource returned from the function or otherwise transferred out of it SHALL be
`undecidable`, never a leak. Where a leaking path is an exception path, the conclusion SHALL name
the escaping exception type using the existing error-propagation evaluator. The system SHALL
report only paths it can prove lack a release: it SHALL NOT claim that a resource is correctly
released or safe, and the absence of a leak verdict SHALL NOT be presented as a safety claim.
Unmatched pairings, unresolvable releases, truncation, and index staleness SHALL be disclosed as
boundaries; an unsupported language SHALL return an explicit unsupported result rather than an
empty one. The conclusion SHALL be advisory by default, gateable only through explicit enforcement
policy.

#### Scenario: An early return that skips the release is proven

- **GIVEN** a function that opens a handle, returns early on a condition, and closes the handle at
  the end
- **WHEN** the resource-lifecycle conclusion is requested for that function
- **THEN** the early-return path is reported `unreleased-on-path` with the return line and the exit
  it reaches

#### Scenario: Scope-based release is quiet

- **GIVEN** a function acquiring a resource inside a scope form that releases automatically, with a
  throw inside that scope
- **WHEN** the conclusion is requested
- **THEN** the acquisition is reported released on all paths and no leak verdict is emitted

#### Scenario: A leaking exception path names its exception

- **GIVEN** a function whose acquisition is followed by a call that can throw a typed exception
  before the release
- **WHEN** the conclusion is requested
- **THEN** the reported leak path names that exception type from the error-propagation analysis

#### Scenario: Ownership transfer is undecidable, not a leak

- **GIVEN** a function that acquires a resource and returns it to its caller
- **WHEN** the conclusion is requested
- **THEN** the site is reported `undecidable` with the transfer disclosed, and no leak is claimed

#### Scenario: No safety claim is made

- **GIVEN** a function whose acquisition yields no leak verdict
- **WHEN** the conclusion is returned
- **THEN** the payload does not state or imply that the resource is correctly released or that the
  function is safe
