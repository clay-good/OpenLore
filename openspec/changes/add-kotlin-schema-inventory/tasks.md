# Tasks: Kotlin schema inventory

## Implementation
- [ ] Kotlin schema extractor over the parse tree; several models per file
- [ ] JPA: entity, table name, constructor and body properties, column annotations, relations
- [ ] Spring Data relational, Room, Exposed (table objects and column functions)
- [ ] Mapped superclass and embeddable resolution within the repository
- [ ] `unresolved` names; `unmodeled-schema-framework` receipt
- [ ] Add `.kt` to `SCANNED_SOURCE_EXTENSIONS` so the oversized-file disclosure covers Kotlin

## Conformance
- [ ] One fixture per library row
- [ ] Fixture: two entities in one file; nullable Kotlin type; `@Transient` excluded
- [ ] Negative fixture: a project class named `Table` without the import gate yields nothing

## Verification
- [ ] Reference corpus: `users` table with `id`, `full_name` (not null), `email` (nullable)
- [ ] Full suite green

## Spec
- [ ] `analyzer` delta: ADD KotlinSchemaModelsAreExtractedBehindImportGates
