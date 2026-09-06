# Tasks — unify-onboarding-entrypoint

## Implementation
- [x] Adapter capability `supportsGlobal` + user-scope apply/uninstall for claude-code
      (user-level MCP registration, user-level SessionStart/UserPromptSubmit hooks, user
      CLAUDE.md managed block), reusing the existing marker/sentinel merge helpers
      (src/cli/install/adapters/claude-code.ts)
- [x] Bare `openlore install` defaults to user-scope wiring (+ immediate wiring/index of the
      current repo when run inside one), routed through the same runInstall engine
      (src/cli/install/index.ts:149-267); `--repo-only` escape hatch; adapters without user
      scope fall back per-repo with a note, never fail; `--uninstall` removes managed
      entries from both scopes
- [x] Auto-init guardrails in cold-start-bootstrap.ts: git-work-tree check; `autoInit:false`
      config opt-out (alongside OPENLORE_NO_AUTO_ANALYZE); file-count ceiling → signatures/
      BM25-only degraded build with disclosure; first-touch one-line notice threaded into the
      freshness note
- [x] Every EXPLICIT repo wiring includes the decisions pre-commit hook in autopilot mode by
      default; `setup --tools claude` gate wiring is now a thin alias for the same helper.
      SCOPE DECISION: background auto-init deliberately does NOT write git hooks — see the
      `AutoInitIsConsentGuarded` delta
- [x] postinstall.mjs hint stays `openlore install`; docs + `connect list` show global scope
      in the status table

## Verification
- [x] Global-wiring tests: fresh HOME → bare `install` writes user-scope entries once (and
      wires the current repo when inside one); re-run is a no-op; `--repo-only` writes no
      user-scope entry; per-repo entries take precedence; uninstall removes only ours
- [x] Guardrail tests: non-git dir never bootstraps; `autoInit:false` suppresses; oversized
      tree gets degraded build + disclosure; first-touch notice appears exactly once per repo
- [x] Gate-wiring test: bare `install` installs the hook in autopilot mode; blocking mode
      only via explicit opt-in
- [x] Full suite green; `openspec validate unify-onboarding-entrypoint` at archive time
