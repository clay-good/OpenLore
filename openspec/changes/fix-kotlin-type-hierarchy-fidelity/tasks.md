# Tasks: Kotlin type hierarchy fidelity

## Implementation
- [ ] Add `receiverType` to function nodes; stop creating class records for undeclared receivers
- [ ] Split supertypes into superclass / interface / unknown-kind
- [ ] Capture `explicit_delegation` supertypes; mark the class `delegating`
- [ ] Anonymous class records for object expressions and enum entries with bodies
- [ ] Record class kind from modifiers
- [ ] Own companion members by the enclosing class; keep the companion name as an alias
- [ ] Qualified owner names for nested classes
- [ ] Keep node ids stable; update the documented Kotlin row

## Conformance
- [ ] One fixture per row of the "wrong today" table
- [ ] Class inventory of the reference corpus contains no `String`, `Int`, or `Application`
- [ ] Dispatch test: a call typed as an interface reaches an object-expression override

## Verification
- [ ] Before/after class and inheritance diff on a real repository in the PR
- [ ] Full suite green

## Spec
- [ ] `analyzer` delta: ADD KotlinClassModelMatchesDeclaredTypes
