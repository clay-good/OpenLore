# Tasks — harden-openspec-writer-fidelity

## Implementation
- [x] mergeSpec (openspec-writer.ts:310-340): backupFile before merge (honor createBackups);
      preserve content after the generated section via a bounded end marker / next ## heading
      instead of truncating to EOF
- [x] Suppress cleanBeforeWrite whenever a domains filter is active (api/generate.ts:273-302,
      writer :165-193); align CLI --force behavior with its help text (cli/commands/generate.ts:248)
- [x] Populate report.validationErrors/warnings (path-prefixed) from validateFullSpec
      (openspec-writer.ts:271-289); document validation as advisory; make the :433 next-step
      branch live
- [x] Recursive stale-domain backup (fs.cp) and scope the catch to the readdir-missing case
      (:170-192)

## Verification
- [x] Merge test: human notes appended below the generated section survive a re-merge, and a
      backup exists
- [x] Domain-scope test: openloreGenerate({domains:['auth'], force:true}) leaves other domain
      directories intact
- [x] CLI-force test: `--force` behaves as its help states (one consistent meaning)
- [x] Validation test: an invalid spec populates report.validationErrors (not always empty)
- [x] Backup test: a domain directory containing a subdirectory backs up completely; cleanup
      does not half-abort
- [x] Full suite green

## Spec
- [x] `openspec` delta: ADD MergeNeverDeletesHumanContent, DomainFilterDoesNotAuthorizeDeletion,
      StaleDomainCleanupIsRecursiveAndComplete
- [x] `validator` delta: ADD ValidationResultsReachTheReport
