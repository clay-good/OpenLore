# analyzer spec delta

## ADDED Requirements

### Requirement: JvmSiblingLanguageListsStayInParity

Every hand-written collection of language names or file extensions in non-test source that includes
Java SHALL also include Kotlin, or SHALL be listed in a checked-in exemption table with a reason. A
structural test SHALL fail when a collection breaks this rule. The decisions commit gate, the
bounded inventory scan, search chunking, log-statement stripping, the worker grammar probe, and
tool language-filter descriptions SHALL handle Kotlin. Loading the optional Kotlin grammar SHALL
fail soft on every code path: analysis completes, Kotlin files stay searchable, and one warning
states that they are not graphed. Documentation and tool descriptions SHALL NOT claim Kotlin output
that a tool does not produce.

#### Scenario: A new Java-only list fails the guard

- **GIVEN** a new source file with a collection that contains `.java` and not `.kt`, and no
  exemption entry
- **WHEN** the parity guard test runs
- **THEN** the test fails and names the file and line

#### Scenario: A deliberate Java-only site is exempt with a reason

- **GIVEN** a Java-only declaration scanner listed in the exemption table with its reason
- **WHEN** the parity guard test runs
- **THEN** the test passes

#### Scenario: The decisions gate sees a Kotlin change

- **GIVEN** a staged change to a `.kt` file
- **WHEN** the decisions commit gate computes whether source changed
- **THEN** the change counts as a source change

#### Scenario: Kotlin is chunked on declarations

- **GIVEN** a Kotlin file with two classes and a top-level function
- **WHEN** the file is chunked for search
- **THEN** chunk boundaries fall on those declarations

#### Scenario: A missing grammar does not stop analysis

- **GIVEN** an installation where the Kotlin grammar cannot be loaded
- **WHEN** a repository with Kotlin files is analyzed
- **THEN** analysis completes, one warning is printed, and no unhandled error occurs on any path
