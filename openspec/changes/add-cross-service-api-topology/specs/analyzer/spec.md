# analyzer spec delta

## ADDED Requirements

### Requirement: CrossServiceApiTopologyEdges

The system SHALL link outbound HTTP client call sites to the server route handlers they target,
projecting the relationship onto the existing `FunctionNode`/`CallEdge` primitives via the same
projector path the IaC subsystem uses, with no graph-schema change and no new MCP tool. The system
SHALL statically extract client call sites — the common JS/TS client idioms (`fetch`, `axios`, `ky`,
`got`; a typed API-client wrapper built on one of these is captured at the wrapper's own call site, so
its callers reach the endpoint transitively) — recovering each call's HTTP method, path template, and
enclosing function, mirroring how server route registrations are already parsed. Client call-site
extraction SHALL be gated through the language-support registry so its coverage is observable and
extends as languages and frameworks are added. The system SHALL perform no runtime tracing, network
call, or service introspection, and SHALL NOT require an OpenAPI or contract document: the bridge is a
static parse only.

#### Scenario: A client call site links to its route handler

- **GIVEN** a repository in which one function calls an HTTP client for `GET /api/users/:id` and another
  module registers a route handler for `GET /api/users/:id`
- **WHEN** the repository is analyzed
- **THEN** there is an edge from the client call site's enclosing function to the route handler, labeled
  as an HTTP/cross-service relationship distinct from a direct call, so that `analyze_impact` on the
  handler surfaces the client caller and `find_path` can route from the client to the handler

#### Scenario: The edges ride existing tools with no schema or tool change

- **GIVEN** cross-service edges present in the graph
- **WHEN** an agent calls the existing impact, pathfinding, or blast-radius tools on a route handler
- **THEN** those tools include the endpoint's client consumers, without any new node kind, edge schema
  field beyond the existing edge-metadata label, or new MCP tool

### Requirement: CrossServiceMatchingIsExactAndHonest

A client call site SHALL be linked to a server route only by an exact, structural match on a normalized
route key (HTTP method plus path template, with path parameters normalized so equivalent forms such as
`/users/:id`, `/users/{id}`, and a concrete `/users/123` reconcile). A client call whose target cannot
be statically resolved to a registered route in scope — a templated or dynamically-constructed path, a
dynamic base URL, or a method/path with no matching route — SHALL emit no edge rather than a guessed
one, and MAY carry a confidence-boundary known-unknowable disclosure (dynamic dispatch across a network
boundary). Cross-service edges SHALL be a deterministic function of the parsed client call sites and
server routes, byte-identical across re-analyses of a fixed repository state.

#### Scenario: Equivalent path-parameter forms reconcile

- **GIVEN** a client call to `/users/{id}` and a route registered as `/users/:id`
- **WHEN** the repository is analyzed
- **THEN** the normalized route keys match and the client call site is linked to the route handler

#### Scenario: A dynamic target emits no edge

- **GIVEN** a client call whose path is a runtime-constructed template or whose base URL is dynamic
- **WHEN** the repository is analyzed
- **THEN** no cross-service edge is emitted for that call site, and the unresolved target is eligible for
  a known-unknowable disclosure rather than a speculative edge

### Requirement: CrossServiceTopologyExtendsAcrossFederation

When two repositories are part of a federation, a client call site in one repository SHALL link to the
matching route handler in another, reusing federation's stable cross-repo symbol resolution, so that
cross-repo `analyze_impact` and `find_path` answer cross-service change-impact questions across service
boundaries. Within a single repository (a full-stack application or a monorepo of services), the edge
SHALL be local and SHALL NOT require federation.

#### Scenario: A client in one service links to a handler in another

- **GIVEN** a federation of two indexed repositories where a client call site in repository A targets a
  route registered in repository B
- **WHEN** cross-repo impact is computed for the route handler in repository B
- **THEN** the client consumer in repository A is surfaced as a cross-service consumer of that endpoint

#### Scenario: A monorepo full-stack link needs no federation

- **GIVEN** a single repository containing both the client call site and the server route
- **WHEN** the repository is analyzed
- **THEN** the cross-service edge is present in the single repo's graph without any federation
  configuration
