# Tasks — per-language capability conformance

## Implementation
- [x] `language-capability-conformance.test.ts` — basic call graph for all 18 claimed callGraph languages
- [x] Coverage guard: fails if a registry callGraph language has no fixture
- [x] Intra-class method dispatch across class-bearing languages
- [x] Cross-file resolution + assert the TS `import` vs Python/Go `name_only` precision difference
- [x] Error-propagation: TS/JS/Python extract types; non-claimed language honestly `unsupported`
- [x] CFG overlay: structurally-valid CFG for all 11 claimed languages + coverage guard
- [x] Type inference: variable→class type for all 9 claimed languages + honest empty for non-claimed
- [x] Style fingerprint: idioms tallied above floor for all 4 claimed languages + honest absent
- [x] Cross-service HTTP: route extraction (TS/JS/Python/Java) + client calls (TS/JS) + coverage guard
- [x] IaC projection: all 12 ecosystems project nodes (+ 8 reference/dependency edges) + coverage guard (`iac/iac-projection-conformance.test.ts`)

## Spec
- [x] `analyzer` spec: ADD CapabilityMatrixIsConformanceVerified

## Verification
- [x] New test green (73 cases)
- [x] Full suite green (278 files / 5491 passing)
