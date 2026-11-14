# Tasks: datastore access sites and migration targets

## 1. Access-site facts

- [ ] 1.1 Add a closed pattern table for ORM query calls (Prisma, TypeORM, Drizzle, SQLAlchemy, JPA) and static SQL literals to `src/core/analyzer/schema-extractor.ts`; emit `{ table, columns?, access, file, line, enclosingFunction, confidence }`. Test: `src/core/analyzer/schema-extractor.test.ts`. Done when one fixture per ORM yields the correct read/write class, `SELECT *` yields columns `unknown`, and a run-time-built query yields `unresolvable` with its line.
- [ ] 1.2 Store the sites with the schema inventory in `src/core/analyzer/analysis-core.ts` (the `extractSchemas` call) so handlers read them from the cached analysis. Test: `src/core/analyzer/schema-extractor.test.ts`. Done when a second analyze run returns byte-identical sites and a hostile SQL-literal file completes within the per-file budget.
- [ ] 1.3 List files that import a data-access library outside the pattern table as not scanned. Test: `src/core/analyzer/schema-extractor.test.ts`. Done when such a fixture file appears in the not-scanned list and adds no site.

## 2. Migration targets

- [ ] 2.1 New `src/core/services/migration-targets.ts`: from the diff, list dropped or narrowed tables and columns in raw SQL migration files (pattern-based) and in removed or narrowed ORM model fields (compare `extractSchemas` output at the merge-base, read through `src/utils/git-blobs.ts`). Test: new `src/core/services/migration-targets.test.ts`. Done when `DROP COLUMN`, `DROP TABLE`, a type narrowing and a removed Prisma field each yield one target, and an unreadable statement is counted as not assessed.
- [ ] 2.2 In the same file, join each target to its access sites, enclosing functions and reaching tests (reuse `src/core/services/mcp-handlers/test-impact.ts`). Test: `src/core/services/migration-targets.test.ts`. Done when a dropped column with three readers names all three with file and line, and a column with no site reads "no reference found in the index".

## 3. Delivery on existing answers

- [ ] 3.1 Add `datastoreAccess` and `datastoreNotAssessed` to `src/core/services/mcp-handlers/blast-radius.ts`. Test: `src/core/services/mcp-handlers/blast-radius.test.ts`. Done when a diff that edits a writer function lists its table, and both fields are absent when the diff touches no datastore code.
- [ ] 3.2 Register `migration-target-still-used` (advisory) in `FINDING_CODE_REGISTRY` in `src/core/services/mcp-handlers/enforcement-policy.ts` and emit it from `src/core/services/mcp-handlers/verify-change.ts`. Tests: `enforcement-policy.test.ts`, `verify-change.test.ts`. Done when the drop-column fixture yields one finding with function, file, line and tests, and a target with no site yields no finding.
- [ ] 3.3 Classify `datastoreNotAssessed` in `src/core/services/mcp-handlers/confidence-boundary.ts`. Test: `completeness-invariant.test.ts`. Done when an unresolvable site makes `confidenceBoundary.complete` false.

## 4. Parity and docs

- [ ] 4.1 Update the MCP↔Pi parity guard for the new `blast_radius` and `verify_change` fields in `src/pi/extension.test.ts`. Done when the parity test passes.
- [ ] 4.2 Document the fields, the finding and the limits in `docs/mcp-tools.md` and `docs/cross-domain-impact.md`. Done when `src/doc-claim-sync.test.ts` passes.
