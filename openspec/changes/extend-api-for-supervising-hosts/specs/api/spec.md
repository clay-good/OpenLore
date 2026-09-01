## ADDED Requirements

### Requirement: RuntimeReadinessIsPublishedAsAValue

The programmatic API SHALL publish functional readiness as a returned value, not as something a
host infers from a live process or a transport payload. The value SHALL distinguish, at minimum:
whether the runtime is available, whether the index is absent, building, ready, or degraded, which
index artifacts are degraded when it is, whether a freshness watcher is healthy, stopped, or of
unknown state, and whether a background repair is in progress. When the result is not ready it
SHALL carry a typed reason code with a human-readable message.

The answer SHALL be meaningful from disk alone. A discoverable daemon MAY refine it; the absence of
a daemon SHALL NOT make readiness unanswerable, and SHALL NOT be reported as "unavailable" when the
index on disk is present and whole.

#### Scenario: Readiness is answered with no daemon running

- **GIVEN** a repository with a complete index on disk and no `openlore serve` daemon
- **WHEN** a host asks for readiness
- **THEN** it receives `index: 'ready'` and an available runtime, with no request issued to any host

#### Scenario: A partial index is degraded, not ready

- **GIVEN** a repository whose index is missing or has a corrupt artifact
- **WHEN** a host asks for readiness
- **THEN** the result is `index: 'degraded'` and names each degraded artifact and whether it was
  missing or corrupt

#### Scenario: A live process is not evidence of readiness

- **GIVEN** a running daemon serving a repository whose index has not been built
- **WHEN** a host asks for readiness
- **THEN** the result is `index: 'absent'` with a typed reason — never "ready" because a process
  answered

### Requirement: IndexFreshnessIsAnsweredWithoutReanalysis

The programmatic API SHALL answer "does the persisted index represent the current working tree?"
without running an analysis. The answer SHALL be a comparison of the working tree's computed
fingerprint against the fingerprint the index was built from, and SHALL report whether they match,
the fingerprint itself when one exists, and, when they do not match, the reason: that no index
exists, that no fingerprint baseline was ever recorded, that the fingerprint differs, or that the
index does not record the configuration it was computed under.

Because the fingerprint depends on the analyzed corpus, and the corpus depends on per-invocation
inputs that are not otherwise persisted, analysis SHALL record the configuration values its
fingerprint was computed under alongside the fingerprint itself, and this comparison SHALL use those
recorded values. An index that does not record them SHALL be reported as not assessable rather than
compared under a guessed configuration: the answer is never a match this function cannot prove, and
never a mismatch it cannot distinguish from a missing input.

This is the same staleness judgement the federation registry makes about a peer repository, made
about the local one. Calling it SHALL NOT write any artifact, acquire analysis ownership, or start
an analysis.

#### Scenario: A branch checkout is a snapshot transition

- **GIVEN** an index built from the tree at commit A and a working tree checked out at commit B
  with different source content
- **WHEN** a host asks whether the index matches the working tree
- **THEN** the result reports no match with a fingerprint-mismatch reason, and no analysis is started

#### Scenario: An unanalyzed repository is distinguished from a stale one

- **GIVEN** a repository that has never been analyzed
- **WHEN** a host asks whether the index matches the working tree
- **THEN** the result reports no match with a no-index reason — distinct from a fingerprint mismatch

#### Scenario: An unchanged tree matches

- **GIVEN** an index built from the current working tree with no subsequent source edit
- **WHEN** a host asks whether the index matches the working tree
- **THEN** the result reports a match and carries the fingerprint

#### Scenario: A narrowed corpus is not a false mismatch

- **GIVEN** an index built with an analysis invocation that excluded part of the repository, and a
  working tree unchanged since
- **WHEN** a host asks whether the index matches the working tree
- **THEN** the result reports a match — the comparison uses the configuration the index recorded,
  not the configuration a fresh default invocation would use

#### Scenario: An index that recorded no configuration is not assessable

- **GIVEN** an index whose fingerprint artifact does not record the configuration it was computed
  under
- **WHEN** a host asks whether the index matches the working tree
- **THEN** the result reports no match with a reason stating the configuration was not recorded, and
  does not present a computed comparison as authoritative

### Requirement: AnalysisOwnershipIsReadableWithoutProvokingIt

The programmatic API SHALL publish a non-blocking read of analysis ownership. The read SHALL report
whether an analysis is in progress and, when one is, the owner payload, the elapsed time, and the
heartbeat age — the same three facts the in-progress error already carries. Learning that another
process owns the analysis SHALL NOT require starting an analysis that then fails.

The read SHALL never acquire, steal, or wait for ownership. A stale lock left by a crashed holder
SHALL be reported as no analysis in progress, consistent with how ownership acquisition treats it.

#### Scenario: A host reports a competing analysis without competing

- **GIVEN** another process holding analysis ownership of the repository with a healthy heartbeat
- **WHEN** a host reads analysis status
- **THEN** it receives in-progress with the owner, elapsed time, and heartbeat age, and no analysis
  was started or attempted

#### Scenario: A crashed holder is not an analysis in progress

- **GIVEN** an ownership lock whose holder died, leaving the lock stale
- **WHEN** a host reads analysis status
- **THEN** the result reports no analysis in progress

### Requirement: FederationRegistryIsReadableWithoutWriting

The programmatic API SHALL publish a read of the federation registry that returns the registered
repository entries together with each peer's evaluated index state. The read SHALL NOT create,
modify, remove, or baseline any registry entry; registration remains an explicit user act through
the CLI and tools. A host SHALL be able to state what a federated answer covered, and to
demonstrate that it never wrote the registry.

#### Scenario: A host enumerates federated peers

- **GIVEN** a federation registry with registered repositories in varying index states
- **WHEN** a host reads the registry
- **THEN** it receives each entry and its evaluated state, and the registry file is byte-identical
  afterwards

#### Scenario: An empty registry is not an error

- **GIVEN** a machine with no federation registry
- **WHEN** a host reads the registry
- **THEN** it receives an empty list of repositories, not a thrown error

### Requirement: DaemonLifecycleIsAHandleNotAProcess

The programmatic API SHALL expose starting the local daemon as a call that returns a live handle —
carrying the bound host, port, base URL, and token, and a `close()`. Options SHALL be typed values
rather than CLI strings: a numeric port where zero requests an ephemeral one, and an idle timeout in
milliseconds where zero disables it. There SHALL be no stop-the-other-daemon option on this call.

A start that cannot proceed for ANY reason SHALL throw a typed error — static configuration
refusals and runtime outcomes alike, including lock contention, an incompatible or draining
announced daemon, and a token or preset posture mismatch. On no path SHALL the call set a process
exit code, write to the console, or return an absent handle to signal failure. A host embedding this
call does not own the process it runs in, and a failure that has already mutated that process is not
a thrown error.

A returned handle SHALL declare whether it owns the server it addresses. When the handle owns the
server, `close()` SHALL stop it, without signalling the process. When a compatible daemon is already
running for the working tree, the call SHALL by default refuse with a typed error naming that
daemon's address rather than returning a handle; a caller MAY explicitly opt in to addressing the
existing daemon, and the handle it then receives SHALL declare that it does not own the server and
its `close()` SHALL release the caller's reference without stopping it. A handle whose `close()`
does not stop a server SHALL NEVER be indistinguishable from one that does.

#### Scenario: A host holds and releases a daemon

- **GIVEN** a supervising host that starts a daemon for a working tree
- **WHEN** the host closes the returned handle
- **THEN** the server stops, its discovery descriptor no longer resolves to a live daemon, and no
  signal was sent to any process

#### Scenario: A refused configuration throws instead of exiting

- **GIVEN** a start request that the daemon must refuse — for example a non-loopback bind with no
  token, or an unknown preset
- **WHEN** a host issues it
- **THEN** a typed error is thrown carrying the reason, the host process's exit code is unchanged,
  and nothing is written to the console

#### Scenario: A runtime refusal is as clean as a static one

- **GIVEN** a start request that fails after the startup lock is taken — contention, an
  incompatible or draining announced daemon, or a token/preset posture mismatch
- **WHEN** a host issues it
- **THEN** a typed error is thrown, the host process's exit code is unchanged, and nothing is
  written to the console

#### Scenario: An already-running daemon is not silently adopted

- **GIVEN** a compatible daemon already running for the working tree
- **WHEN** a host starts a daemon without opting in to addressing an existing one
- **THEN** a typed error is thrown naming the running daemon's address, and no handle is returned

#### Scenario: An adopted daemon is not misreported as owned

- **GIVEN** a compatible daemon already running for the working tree
- **WHEN** a host explicitly opts in to addressing it and later closes the handle
- **THEN** the handle declares that it does not own the server, and closing it releases the
  reference while the daemon stays running

#### Scenario: An ephemeral port is reported back

- **GIVEN** a start request with port zero
- **WHEN** the daemon binds
- **THEN** the handle carries the actual bound port and a base URL addressing it

### Requirement: SupervisingHostReadsNeedNoGenerationConfiguration

The readiness, index-freshness, analysis-status, and federation reads SHALL be pure reads: no
artifact write, no LLM call, and no LLM-provider configuration required. A host that only indexes a
working tree SHALL be able to call all of them on a repository with no provider credentials
configured, exactly as it can already call analysis.

Each SHALL accept the same base options as the existing API functions — root path, config path,
quiet, an abort signal, and a progress callback — SHALL be silent on the console by default, SHALL
never control the process, and SHALL report failure through the API's typed error type.

#### Scenario: No provider configured

- **GIVEN** a repository with no LLM provider credentials in the environment or config
- **WHEN** a host calls each of the readiness, index-state, analysis-status, and federation reads
- **THEN** each returns its value, and none throws for missing provider configuration

#### Scenario: The reads leave no trace

- **GIVEN** a repository with an existing index
- **WHEN** a host calls each read
- **THEN** no file under the repository is created or modified by the calls
