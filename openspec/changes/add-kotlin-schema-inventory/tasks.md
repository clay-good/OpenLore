# Tasks: Kotlin schema inventory

## Implementation
- [x] Kotlin schema extractor; several models per file. Declarations and annotations come from
      the declaration scanner (the pinned grammar parses an annotation that opens a file outside
      the class node)
- [x] JPA: entity, table name, constructor and body properties, column annotations, relations
- [x] Spring Data relational, Room, Exposed (table objects and column functions)
- [x] Mapped superclass and embeddable resolution within the repository
- [x] `unresolved` names; `unmodeled-schema-framework` receipt
- [x] Add `.kt` to `SCANNED_SOURCE_EXTENSIONS` so the oversized-file disclosure covers Kotlin

## Conformance
- [x] One fixture per library row
- [x] Fixture: two entities in one file; nullable Kotlin type; `@Transient` excluded
- [x] Negative fixture: a project class named `Table` without the import gate yields nothing

## Verification
- [x] Reference corpus: `users` table with `id` and `display_name` (not null); `orders` Exposed
      table with `id`, `user_id`, `total`
- [ ] Full suite green (run once for the whole change set, in the pull request)

## Spec
- [x] `analyzer` delta: ADD KotlinSchemaModelsAreExtractedBehindImportGates
