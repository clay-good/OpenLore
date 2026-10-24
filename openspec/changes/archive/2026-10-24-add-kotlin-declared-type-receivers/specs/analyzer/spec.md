# analyzer spec delta

## ADDED Requirements

### Requirement: KotlinReceiversResolveThroughDeclaredTypes

The analyzer SHALL resolve a Kotlin method call through the declared type of its receiver when that
type is written in the source as a function parameter type, a primary-constructor property or
parameter type, a class property type, a property or local initialized by a constructor call, or
the declared return type of a uniquely resolved project function. Nullable markers SHALL be peeled
and generic types reduced to their outer name. A bare property receiver inside a class SHALL be
looked up as a class property when no local or parameter has that name. A name with conflicting
declared types in one scope, a `var` after a reassignment, a smart-cast receiver, and a lambda
implicit parameter SHALL yield no type fact. Kotlin SHALL back the `receiverResolution` capability:
a `this.<property>.m()` call that binds SHALL produce a `receiver_inferred` edge, and one that does
not bind SHALL emit no edge and be disclosed as a boundary. A `Type.member()` call on a project
class, object, or companion SHALL bind by type name. No edge on this path SHALL be created from a
name match alone.

#### Scenario: A call on a constructor property resolves

- **GIVEN** `class UserService(private val repo: UserRepository) { fun create(n: String) { repo.save(n) } }`
  and a project interface `UserRepository` that declares `save`
- **WHEN** the call graph is built
- **THEN** `UserService.create` has an edge to `UserRepository.save` with a type-derived confidence
- **AND** the call is not recorded as `external::repo.save`

#### Scenario: A call on a typed parameter resolves

- **GIVEN** `fun use(svc: UserService) = svc.find("1")`
- **WHEN** the call graph is built
- **THEN** the edge targets `UserService.find`

#### Scenario: A self-property chain produces a receiver-inferred edge

- **GIVEN** `this.service.create(name)` inside a class whose constructor declares
  `private val service: UserService`
- **WHEN** the call graph is built
- **THEN** the edge targets `UserService.create` with `receiver_inferred` confidence

#### Scenario: A nullable declared type still types the receiver

- **GIVEN** `fun run(repo: UserRepository?) { repo?.save("x") }`
- **WHEN** the call graph is built
- **THEN** the edge targets `UserRepository.save`

#### Scenario: A conflicting or flow-dependent receiver is refused

- **GIVEN** a receiver whose name is declared with two different types in one scope, or a receiver
  typed only by a smart cast (`if (x is Repo) x.save()`), or the lambda parameter `it`
- **WHEN** the call graph is built
- **THEN** no type-derived edge is emitted for that call
- **AND** the unresolved receiver is counted in the disclosed boundary

#### Scenario: A companion or object member binds by type name

- **GIVEN** `UserService.audit("x")` where `audit` is a member of `UserService`'s companion object
- **WHEN** the call graph is built
- **THEN** the edge targets the companion member `audit`, not a package-level function of the same
  name
