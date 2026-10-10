# Tasks: Kotlin type hierarchy fidelity

## Implementation
- [x] Add `receiverType` to function nodes; stop creating class records for undeclared receivers
- [x] Split supertypes into superclass / interface / unknown-kind
- [x] Capture `explicit_delegation` supertypes; mark the class `delegating`
- [x] Anonymous class records for object expressions and enum entries with bodies
- [x] Record class kind from modifiers
- [x] Own companion members by the enclosing class; keep the companion name as an alias
- [x] Qualified owner names for nested classes
- [x] Keep node ids stable, except where the owner was wrong: a member of a nested class, of a
      named companion, or of an object expression now carries its real owner; update the
      documented Kotlin row

## Conformance
- [x] One fixture per row of the "wrong today" table
- [x] Class inventory of the reference corpus contains no `String`, `Int`, or `Application`
- [x] Dispatch test: a call typed as an interface reaches an object-expression override

## Verification
- [ ] Before/after class and inheritance diff on a real repository in the PR
- [ ] Full suite green (run once for the whole change set, in the pull request)

## Spec
- [x] `analyzer` delta: ADD KotlinClassModelMatchesDeclaredTypes
