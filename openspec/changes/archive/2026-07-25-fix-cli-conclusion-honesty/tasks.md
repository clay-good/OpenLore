# Tasks — uniform CLI conclusion honesty

## Implementation
- [x] Shared base-ref helper: resolve-or-disclose with structured baseRefFallback; certification
      commands (certify-public-surface, impact-certificate) error on unresolvable requested ref
      unless --allow-base-fallback
- [x] Shared staleness helper (index commit + changed-file count); adopt in blast-radius and
      briefing-since (certify-public-surface already emits it)
- [x] style-fingerprint --language <unknown>: not-found shape, exit 1, known languages listed
- [x] features: federation health from resolvability verdicts, not registry count
- [x] Parity guard test: every --base / cached-graph command routes through the helpers

## Verification
- [x] certify-public-surface --base not-a-ref exits non-zero naming the ref; with
      --allow-base-fallback returns disclosed fallback
- [x] blast-radius/briefing-since on a stale index carry the staleness boundary (live repro from
      the audit re-run)
- [x] features shows degraded federation when peers unresolvable
- [x] Full suite green

## Spec
- [x] `cli` delta: ADD BaseRefResolutionIsDisclosedOrFatal, ConclusionCommandsDiscloseIndexStaleness
