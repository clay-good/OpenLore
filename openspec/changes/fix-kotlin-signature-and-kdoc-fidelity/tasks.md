# Tasks: Kotlin signature and KDoc fidelity

## Implementation
- [ ] Build the Kotlin signature from the parse tree; stop at the return type; never include a body
- [ ] Emit structured parameters, return type, type parameters, visibility, modifiers
- [ ] Extend the signature inventory to constructors, properties, all class kinds, type aliases
- [ ] Extract KDoc (summary + block tags) placed before a declaration, across annotations
- [ ] Add the Kotlin standard-library ignore list as one named constant

## Conformance
- [ ] One fixture per row of the "wrong today" table
- [ ] Signature fixture with a `{` inside an annotation argument and inside a default value
- [ ] KDoc fixture: summary, `@param`, `@return`, `@throws`; a `//` comment gives no docstring
- [ ] `language-support.test.ts` Kotlin `signatures` fixture asserts parameters and return type

## Verification
- [ ] Reference corpus: no stored signature contains `=` followed by body text
- [ ] Full suite green

## Spec
- [ ] `analyzer` delta: ADD KotlinDeclarationsCarryExactSignaturesAndKdoc
