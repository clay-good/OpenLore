# Tasks — harden-pi-config-and-daemon-fidelity

> Status: **BUILT** (2026-08-16). The packaged daemon launch and late-daemon keepalive had already
> landed on `main`; this implementation preserves them and completes the remaining fidelity,
> deadline, diagnostic, and bounded-injection work.

## Implementation
- [x] Wizard merge-never-clobber: read raw config JSON, spread
      unknown top-level keys through the written object; preserve sibling generation.* on
      provider change while clearing provider-coupled model/compat fields; preserve embedding
      siblings on URL edits and remove the block only on explicit removal
- [x] Gate the auto-wizard on file absence, not `isUsableConfig`; refuse malformed/non-object
      existing config without changing its bytes
- [x] Bound daemon discovery plus injection orient under one 4-second first-turn deadline; on
      timeout use the existing pointer-line degraded block while useful discovery may finish
- [x] Preserve the packaged CLI launch and classify launch, preparation, early-exit, draining,
      and health-timeout failures with actionable text
- [x] Verify the already-shipped `daemons.set` → `startKeepalive()` ordering; do not negatively
      cache draining or just-late daemons
- [x] Cap `readSpecIndex` at 50 sorted domains + explicit overflow line; use the current event's
      `ctx.cwd`/`ctx.mode` rather than captured session state

## Verification
- [x] Wizard test: a config with enforcement.policy + impactCertificate.surfaces +
      contextInjection survives a wizard Save unchanged; provider change keeps generation siblings
- [x] Malformed-config test: explicit configuration refuses to open and leaves original bytes intact
- [x] Auto-open test: a usable provider-less config does NOT auto-open the wizard every session
- [x] Injection-timeout tests: wedged discovery and wedged orient each fall back to the pointer line
      within the timeout, first turn not blocked
- [x] Spawn tests: deterministic packaged launch error and exit-code fixtures report the real stage,
      never "run openlore analyze"
- [x] Keepalive/cache tests: late daemon ordering is pinned and retryable failure kinds bypass the
      long negative cache
- [x] Focused Pi suite green (71 tests); full suite green (7,934 passed / 415 files, 2 skipped);
      E2E suite green (187 tests / 21 files); lint, typecheck, build, packaged-extension smoke,
      npm pack dry-run, and strict main-spec validation green

## Spec
- [x] `mcp-quality` delta: ADD PiConfigWizardPreservesUnknownKeys,
      PiDaemonFailuresAreBoundedAndHonest, PiInjectedContextIsBoundedAndCurrent
