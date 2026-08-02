# Tasks — bind process lifetime to transport lifetime

## Reproducers (write these first — assert the OBSERVABLE property)
- [x] Stdio EOF test: spawn the real `mcp` server, complete `initialize`, issue an `orient` (so the
      watcher starts), close stdin, assert the process exits within a bounded window. Today it is
      still running at 120 s.
- [x] Stdio EOF before any tool call: same assertion, no `orient` — proves the fix is not
      watcher-specific
- [x] `generate` post-failure exit: with an unreachable provider, assert the interval between the
      error line and process exit is bounded AND does not change when `--timeout` is raised
      (the two-run comparison is what distinguishes an unclosed handle from a slow retry)
- [x] Assert on process exit, never on internal state: the failure mode is that internal state looks
      correct while the process refuses to die

## Implementation
- [x] One idempotent `shutdown()` per long-lived surface; wire stdin `end`/`close` to it alongside
      the existing `SIGINT`/`SIGTERM` handlers
- [x] Stdio server shutdown stops the watcher, closes the edge store, clears timers
- [x] `unref` watcher/timer handles that must not outlive their transport, so a missed teardown is an
      early exit rather than a hang
- [x] `generate` (and siblings with the same shape): tear down in-flight LLM resources on the fatal
      error path instead of waiting out the request timeout
- [x] Audit the other long-lived surfaces (`serve`, `view`, the watcher itself) for the same shape and
      route each through its single teardown path

## Verification
- [x] Every reproducer fails on `origin/main` and passes after the change
- [x] No zombie after a scripted agent session: spawn, call, exit, then assert no server process for
      that repository remains
- [x] `serve --stop`, `view` shutdown, and MCP EOF all still remove their descriptors

## Notes
- [x] `serve`'s existing idle-timeout reaper stays as defence in depth: it covers a client that dies
      without closing the pipe, which EOF cannot.
- [x] Nothing borrowed from another tool — this is ordinary Node transport-lifetime hygiene.
