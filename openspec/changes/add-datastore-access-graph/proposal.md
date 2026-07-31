# Add the datastore access graph: which code reads and writes each table

> Status: PROPOSED (2026-07-27, substrate-whitespace sweep). OpenLore knows what the tables *are*
> and nothing about who touches them. Prior art for static query→table analysis: dbt's static
> analysis phase over rendered queries (https://docs.getdbt.com/docs/fusion/new-concepts),
> sqlglot-backed column lineage for dbt (https://github.com/Fszta/dbt-column-lineage), SQLMesh's
> integrated lineage.

## The gap

`schema-extractor.ts` parses ORM *model definitions* — Prisma, TypeORM, Drizzle, SQLAlchemy, JPA
(`src/core/analyzer/schema-extractor.ts:4`, `:27`) — and `get_schema_inventory` serves them. That
is a catalog of shapes. The question every schema change actually asks is the other one: **which
functions read this table, which write it, and what breaks if the column goes away?** Nothing
computes it. An agent asked to drop `users.legacy_id` has an inventory entry, a call graph, and no
edge between them.

This is the fourth instance of a shape OpenLore has already built three times — env vars
(`analyze_env_impact`), logs, errors — inventory → line-precise sites → upstream blast radius →
reaching tests. Data is the missing member. It is also the dependency the open
`add-migration-impact-certificate` names but does not own: that proposal joins a migration verdict
to "surviving readers", and nothing today can name a reader.

## What changes

**`analyze_datastore_impact`** (`--preset full`; CLI `openlore datastore-impact --table <name>`),
plus the extraction that feeds it:

- **Access sites, not just definitions.** During the existing AST walk, ORM query calls
  (`prisma.user.findMany`, `session.query(User)`, `db.select().from(users)`, repository/entity
  manager calls) and SQL string literals are matched against a closed pattern table — the same
  bounded-regex discipline `schema-extractor.ts` already uses, for the same reason (no new grammar,
  no dialect engine, measured bounds). Each site yields `{ table, columns?, access: read | write |
  ddl, file, line, enclosingFunction, confidence }`.
- **`datastore::<table>` nodes** joined to the call graph, so backward reachability answers
  "which functions transitively touch this table" and `select_tests` answers "which tests reach a
  writer" with no new traversal machinery.
- **Confidence tiers, disclosed per site.** `resolved` (a literal table name in an ORM call or a
  static SQL literal); `partial` (a static SQL literal whose columns could not be attributed —
  the table is claimed, the columns are not); `unresolvable` (a dynamically-built query string,
  an ORM call on a receiver the resolver refused to guess). Unresolvable sites are **counted and
  listed in `boundaries`**, so the answer is a stated lower bound, never a confident empty set.
- **Column granularity only where it is honest**: a column is attributed when it appears
  literally in the site. `SELECT *`, dynamic projections, and ORM calls without an explicit
  selection report table-level access with the column set explicitly `unknown` — not empty.

Deliberately NOT borrowed from the prior art: a SQL dialect engine or parser dependency (no
grammar is added; unparseable SQL is disclosed, not approximated), warehouse/catalog connections
of any kind, transformation-model DAG semantics, and column-level lineage *through* SQL
expressions — the join tree inside a query is out of scope and says so.

## Why this is in scope

It is the same deterministic inventory→sites→radius→tests conclusion the substrate already serves
three times, applied to the layer where a wrong answer is most expensive, with no LLM and no
runtime. It unblocks `add-migration-impact-certificate` (cross-referenced, not modified: that
change owns the migration *verdict*, this one owns *who reads the table*) and gives
`analyze_impact` a bridge into the data layer that a call graph alone cannot cross.

## Impact

- Touches: `src/core/analyzer/schema-extractor.ts` (access-site extraction alongside definition
  parsing), the walk that already visits these files, a new handler under
  `src/core/services/mcp-handlers/`, and a CLI command.
- Tool surface: +1 tool in `--preset full` only; family `navigate`; registered `conclusion` in
  `TOOL_CAPABILITY_FAMILY` and cross-referencing its siblings (`get_schema_inventory` for shapes,
  `analyze_env_impact` for the same shape on config).
- Specs: `mcp-handlers` — 1 ADDED (DatastoreAccessSitesAreConclusionsWithDisclosedConfidence).
- Risk: pattern-table coverage rots as ORMs evolve (mitigated: an ORM the table does not cover
  produces *no* sites for its files and that file set is disclosed as unscanned — the failure mode
  is a stated gap, not a silent one); regex cost on hostile files (mitigated: the bounded-pattern
  discipline and measurement precedent already established in `schema-extractor.ts:69-73`).
