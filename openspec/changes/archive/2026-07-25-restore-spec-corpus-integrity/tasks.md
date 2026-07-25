# Tasks — restore spec-corpus integrity

## Implementation
- [x] Delete phantom specs: auth/, task/, validator/; phantom half of project/ (keep
      ProjectTypeValidation); phantom api requirements incl. APIAuthentication
- [x] Hand-rewrite overview/spec.md: real purpose, real domain table (live links only), substrate
      architecture, north-star requirement + decision block preserved
- [x] Prune vacuous auto-gen requirements (template scenarios) from config (tightened), llm
      (deleted), project (deleted); itemized in the PR
- [x] Dedupe cross-domain synced decisions: one canonical copy in the owning domain, pointers
      elsewhere (18 verbatim non-owner copies pointer-ized across 14 same-name forks; requirements
      that merely cite a shared decision under a DIFFERENT name are distinct and left intact)
- [x] Dedupe duplicate requirement names within a domain (analyzer, api, llm, openspec)
- [x] Update drift mappings for deleted/renamed requirements — the spec map is rebuilt from the
      specs dir (buildSpecMap reads disk), so deletions/renames self-update; no hardcoded domain
      list existed
- [x] CI corpus lint: no vacuous-scenario template, no dead domain link, no duplicate requirement
      name within a domain, no domain-table entry without a spec file, no cross-domain forked
      decision text (src/spec-corpus-lint.test.ts)

## Verification
- [x] `openlore audit` clean post-purge (0 orphan requirements, 0 stale domains)
- [x] get_spec returns no phantom content (auth/task/validator absent; overview/project refreshed)
- [x] CLAUDE.md's @overview include renders the corrected purpose
- [x] Full suite green (5858 passed / 2 skipped); typecheck clean; the 15 vacuous-template
      scenarios eliminated

## Spec
- [x] `openspec` delta: ADD SpecCorpusContainsOnlyCodeBackedRequirements (promoted into
      openspec/specs/openspec/spec.md)

## Notes / scope
- The auto-generated "Unnamed" scenario *names* in the large specs (analyzer/api/cli/generator)
  carry real GIVEN/WHEN/THEN content, so they are NOT the vacuous template and are left intact —
  the lint targets the phantom placeholder template precisely, not auto-gen naming.
- The forward discipline (scoping future decision syncs to one owning domain) shipped separately in
  `delegate-lifecycle-scope-decision-sync` (#236); this change is the one-time corpus repair.
