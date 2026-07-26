# A process must exit when its work is done: no zombie MCP servers, no post-failure hangs

> Status: PROPOSED (2026-07-26). Found by end-to-end passes against the built CLI (ordinary and
> hostile repositories). Both failures predate PR #292. Deterministic, no LLM, no new dependency.

## The gap

Two commands keep the Node event loop alive after they have finished their work. Neither is a
correctness bug in the analysis; both are the kind of defect that only appears when you run the
product rather than test it, and both cost the user something real.

### 1. The MCP server never exits on stdin EOF once the watcher starts

An MCP stdio server's lifetime is its stdin. When the client closes the pipe, the server must exit.

```
$ echo '<jsonrpc initialize>' | openlore mcp        # fails before the watcher starts
   → returns immediately

$ echo '<initialize + orient>' | openlore mcp       # any successful orient
   → still running at 60 s, still running at 120 s (killed both times)
```

After any call that starts the file watcher, stdin EOF no longer ends the process. Every agent
session that wires OpenLore as an MCP server therefore leaves a **zombie process holding a watcher
and its caches**. Over a working day of agent sessions these accumulate; each one holds file handles
and memory for a repository nobody is looking at any more.

The watcher is the thing keeping the loop alive (`chokidar` handles are not `unref`'d), and nothing
tears it down on EOF. `serve` solved the adjacent problem for *its* transport with an idle-timeout
reaper (`DEFAULT_IDLE_TIMEOUT_MIN`, added precisely because orphaned daemons "pile up in RAM"); the
stdio server has no equivalent because its natural signal — EOF — is simply not wired.

### 2. `generate` hangs for the full request timeout after a fatal error

```
$ time openlore generate            # no API key reachable
[error] Failed to connect to LLM API              ← t+0.4 s
…
                                                   ← 120 s of nothing
$ echo $?
1
```

Verified as an unclosed handle rather than a slow retry: with `--timeout 120` the process is killed
by the outer timeout at exactly 120 s (exit 124), and with `--timeout 240` it exits 1 at exactly
120 s. The command decided it had failed in under half a second and then sat there for two minutes.

In CI this is two minutes of billed time per failed run; interactively it reads as a hang, and the
natural user response — `Ctrl-C` — is indistinguishable from the tool having crashed.

## What changes

**Make "the work is finished" and "the process exits" the same event.**

- **Stdio transport lifetime is bound to stdin.** The MCP server treats stdin `end`/`close` as
  shutdown: it stops the watcher, closes the edge store, and exits. Shutdown is idempotent and shares
  one path with the existing signal handlers, so `SIGINT`/`SIGTERM`/EOF cannot each implement their
  own partial teardown.
- **Long-lived resources do not by themselves keep the process alive.** Watcher and timer handles are
  `unref`'d where the process should not outlive its transport, so a missed teardown degrades to
  "exits slightly early" rather than "never exits".
- **A command that has decided it failed exits.** After a fatal error, `generate` (and any sibling
  with the same shape) tears down its in-flight resources rather than waiting out a request timeout
  that no longer has a request behind it.

Both are verified by asserting the *observable* property — the process exits within a bounded time
of the triggering event — rather than by asserting internal state, because the failure mode here is
precisely that internal state looks fine while the process refuses to die.
