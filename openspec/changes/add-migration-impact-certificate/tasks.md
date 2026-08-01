# Tasks — add migration impact certificate

## Implementation
- [ ] Migration scanner: changed migration files (raw SQL) + ORM schema diffs (models the
      schema extractor already parses); pattern-based statement classification, no new grammar
- [ ] Closed rule registry: `destructive` / `lock-hazardous` / `safe-shape` rules, each a
      registered finding code in `FINDING_CODE_REGISTRY` (advisory default); unparsed statement
      → `unassessed`, disclosed with count
- [ ] Code join: target table/column → schema inventory entry → referenced-identifier search →
      enclosing functions → backward reachability → reaching tests; join labeled name-based
      sound-lower-bound
- [ ] `certify_migration` MCP handler (family `change`, class `conclusion`; siblings:
      `get_schema_inventory`, `analyze_env_impact`) + `openlore certify-migration
      [--base <ref>] [--json]`; base via `resolveBaseRefDisclosed`, fatal on bad base
- [ ] `change_impact_certificate`: data-boundary surface type wired in

## Verification
- [ ] DROP COLUMN fixture with live readers → destructive finding naming functions, files,
      lines, and reaching tests
- [ ] Prisma model field removal → same conclusion via the ORM path
- [ ] Non-concurrent CREATE INDEX → lock-hazardous; concurrent variant → safe-shape
- [ ] Additive nullable column with no readers → safe-shape, empty join disclosed as
      lower-bound ("no reference found in the index")
- [ ] Unparsable statement → `unassessed` disclosed, never safe
- [ ] tools/list payload budget re-asserted or bumped with rationale

## Spec
- [ ] `mcp-handlers` delta: ADD MigrationImpactIsCertifiedAgainstTheGraph
