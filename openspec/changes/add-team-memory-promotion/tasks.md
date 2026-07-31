# Tasks — add team memory promotion

## Implementation
- [ ] Team store reader: `.openlore/memory/team/*.json`, canonical JSON, one memory per file;
      malformed file → disclosed skip, never a crash or silent drop
- [ ] `openlore memory promote <id>`: copy local memory verbatim (stable id, anchors, content
      hash, provenance); run secret-redaction scan first and refuse on findings; never
      auto-commit
- [ ] `gitignore-manager.ts`: keep `.openlore/memory/team/` tracked while local memory stays
      ignored
- [ ] `recall`: merge local + team stores; label each result `tier: local | team`; same-anchor
      contradictions flow through the existing unreconciled machinery with tiers disclosed
- [ ] Continuity carry-forward walks the team store too (anchors re-pointed at analyze)

## Verification
- [ ] Promote → file exists, id/content-hash stable; re-promote is idempotent (byte-identical)
- [ ] Secret in content → promote refuses with the redaction finding
- [ ] Recall merges tiers; local-vs-team contradiction on one anchor → unreconciled with tiers
- [ ] Team memory anchor renamed → carried across on next analyze (carriedAcross provenance)
- [ ] Clone-fresh checkout (no local store) serves team memories with freshness verdicts
- [ ] Malformed team file → disclosed skip, other memories still served

## Spec
- [ ] `mcp-handlers` delta: ADD TeamMemoryIsPromotedThroughReview
