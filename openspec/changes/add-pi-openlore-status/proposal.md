# Proposal

## Why

A Pi user cannot see whether OpenLore is working. The extension reports problems only when a tool
call fails or a notification appears once. Otherwise the user cannot tell "index ready, daemon up"
from "no index yet", "analysis running", or "daemon refused to start". Pi gives extensions a footer
status slot (`ctx.ui.setStatus`), and OpenLore already computes each of these facts as a value
(`openloreHealth`, `ensureDaemonResult`). So a continuous, honest indicator costs little.

## What Changes

- The Pi extension shows one OpenLore entry in Pi's footer status bar with the key `openlore`. It
  shows only in sessions that have a UI (TUI and RPC). Print and JSON modes get no status.
- The status text comes from facts that OpenLore already computes. No inference is added:
  - Functional readiness of the index: `absent`, `building`, `degraded` or `ready`. The source is
    the published `openloreHealth` read.
  - Daemon state as the extension last saw it: connecting, usable, incompatible, spawn-disabled or
    unavailable. The source is the existing `ensureDaemonResult` outcome.
  - Watcher state, but only when it is known to be stopped. An unknown watcher is never shown as
    stopped.
- The status changes when the session starts: first "connecting", then the result. It also changes
  after each agent run (`agent_end`), and after the configuration wizard's analysis completes or
  fails.
- The status never says "ready" while the index is not whole or the daemon cannot serve tools.
- When the session shuts down, the extension clears the status.
- No new configuration key, MCP tool, or API export.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `mcp-quality`: adds Pi-extension requirements for a footer status that shows OpenLore's
  functional readiness honestly and follows the session's lifecycle. This sits next to the existing
  Pi requirements (`PiDaemonFailuresAreBoundedAndHonest`, `PiInjectedContextIsBoundedAndCurrent`).

## Impact

- Code: `src/pi/extension.ts` (session handlers, daemon-state tracking, status formatting).
  `src/pi/extension.test.ts` (fake `ctx.ui.setStatus`, lifecycle and honesty cases).
- Reads `openloreHealth` from `src/api/health.ts`. That read is disk-first, with one bounded loopback
  probe only when a daemon descriptor exists. It adds no new network egress to the extension.
- Edits to `src/pi/extension.ts` move the line anchors in `src/core/services/tls-coverage.test.ts`.
  Those anchors must be updated to the new lines.
- Docs: `examples/pi/README.md` (what the status means). `CHANGELOG.md`.
- No dependency change. Pi's `setStatus` is already part of the `ExtensionUIContext` type that the
  extension compiles against.
