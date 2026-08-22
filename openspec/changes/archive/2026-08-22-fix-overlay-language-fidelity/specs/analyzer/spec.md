# analyzer spec delta

## ADDED Requirements

### Requirement: RubyCfgOverlayCallAndRescueFidelity

The Ruby CFG/data-flow overlay SHALL treat a Ruby method call as a call — visiting the receiver
and every argument for uses, never recording the method name as a variable use — and SHALL route
control flow through `rescue`/`ensure` bodies, so a definition reassigned inside a rescue clause
kills the crossing def-use. Where rescue-path soundness cannot be proven, the edge SHALL carry
`may` precision; the overlay SHALL never emit an `exact` edge across an untracked exceptional
path, per the module contract that `exact` marks a sound local-scalar def-use.

#### Scenario: Ruby call arguments produce uses

- **GIVEN** a Ruby method whose body calls `helper(a, x)`
- **WHEN** the CFG overlay is built
- **THEN** uses of `a` and `x` appear in the def-use overlay
- **AND** no variable use named `helper` is recorded

#### Scenario: A reassigning rescue kills the crossing definition

- **GIVEN** a Ruby `begin`/`rescue` where `x` is defined before the block and reassigned in the
  rescue clause, then read after it
- **WHEN** def-use edges are computed
- **THEN** no `exact` edge connects the pre-block definition to the post-block read

#### Scenario: valueReachableLines regains its soundness direction for Ruby

- **GIVEN** a Ruby function whose parameter flows into a call argument
- **WHEN** `valueReachableLines` is computed for that parameter
- **THEN** the call's line is included in the reachable set

### Requirement: DestructuredParameterBinding

Parameter extraction for the CFG overlay SHALL collect the binding identifiers of destructured
(object/array pattern) parameters in TypeScript/JavaScript, so they seed `valueReachableLines`,
participate in def-use, and are treated as locally bound by closure-capture analysis.

#### Scenario: Object-pattern parameters are parameters

- **GIVEN** `function handler({ req, res }, plain)`
- **WHEN** the function's CFG is built
- **THEN** `cfg.params` contains `req`, `res`, and `plain`
- **AND** a use of `req` in the body receives a def-use edge from the parameter definition

#### Scenario: Destructured names are not misclassified as closure captures

- **GIVEN** a nested arrow function inside `handler({ req })` that reads `req`
- **WHEN** closure captures are recorded for the nested function against its own parameters and
  the enclosing scope
- **THEN** `req` is resolved as the enclosing function's parameter, not an outer-scope
  `may`-capture of an unknown name

### Requirement: EnvVarClassificationMatchesRuntimeSemantics

Environment-variable extraction SHALL classify each read's hard/soft failure mode by the actual
runtime semantics of the language form, identically in the inventory and read-site paths: Ruby
`ENV["X"]` is soft (returns `nil`), Ruby `ENV.fetch("X")` without a default is hard (raises
`KeyError`); Go `os.LookupEnv("X")` and TS/JS `const { X } = process.env` destructuring SHALL be
recognized as reads within the declared scope; and a TS/JS fallback (`??` / `||`) SHALL affect
only the read site it guards, never every variable in the file.

#### Scenario: Ruby bracket read is a soft break

- **GIVEN** a Ruby file reading `ENV["DATABASE_URL"]`
- **WHEN** env extraction classifies the read
- **THEN** the read is reported `required: false` in both the inventory and the read-site path

#### Scenario: No-default fetch is a hard break

- **GIVEN** a Ruby file reading `ENV.fetch("API_KEY")` with no default argument
- **WHEN** env extraction classifies the read
- **THEN** the read is reported `required: true`

#### Scenario: Idiomatic checked forms are visible

- **GIVEN** a Go file calling `os.LookupEnv("PORT")` and a TS file with
  `const { API_KEY } = process.env`
- **WHEN** env extraction scans the sources
- **THEN** both variables appear as reads, never silently absent

#### Scenario: A fallback guards only its own read site

- **GIVEN** a TS file with `process.env.A ?? 'x'` and a separate bare `process.env.B` read
- **WHEN** the inventory is built
- **THEN** `B` is not marked `required: false` on the strength of `A`'s fallback

### Requirement: ReceiverAwareArityGuard

CHA arity extraction SHALL skip a leading Go receiver group (a signature starting `func (`) so a
Go method's arity reflects its parameter list, restoring the arity-compatibility filter for
override-edge synthesis on Go embeds hierarchies.

#### Scenario: Go method arity counts parameters, not the receiver

- **GIVEN** the signature `func (s *Server) handle(w http.ResponseWriter, r *http.Request)`
- **WHEN** `arityFromSignature` runs
- **THEN** the computed arity is 2

#### Scenario: The override filter works again for Go

- **GIVEN** a Go base method of arity 2 and a same-named embedded-type method of arity 1
- **WHEN** override edges are synthesized
- **THEN** no override edge is created between the incompatible pair
