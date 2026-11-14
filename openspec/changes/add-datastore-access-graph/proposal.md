# Show which code reads and writes each table, and what a migration breaks

> Priority: P3 · Not built
> Reaches the agent through: `blast_radius`, `verify_change` (and so the before-stop moment)
> Why it helps the agent: before it drops or narrows a column, it sees the functions and tests that still use that column.

Folds in `add-migration-impact-certificate` (removed; restore from commit 0dd75dbef).

## Problem

OpenLore knows the shape of each table. `schema-extractor.ts` parses the model definitions of
Prisma, TypeORM, Drizzle, SQLAlchemy and JPA. It does not know which code touches a table. An agent
that drops `users.legacy_id` in a migration gets no warning about the three functions that still
read that column. To OpenLore, a migration file is plain text. The agent must search by hand or
guess.

## What changes

- **Access sites (analyzer fact).** `schema-extractor.ts` gains a closed, bounded pattern table for
  ORM query calls of the five ORMs it already parses, and for static SQL string literals. Each site
  records `{ table, columns?, access: read | write | ddl, file, line, enclosingFunction, confidence }`.
  Confidence is `resolved`, `partial` (table known, columns not), or `unresolvable` (the query text
  is built at run time). The sites are facts on existing functions. No new graph node type.
- **`blast_radius` field `datastoreAccess`.** For each changed function: the tables and columns it
  reads or writes, with file and line. For a changed model definition: the access sites of that
  table and the tests that reach them (existing `select_tests` reachability).
- **Migration targets.** When the diff changes a raw SQL migration file or removes or narrows a
  field in a supported ORM model, OpenLore lists the dropped or narrowed tables and columns. It
  joins each target to its access sites, the functions that contain them, and the reaching tests.
- **`verify_change` advisory finding `migration-target-still-used`.** One finding per target that
  still has an access site. The message names the function, file, line and the tests to run.
  Example: "DROP COLUMN `invoices.subtotal`: still read by `getInvoiceTotals`
  (`src/billing/totals.ts:88`) and 2 more; 4 reaching tests." The agent fixes the readers, or
  records why the drop is safe, or raises it in its final message.
- **Field `datastoreNotAssessed`** on both answers: counts and locations of unresolvable sites,
  migration statements the scanner could not read, and files that use an ORM outside the pattern
  table.

## What does not change

- No new MCP tool, preset or CLI command. `analyze_datastore_impact` and `certify_migration` are
  not built. `get_schema_inventory` keeps its name and output.
- The finding is advisory. It is registered in `FINDING_CODE_REGISTRY`, so an operator can opt in to
  blocking.
- Local and static only. No database connection, no query execution, no LLM, no SQL parser
  dependency.
- Works without OpenSpec. The facts come from code, tests and the diff.

## Limits we disclose

- The join is by name and is a lower bound. An empty join reads "no reference found in the index",
  never "unreferenced".
- A column is attributed only when it appears literally at the site. `SELECT *` and dynamic
  projections report table-level access with columns `unknown`.
- A migration statement the scanner cannot classify is counted as not assessed, never as safe.
- Only drop and narrow are assessed. Lock hazards (for example a non-concurrent index build) are
  out of scope.
- ORMs covered: Prisma, TypeORM, Drizzle, SQLAlchemy, JPA. Files that use another library are
  listed as not scanned.

## Depends on

Nothing. It uses shipped code: `schema-extractor.ts`, `select_tests` reachability, and the
merge-base blob reader in `src/utils/git-blobs.ts`.
