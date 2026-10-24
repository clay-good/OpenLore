# analyzer spec delta

## ADDED Requirements

### Requirement: KotlinSchemaModelsAreExtractedBehindImportGates

The analyzer SHALL extract data-model schemas from Kotlin source for JPA and Hibernate entities,
Spring Data relational entities, Room entities, and Exposed table objects, each only in a file that
imports that library's package. Every model in a file SHALL be extracted. Columns SHALL be read from
primary-constructor properties and body properties, with the column name from the library's column
annotation or column function when a string literal is written, and the property name otherwise.
Nullability SHALL be taken from the declared Kotlin type and from an explicit nullability argument.
Properties marked transient or ignored SHALL be excluded. Relations declared by annotation or by an
Exposed reference SHALL be recorded. A table or column name that is not a string literal SHALL be
recorded as unresolved. Each record SHALL name its framework. A Kotlin file that imports a known
persistence library that is not modeled SHALL be counted in a disclosed receipt.

#### Scenario: A JPA data class is extracted

- **GIVEN** a file that imports `jakarta.persistence` and declares
  `@Entity @Table(name = "users") data class UserEntity(@Id val id: Long, @Column(name = "full_name", nullable = false) val name: String, val email: String?)`
- **WHEN** schemas are extracted
- **THEN** one model `users` exists with columns `id` (primary key), `full_name` (not null), and
  `email` (nullable), and framework `jpa`

#### Scenario: An Exposed table object is extracted

- **GIVEN** a file that imports `org.jetbrains.exposed.sql` and declares
  `object Orders : Table("orders") { val id = integer("id").autoIncrement(); val userId = reference("user_id", Users) }`
- **WHEN** schemas are extracted
- **THEN** one model `orders` exists with columns `id` and `user_id`, and a relation to `Users`

#### Scenario: Several models in one file are all extracted

- **GIVEN** one Kotlin file that declares two `@Entity` classes
- **WHEN** schemas are extracted
- **THEN** two models are reported

#### Scenario: A class without the import gate is ignored

- **GIVEN** a Kotlin file that declares `object Users : Table("users")` where `Table` is a project
  class and no persistence library is imported
- **WHEN** schemas are extracted
- **THEN** no model is reported

#### Scenario: A computed name is not guessed

- **GIVEN** `@Table(name = PREFIX + "users")`
- **WHEN** schemas are extracted
- **THEN** the model's table name is reported as unresolved
