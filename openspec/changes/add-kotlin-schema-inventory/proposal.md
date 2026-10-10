# Extract Kotlin data-model schemas

> Status: PROPOSED (2026-10-10, issue #546). Part of `KOTLIN-TOTAL-SUPPORT-2026-10.md`.
> Deterministic, no LLM, no new dependency.

## What you get

`get_schema_inventory` lists the tables and columns a Kotlin project declares.

## What is missing today

`extractSchemas` dispatches by extension: `.java` (JPA), `.prisma`, `.py`, `.ts` (`schema-extractor.ts:353-381`).
A `.kt` file gets `[]` with no disclosure. The Java field pattern needs
`private|protected|public Type name` (`:257-258`), which cannot match a Kotlin property, and it
reads one class per file. The reference fixture has `@Entity @Table(name = "users") data class
UserEntity(...)`; the inventory is empty.

## What changes

Extraction reads the Kotlin parse tree, gated on the library import. A file may declare many
models.

| Library | Import gate | Table | Columns |
|---|---|---|---|
| JPA / Hibernate | `javax.persistence` or `jakarta.persistence` | `@Entity` class; name from `@Table(name=)`, else the class name | constructor and body properties; name from `@Column(name=)`; `@Id`, nullability from the Kotlin type (`String?`) and from `nullable =`; `@Transient` excluded; relations from `@OneToMany` / `@ManyToOne` / `@OneToOne` / `@ManyToMany` / `@JoinColumn` |
| Spring Data JDBC / R2DBC | `org.springframework.data.relational.core.mapping` | class with `@Table("name")` | properties; `@Column("name")`; `@Id` |
| Room | `androidx.room` | `@Entity(tableName=)`, else the class name | properties; `@ColumnInfo(name=)`; `@PrimaryKey`; `@Ignore` excluded; `@ForeignKey` relations |
| Exposed | `org.jetbrains.exposed` | `object X : Table("name")` and `IntIdTable` / `LongIdTable` / `UUIDTable` subclasses; when no name is written, the object name without a trailing `Table` | `val c = integer("name")` and the other column functions; `.nullable()`, `.primaryKey()` / `override val primaryKey`, `.references(T.c)` and `reference("name", T)` |

Rules:

- A name comes from a string literal. A name built from any other expression is recorded as
  `unresolved`, never guessed.
- `@MappedSuperclass` and `@Embeddable` columns are attached to the entities that extend or embed
  them when the type resolves in the repository; otherwise the entity lists the embedded type by
  name.
- Each record carries its framework (`jpa`, `spring-data-relational`, `room`, `exposed`).
- A Kotlin file that imports a known persistence library that is not modeled (Ktorm, jOOQ, Komapper,
  SQLDelight runtime) is counted in an `unmodeled-schema-framework` receipt.

## Not in scope

- SQLDelight `.sq` files and migration SQL: they are not Kotlin source.
- `kotlinx.serialization` data classes: they describe wire formats, not stores.
- Column types beyond the declared Kotlin type name or the Exposed column function name.

## Impact

- `schema-extractor.ts`, `bounded-file-scan.ts` (`.kt` in the scanned-extension list).
- Specs: `analyzer`, 1 ADDED requirement.
- Risk: low. The extractor is additive and gated.
