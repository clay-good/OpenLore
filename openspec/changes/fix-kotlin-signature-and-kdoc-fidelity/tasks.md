# Tasks: Kotlin signature and KDoc fidelity

## Implementation
- [x] Build the Kotlin signature from the parse tree; stop at the return type; never include a body
- [x] Emit structured parameters, return type, type parameters, visibility, modifiers
- [x] Extend the signature inventory to constructors, properties, all class kinds, type aliases
- [x] Extract KDoc (summary + block tags) placed before a declaration, across annotations
- [x] Add the Kotlin standard-library ignore list as one named constant

## Conformance
- [x] One fixture per row of the "wrong today" table
- [x] Signature fixture with a `{` inside an annotation argument and inside a default value
- [x] KDoc fixture: summary, `@param`, `@return`, `@throws`; a `//` comment gives no docstring
- [x] `language-support.test.ts` Kotlin `signatures` fixture asserts parameters and return type

## Verification
- [x] Reference corpus: no stored signature contains `=` followed by body text
- [ ] Full suite green (run once for the whole change set, in the pull request)

## Spec
- [x] `analyzer` delta: ADD KotlinDeclarationsCarryExactSignaturesAndKdoc
