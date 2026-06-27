# Tasks — per-language capability conformance

## Implementation
- [x] `language-capability-conformance.test.ts` — basic call graph for all 18 claimed callGraph languages
- [x] Coverage guard: fails if a registry callGraph language has no fixture
- [x] Intra-class method dispatch across class-bearing languages
- [x] Cross-file resolution + assert the TS `import` vs Python/Go `name_only` precision difference
- [x] Error-propagation: TS/JS/Python extract types; non-claimed language honestly `unsupported`

## Spec
- [x] `analyzer` spec: ADD CapabilityMatrixIsConformanceVerified

## Verification
- [x] New test green (37 cases)
- [ ] Full suite green (`vitest run src examples`)
