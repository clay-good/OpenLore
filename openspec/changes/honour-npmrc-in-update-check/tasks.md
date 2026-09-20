# Tasks

## 1. Transport

- [x] 1.1 Ask npm for the published version (`npm view openlore@latest version --json`, fixed argv, no shell), resolving the executable through `resolvePlatformCommand` and `npm_execpath`. Verify with the invocation unit tests, including the Windows entry point.
- [x] 1.2 Fall back to the direct registry URL only on `ENOENT`, and keep every other failure fail-silent. Verify with the fallback and failure tests.
- [x] 1.3 Run the lookup in the user's home directory, never in the analyzed repository. Verify with the test asserting `npmViewCwd()` and the `cwd:` call site.
- [x] 1.4 Detach the background child process and kill it when the parent exits. Verify with the `terminateChildOnParentExit` test.
- [x] 1.5 Read the version from an array, a bare string, and a `{ version }` document. Verify with the answer-shape test and an end-to-end array answer.

## 2. Verification

- [x] 2.1 Run `npx vitest run src/core/services/update-notifier.test.ts src/core/services/tls-coverage.test.ts src/cli/commands/update.test.ts` and `npm run typecheck`. Result: all pass. The one failure in `platform-command.posix-oracle.test.ts` also fails on clean `main`.
- [x] 2.2 Check the real lookup against the live npm: it prints the resolved argv, `cwd`, and the version. Result: `latest: 3.2.0` in about 1.1 s. Before the array fix it returned `null`.
- [ ] 2.3 Check the lookup against a private registry (Nexus). This needs a machine configured for one, so the author must do it.
