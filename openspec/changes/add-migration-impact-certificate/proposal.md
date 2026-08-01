# Add migration impact certificate: what this migration breaks, joined to the code

> Status: PROPOSED (2026-07-27, ecosystem research sweep). For schema migrations in a diff, a
> deterministic per-statement verdict (destructive / lock-hazardous / safe-shape) joined with
> what no SQL linter can know: which indexed functions still reference the dropped or narrowed
> column, and which tests reach them. Prior art for the rule tables: Squawk
> (https://squawkhq.com/docs/rules) and Atlas migration linting (https://atlasgo.io) — both lint
> SQL in isolation; the code-join is the OpenLore-shaped half.

## The gap

Migrations are the highest-blast-radius files agents touch, and OpenLore currently sees them as
opaque text. The substrate already inventories the data model — `get_schema_inventory` over the
ORM extractors (`src/core/analyzer/schema-extractor.ts`: Prisma, TypeORM, Drizzle, SQLAlchemy,
JPA, with per-model fields and lines) — but nothing connects a `DROP COLUMN` in a migration to
the three functions that still read that column and the two tests that reach them. SQL linters
(the prior art) classify statement risk correctly and stop at the file boundary; the join to
call-graph consumers and reaching tests is exactly the move OpenLore has now made four times
(env vars, log anchors, error propagation, routes).

## What changes

- **A migration rule table, closed and registered**: statements in changed migration files are
  scanned (pattern-based, no new grammar in v1 — the schema extractor's own discipline) and
  classified against a fixed registry: `destructive` (DROP TABLE/COLUMN, type narrowing),
  `lock-hazardous` (non-concurrent index creation, volatile-default column adds, NOT NULL on an
  existing column), `safe-shape` (additive nullable column, concurrent index). Each rule is a
  registered governance finding code (`FINDING_CODE_REGISTRY`), advisory by default. An
  unparsed statement is disclosed `unassessed` — never silently safe.
- **The code join**: each destructive/narrowing target is resolved against the schema inventory
  (model → fields → declaring file/line) and referenced-identifier search over the indexed
  corpus; hits resolve to enclosing functions, upstream blast radius via backward reachability,
  and reaching tests via the existing selection machinery. Output names the survivors: "DROP
  COLUMN `invoices.subtotal`: still read by `getInvoiceTotals`
  (`src/billing/totals.ts:88`) and 2 more; 4 reaching tests."
- **Scope honesty**: v1 covers raw-SQL migration files plus schema diffs of the ORMs the
  extractor already parses (a removed field in a Prisma model is the same conclusion from the
  other end). Dynamic column names, string-built SQL, and unsupported dialect constructs land in
  `boundaries` with counts. The referenced-identifier join is disclosed as name-based (an ORM
  alias the index can't see is a known-unknowable, not an absence).
- **Delivery**: a `certify_migration` conclusion tool (opt-in `--preset full`) +
  `openlore certify-migration [--base <ref>] [--json]`, and a surface type inside
  `change_impact_certificate` so a declared data boundary participates in the existing
  certificate flow. Sibling cross-references: `get_schema_inventory` (the inventory this
  concludes over) and `analyze_env_impact` (the same shape for config).

Deliberately NOT borrowed: auto-generation of safe migration rewrites (write-side; out of
scope), dialect-complete SQL parsing (rule patterns + honest `unassessed` beat a half-supported
grammar), and any live-database inspection (static only, per the north star).

## Why this is in scope

The fourth instantiation of OpenLore's proven conclusion shape (inventory → read sites → blast
radius → tests), pointed at the artifact class with the worst failure mode. Deterministic rule
tables + existing joins; no LLM, no runtime, no new artifact.

## Impact

- New: migration scanner + rule registry, join module, `certify_migration` handler + CLI. Tool
  registered in `TOOL_CAPABILITY_FAMILY` (`change`), classified `conclusion`; tools/list payload
  budget re-asserted or consciously bumped.
- Specs: `mcp-handlers` — 1 ADDED requirement.
- Risk: dialect breadth pressure (mitigated: closed rule registry, `unassessed` disclosure, one
  dialect family at a time with fixtures); false comfort from the name-based join (mitigated:
  the verdict's join is labeled a sound lower bound — "no reference found in the index" is
  distinct from "unreferenced").
