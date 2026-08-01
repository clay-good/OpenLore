# The spec writer deletes human content on merge, discards validation results, and over-deletes domains that a filter never meant to remove

> Status: PROPOSED (2026-07-03, e2e audit pass 4). Four fidelity defects in the shared
> `OpenSpecWriter` (driven by both the CLI and the API generate paths). They share a theme:
> the writer loses or misreports user content while reporting success. Distinct from
> `restore-spec-corpus-integrity` (one-time content repair) and `delegate-lifecycle-scope-decision-sync`
> (archive-time delta merge).

## The gap

- **(a) Merge mode deletes trailing human content with no backup.** `mergeSpec`
  (`openspec-writer.ts:310-340`) replaces everything from the first `## Generated Analysis`
  marker to EOF and — unlike the replace path — never calls `backupFile`, even with
  `createBackups: true`. A user who appends notes below the generated section loses them on the
  next `writeMode: 'merge'`, from the one write path with no backup to recover from.
- **(b) `force` + a domains filter deletes the unlisted domains.** `api/generate.ts:302` maps
  `force: true` to `cleanBeforeWrite: true`; the writer computes `incomingDomains` from the
  already-domain-filtered spec list (`:165-193`) and `rm -r`s every other domain directory
  under `openspec/specs/`. Because the domain filter runs *before* the writer sees the list
  (`api/generate.ts:273-278`), filtering IS the stale-marking:
  `openloreGenerate({ domains: ['auth'], force: true })` on an 18-domain repo removes 17 domain
  directories (backed up under `.openlore/backups/`, reported only as `domainsRemoved`).
  Conversely the CLI's `--force` help promises "remove stale domains" (`cli/commands/generate.ts:248`)
  but the CLI never passes `cleanBeforeWrite` — the flag under-delivers on the CLI and
  over-deletes on the API.
- **(c) Validation results are computed then discarded.** With `validateBeforeWrite: true` the
  writer runs `validateFullSpec` but sends errors only to `logger.warning`
  (`openspec-writer.ts:271-274,285-289`); nothing populates `GenerationReport.validationErrors`,
  so the machine-readable report always claims clean validation, and the "Fix validation
  errors" next-step branch (`:433`) is dead code. Invalid specs are always written (validation
  never gates).
- **(d) The stale-domain backup is shallow and its failure is mislabeled-swallowed.** The
  pre-removal backup does a non-recursive `readdir` + `copyFile` (`:170-192`); a subdirectory
  inside a domain dir makes `copyFile` throw `EISDIR`, caught by the outer catch whose comment
  says "specsDir doesn't exist yet" — silently aborting cleanup mid-loop with an incomplete
  `domainsRemoved` and no warning.

## What changes

1. **Never lose human content on merge:** back up before merge (honor `createBackups`), and
   preserve content after the generated section using a bounded end marker (or the next `## `
   heading) rather than truncating to EOF.
2. **Don't treat a domain filter as a delete list:** suppress `cleanBeforeWrite` whenever a
   `domains` filter is active (filtering scopes the write, it does not authorize removing the
   rest); align the CLI `--force` behavior with its help text so the flag means one thing.
3. **Surface validation results:** populate `report.validationErrors`/`warnings` (path-prefixed)
   from `validateFullSpec`; document that validation is advisory (specs still write) so the
   dead next-step branch becomes live and the report stops claiming clean unconditionally.
4. **Make the stale-domain backup recursive and scope its catch** (`fs.cp` semantics; the catch
   covers only the readdir-missing case), so cleanup can't half-abort silently.

## Why this is in scope

The spec corpus is a first-class artifact agents and humans both read; a writer that silently
deletes appended notes, removes domains a user only meant to scope past, and reports clean
validation for invalid specs erodes trust in the generated specs directly. All four are
local, deterministic write-path corrections.

## Impact

- Files: `src/core/generator/openspec-writer.ts` (merge backup + preserve-tail, cleanBeforeWrite
  gating, validation-to-report, recursive backup + scoped catch), `src/api/generate.ts` +
  `src/cli/commands/generate.ts` (force/domains interaction, help alignment).
- Specs: `openspec` — 3 ADDED (MergeNeverDeletesHumanContent, DomainFilterDoesNotAuthorizeDeletion,
  StaleDomainCleanupIsRecursiveAndComplete); `validator` — 1 ADDED
  (ValidationResultsReachTheReport).
- No new tool. Risk: low-medium — the cleanBeforeWrite gating changes a destructive default's
  scope (safer); the merge-tail preservation needs a clear boundary marker. Verify: appended
  notes survive a merge; a scoped `domains` generate leaves other domains intact; an invalid
  spec populates `validationErrors`; a domain dir with a subdirectory backs up fully.
