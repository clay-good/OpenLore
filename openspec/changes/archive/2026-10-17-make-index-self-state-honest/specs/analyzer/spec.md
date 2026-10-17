# Spec Delta

## ADDED Requirements

### Requirement: IndexReuseRequiresCapabilityAgreement

The index-reuse gate SHALL reuse a previously built search index only when the index's realized
capability agrees with the resolved embedding provider, in addition to the existing generation and
configuration checks. A resolvable semantic provider together with an on-disk index that carries no
vectors SHALL invalidate the reuse receipt, so the next analysis rebuilds the index rather than
reusing a keyword index indefinitely. The reverse mismatch — an index carrying vectors when no
provider resolves — SHALL also invalidate the receipt.

Agreement SHALL be established from the index's own recorded state, not from a timestamp comparison,
so a build that silently fell back to keyword mode cannot be mistaken for an up-to-date index.

#### Scenario: A keyword index is not reused when a provider resolves

- **GIVEN** a repository whose configuration resolves to an embedding provider
- **AND** an index receipt whose generation and configuration hash still match, over an index with
  no vectors
- **WHEN** analysis runs without a force flag
- **THEN** the receipt is treated as invalid and the search index is rebuilt

#### Scenario: An agreeing index is still reused

- **GIVEN** a repository whose resolved provider matches an index carrying vectors from that provider
- **AND** an unchanged generation and configuration hash
- **WHEN** analysis runs
- **THEN** the index is reused without a rebuild

#### Scenario: The unconfigured default remains reusable

- **GIVEN** a repository with no embedding provider configured and a keyword index
- **WHEN** analysis runs
- **THEN** the keyword index is reused, with no mismatch and no rebuild

### Requirement: IndexLockContentionIsNeverASilentDowngrade

When the vector index's mutation lock is held by another live process, the system SHALL NOT complete
the build by silently producing a keyword-only index and reporting success. It SHALL either wait for
the lock when the caller asked to wait, or fail with a non-zero exit status whose message names the
process holding the lock and how long it has been held.

A lock whose recorded owner is no longer alive SHALL be treated as stale: the system SHALL reclaim it
and state that it did so, rather than refusing index mutations indefinitely.

#### Scenario: A concurrent build fails loudly instead of degrading

- **GIVEN** an index build holding the mutation lock
- **WHEN** a second build is started without a wait flag
- **THEN** the second build exits non-zero, names the holding process and the lock's age, and does
  not replace the index with a keyword-only one

#### Scenario: Waiting yields the realized index

- **GIVEN** the same contention and a caller that asked to wait
- **WHEN** the holding build completes
- **THEN** the waiting build proceeds and produces an index whose capability matches the resolved
  provider

#### Scenario: A dead owner's lock is reclaimed

- **GIVEN** a lock file recording a process id that is no longer running
- **WHEN** an index mutation is attempted
- **THEN** the lock is reclaimed, the reclamation is stated, and the mutation proceeds
