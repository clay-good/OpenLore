# Tasks

- [x] 1.1 `managedHooks(…, scope)`: user scope wires every hook with `--scope user`; loop moments get `USER_SCOPE_PROJECT_GUARD`. Test: `user-scope.test.ts`.
- [x] 1.2 `repoWiresStep`, `isUserScopeCommand` (`hook-wiring-health.ts`); `openlore hook --scope user` and `openlore orient --scope user` stand down. Tests: `hook.test.ts`, `user-scope-loop-hooks.test.ts`.
- [x] 1.3 Doctor duplicate rule. Test: `user-scope-loop-hooks.test.ts`.
- [x] 1.4 The guard run by a real POSIX shell, with and without `.openlore/`, with and without `CLAUDE_PROJECT_DIR`.
- [x] 1.5 End to end: a real user-scope install into a temporary home, its written commands run through `sh`.
