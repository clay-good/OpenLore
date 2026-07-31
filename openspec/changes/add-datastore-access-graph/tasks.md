# Tasks — add datastore access graph

## Implementation
- [ ] Extend `schema-extractor.ts` with a closed, bounded pattern table for ORM query call sites
      (Prisma, TypeORM, Drizzle, SQLAlchemy, JPA — the ORMs whose definitions it already parses)
      and for static SQL string literals
- [ ] Emit per site `{ table, columns?, access: read | write | ddl, file, line, enclosingFunction,
      confidence: resolved | partial | unresolvable }`
- [ ] Synthesize `datastore::<table>` nodes/edges into the graph so existing backward reachability
      and `select_tests` work unchanged
- [ ] `analyze_datastore_impact` handler: table → sites, upstream affected functions, reaching
      tests, declared schema entry (from the existing inventory), `boundaries`
- [ ] `boundaries` names: unresolvable sites (counted + located), files whose ORM is not in the
      pattern table, `SELECT *` / dynamic projections (columns `unknown`), and index staleness
- [ ] Unknown table → not-found + candidates, never an empty "unused"
- [ ] CLI `openlore datastore-impact --table <name> [--json]`; register family + conclusion class
      in `TOOL_CAPABILITY_FAMILY`; cross-reference `get_schema_inventory` and `analyze_env_impact`
- [ ] Pi extension parity: decide and record whether the native tool set / injection carries it

## Verification
- [ ] Read vs write classification across all five ORMs (fixtures per ORM)
- [ ] Blast radius: a caller three hops above a writer is in `affectedFunctions`; an unrelated
      function is not
- [ ] Reaching tests match `select_tests` for the same seed set
- [ ] `SELECT *` reports table-level access with columns `unknown`, not an empty column list
- [ ] A dynamically-built query string is `unresolvable` and appears in `boundaries` with its line
- [ ] A file using an ORM outside the pattern table is disclosed as unscanned
- [ ] Unknown table returns not-found with candidates
- [ ] Bounded-cost guard: hostile SQL-literal file completes within the per-file budget
- [ ] Conclusion-shape assertion passes at dispatch; tool-contract test passes

## Spec
- [ ] `mcp-handlers` delta: ADD DatastoreAccessSitesAreConclusionsWithDisclosedConfidence
