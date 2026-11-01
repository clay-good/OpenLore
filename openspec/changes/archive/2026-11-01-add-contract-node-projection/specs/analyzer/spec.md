# analyzer spec delta

## ADDED Requirements

### Requirement: ContractOperationsAreGraphNodesBoundToHandlers

The analyzer SHALL project each operation of a discovered OpenAPI or Swagger document onto the
existing graph primitives, as infrastructure resources are projected: a node whose `language` is
`OpenAPI` and whose address is `<METHOD> <path template>`, the servers base path included. A route
handler extracted by the HTTP route parser SHALL be linked to the operation with the same method
and normalized path template by an `implements_endpoint` edge. Matching SHALL be literal — no name
similarity, no embeddings — and SHALL name exactly ONE declared operation: an address that names
several binds nothing and is disclosed as ambiguous.

#### Scenario: A handler is bound to its declared operation

- **GIVEN** an OpenAPI document declaring `GET /v1/orders/{id}` and an Express handler registered
  on `GET /v1/orders/:id`
- **WHEN** the repository is analyzed
- **THEN** the graph holds an `OpenAPI` node addressed `GET /v1/orders/{id}` and an
  `implements_endpoint` edge from the handler to it

#### Scenario: Similar but different routes are not bound

- **GIVEN** a spec operation `GET /v1/orders/{id}` and a handler on `GET /v1/order/:id`
- **WHEN** the repository is analyzed
- **THEN** no `implements_endpoint` edge is created and both appear in the unmatched lists

#### Scenario: A router mounted without the base path

- **GIVEN** a specification whose servers base path is `/v1`, declaring `/orders/{id}`, and a
  handler registered on `/orders/:id`
- **WHEN** the repository is analyzed
- **THEN** the handler is bound, because exactly one declared path across every specification has
  that method and path and the path has a literal segment

#### Scenario: Two operations that collapse to one address bind to neither

- **GIVEN** two specifications that declare the same method and path for different services
- **WHEN** the repository is analyzed
- **THEN** no `implements_endpoint` edge is created and the address is disclosed as ambiguous

### Requirement: UnboundContractElementsAreDisclosed

Everything the contract projection could not bind SHALL be disclosed on the build rather than
dropped: operations no route serves and no call consumes, routes no operation declares, a route or
call that matched an operation but whose code node could not be pinned, client call sites whose
method or path is not literal, addresses that name more than one declared operation, a
specification that declared itself one and could not be read, and every cap the projection stopped
at. Each list SHALL be bounded and carry its exact total, so a disclosure cannot itself overwhelm
the artifact that carries it.

An "unmatched" conclusion SHALL be WITHHELD, not asserted, while any input that could have matched
was not assessed — the route extraction failed or degraded, a specification could not be read, or
an operation fell past the cap. A projection that fails outright SHALL disclose the failure, so no
build reports "no operations" for a repository whose specification merely failed to parse.

#### Scenario: An unreadable specification is disclosed

- **GIVEN** a file declaring itself an OpenAPI document that cannot be parsed
- **WHEN** the repository is analyzed
- **THEN** the file is disclosed as unread with its reason, and its operations are not reported
  as absent

#### Scenario: An operation nothing serves

- **GIVEN** a specification declaring two operations, a route serving one of them, and every
  input assessed
- **WHEN** the repository is analyzed
- **THEN** the other operation is disclosed as unmatched

#### Scenario: A conclusion is withheld rather than guessed

- **GIVEN** a repository whose route extraction failed
- **WHEN** the repository is analyzed
- **THEN** no operation is reported as unmatched, and the reason it could not be assessed is
  disclosed

#### Scenario: A handler that matched but could not be resolved

- **GIVEN** a route that matches a declared operation whose handler name resolves to no single
  indexed function
- **WHEN** the repository is analyzed
- **THEN** no edge is created, the route is not called unmatched, and the unresolved binding is
  disclosed

### Requirement: ContractElementsAreNotRankedAsCode

A contract element is a declaration, not a code unit. A contract node SHALL be excluded from the
candidate sets that rank source code — hubs, entry points, dead code, coverage gaps, change
significance, and the file-level dependency rankings — and a contract edge SHALL NOT change any
function's fan-in or fan-out, in the in-memory build and in the persisted graph every tool reads.
A contract node SHALL reach an agent as a typed cross-domain neighbour, never inside a list of
functions it could edit or test. A handler bound to a declared operation SHALL be treated as
invoked from outside the code, so it is a reachability root rather than dead code.

#### Scenario: Projecting a specification changes no metric

- **GIVEN** a repository analyzed with and without its specification
- **WHEN** the two graphs are compared
- **THEN** every function's fan-in and fan-out, the hubs, the entry points, and the structural
  averages are identical, and no contract node appears among them

#### Scenario: The served graph classifies a declaration the same way

- **GIVEN** a persisted graph holding an operation node that nothing binds to, and one that eight
  handlers bind to
- **WHEN** the structural metrics are recomputed
- **THEN** neither is an entry point and neither is a hub, and no handler's fan-out counts its
  contract edge

#### Scenario: An operation reaches the agent as a contract neighbour

- **GIVEN** a handler bound to a declared operation
- **WHEN** `analyze_impact` runs on the handler
- **THEN** the operation is reported as a typed contract neighbour, not among the code functions
  downstream

#### Scenario: A declared handler is not dead code

- **GIVEN** a handler that no indexed code calls and that serves a declared operation
- **WHEN** `find_dead_code` runs
- **THEN** the handler is not a candidate, and neither is the operation node

### Requirement: ClientCallsAreBoundToTheOperationsTheyConsume

The function enclosing a client call site extracted by the HTTP projection SHALL be linked by a
`consumes_endpoint` edge to the operation with the same method and normalized path, whether or not
a handler for that operation is in the repository. A concrete value written where the
specification writes a path parameter SHALL bind, matched segment by segment and only when exactly
one declared operation accepts the path; an exactly declared path always wins. A call written to
an absolute URL SHALL bind only when its host is one the matched document declares, so a call to
another service is never read as a call to this one. A call whose method or path is not literal
SHALL be left unbound.

#### Scenario: Calls to an external API are visible

- **GIVEN** a vendored OpenAPI document for an external service declaring `POST /v1/charges`, and a
  client `POST` call to a literal `/v1/charges` path with no handler in the repository
- **WHEN** the repository is analyzed
- **THEN** a `consumes_endpoint` edge links the calling function to `POST /v1/charges`

#### Scenario: A concrete value fills a declared parameter

- **GIVEN** a specification declaring `GET /v1/orders/{id}` and a client call to the literal path
  `/v1/orders/7`
- **WHEN** the repository is analyzed
- **THEN** a `consumes_endpoint` edge links the calling function to `GET /v1/orders/{id}`

#### Scenario: A call to another host is not bound

- **GIVEN** a specification whose servers name `api.example.com`, and a client call to
  `https://other-vendor.example.com/v1/charges`
- **WHEN** the repository is analyzed
- **THEN** no edge is created and the call site is disclosed as unbound

#### Scenario: A call whose base is not literal is disclosed

- **GIVEN** a client call written to `${base}/orders/7`
- **WHEN** the repository is analyzed
- **THEN** no edge is created and the call site is disclosed as unbound with its reason
