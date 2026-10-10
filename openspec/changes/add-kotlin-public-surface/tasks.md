# Tasks: Kotlin public surface

## Implementation
- [ ] Surface mode: list unassessed languages with file counts; boundary not complete
- [ ] Kotlin membership from the export inventory, with the visibility table and `@PublishedApi`
- [ ] Kotlin parameter and return parsing for classification (types, nullability, defaults)
- [ ] Classification table; register `jvm-binary-signature-changed`,
      `exhaustive-when-may-break`, `data-class-shape-changed`, `return-nullability-widened`
- [ ] Manifest public-symbol detector reads the Kotlin export inventory
- [ ] Correct the soundness note text for languages without membership extraction

## Conformance
- [ ] One fixture per row of the membership table and of the classification table
- [ ] Fixture: a Java-only repository reports Java as unassessed, not an empty complete surface
- [ ] Handler-level tests (through the tool handler, not the core function)
- [ ] `tool-contract.test.ts` and finding-registry tests stay green

## Verification
- [ ] Reference corpus: surface lists `UserService.find`, `slugify`, `UserEntity`; omits `hidden`
      and `warmUp`
- [ ] Full suite green

## Spec
- [ ] `mcp-handlers` delta: ADD PublicSurfaceNeverReportsAnUnassessedLanguageAsComplete,
      KotlinPublicSurfaceMembershipAndCompatibility
