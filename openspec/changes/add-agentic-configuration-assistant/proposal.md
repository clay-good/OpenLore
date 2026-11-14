# Add a repository-aware agentic configuration assistant

> Status: PROPOSED. Design-only change for [#719](https://github.com/clay-good/OpenLore/issues/719).
> This proposal does not implement the assistant or change current defaults.

## Why

Effective OpenLore configuration depends on the repository and its host. A user must currently
connect facts about build outputs, generated source, ignore rules, embeddings, index state, and
daemon ownership themselves. A wrong exclusion loses architectural evidence; a wrong inclusion
can make the shared service unresponsive. Watching large ignored build trees can consume watch
resources and degrade all connected sessions before an eventual `EMFILE` error (#717). A package
upgrade can also leave a detached daemon incompatible with its new extension (#618).

A first-run wizard cannot keep this configuration correct throughout the repository's life.
New packages, languages, build tools, and generated outputs change which files should be analyzed,
watched, or embedded. The assistant must explain those tradeoffs and preserve deliberate exceptions.

## What Changes

- Add an assistant workflow driven by the user's existing host agent, including Pi and pi-outpost.
  OpenLore supplies bounded local evidence and validated operations; it does not start a second
  LLM conversation or require a generation provider.
- Inspect repository structure, manifests, declared build outputs, Git tracking/ignore rules,
  effective configuration, and runtime state without requiring a pre-existing index or daemon.
- Produce an evidence-backed plan with a concrete configuration diff, affected paths, resource
  estimates, architectural coverage tradeoffs, uncertainties, and follow-up verification.
- Separate file-selection policies for structural indexing, live watching, and embeddings.
  Git ignore rules remain evidence and an existing boundary, not a complete classifier.
- Apply only authorized, still-current plans, preserve user choices and unknown config fields,
  verify realized behavior, and provide revision-checked rollback.
- Detect meaningful repository evolution with deterministic, coalesced change signals. Notify
  the user only after proving an actionable material discrepancy not covered by existing choices;
  metadata changes alone remain silent. Never run an LLM on every file event.
- Keep recovery accessible through the host even when the structural index or daemon is broken.
  Respect external supervision and shared sessions rather than taking over their processes.

## Capabilities

### New Capabilities

- `configuration-assistant`: repository evidence, justified plans, functional verification,
  reversible changes, and lifecycle reassessment.

### Modified Capabilities

- `config`: independent file-selection lanes, explicit precedence, rule rationale, and
  revision-checked configuration publication.
- `api`: a daemon-independent configuration management surface for embedding hosts.
- `mcp-quality`: equivalent assistant entry points in Pi/RPC and an opt-in MCP management tool,
  without expanding the default structural tool surface.

## Impact

- Proposed core: `src/core/configuration/`, reusing current config readers/schema validation,
  bounded file inspection, workspace detection, runtime ownership, and atomic-write primitives.
- Proposed package boundary: `openlore/configuration`, kept independent of the analyzer's import
  graph. The existing `openlore/serve-descriptor` contract remains the authority for daemon identity.
- Consumers: Pi's existing configure command/tool, a host-agent skill, an optional CLI adapter,
  and one opt-in MCP management tool. No terminal or global CLI is required for extension users.
- Existing indexing/watching/embedding consumers must share policy decisions rather than each
  implementing another ignore dialect. Hard host boundaries and secret/endpoint trust remain intact.
- No existing config migration or source change occurs in this design PR. Implementation work,
  schema compatibility, tool-surface accounting, and regression fixtures are listed in `tasks.md`.

## Non-Goals

- Running repository builds, package scripts, tests, or downloaded models to discover configuration.
- Automatically editing Git ignore files, global credentials, TLS settings, or agent trust settings.
- Guaranteeing semantic coverage or exact OS watch-handle savings from a sampled survey.
- Replacing the host's agent, the existing doctor, the indexer, or an external daemon supervisor.
- Treating this proposal's operational contracts as an implementation of the whole issue.

## Related Work

Reuse the shipped config-schema/layering, supervising-host API, user-scope onboarding, and
self-healing-index contracts. #717 supplies watcher-pruning regressions, not a substitute for
repository-aware policy. #618 motivates recovery behavior but does not grant lifecycle authority.
