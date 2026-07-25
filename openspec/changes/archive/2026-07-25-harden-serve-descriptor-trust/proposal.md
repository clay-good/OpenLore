# Harden serve-descriptor trust: one untrusted artifact, one validator, three readers

> Status: SHIPPED (2026-07-19). Extracted `serve.ts`'s validation into the shared
> `src/cli/commands/serve-descriptor.ts` (`validateServeDescriptor` + `readServeDescriptor`,
> dependency-light: node builtins + `isLoopbackHost`). All three readers — `serve.ts`,
> `serve-client.ts`, and the Pi extension — now resolve `.openlore/serve.json` through it, so a
> poisoned descriptor is treated exactly as absent (no fetch, no header, no signal target). A
> source-level coverage guard (`serve-descriptor.test.ts`) fails CI if a future reader reads the
> file raw. Spec `mcp-security` gained `ServeDescriptorValidatedAtEveryReader`.
>
> Original (PROPOSED 2026-07-03, e2e audit follow-up): `.openlore/serve.json` is a
> repo-local, attacker-writable artifact, and OpenLore reads it at three sites with two
> security postures. `serve.ts` validates it — port range, integer pid, loopback-only host —
> with a comment citing the mcp-security "Untrusted Artifact Deserialization" requirement.
> Its siblings `serve-client.ts` and the Pi extension `JSON.parse(...) as ServeDescriptor`
> with zero validation and then fetch whatever host the file names. One threat model, three
> doors; one got the lock. Extract that lock into a shared validator used by all three.

## The gap

- **The guarded door.** `serve.ts:247-271` `readDescriptor` fails closed unless port is an
  integer in 1–65535 (`:256`), pid a positive integer (`:257`), host passes
  `isLoopbackHost` (`:260`, defined `:137`), and token is absent-or-string (`:261`). The
  docblock (`serve.ts:238-243`) names the attack: "a hostile repo could ship a poisoned
  serve.json … `daemonAlive` would fetch an arbitrary host (egress / SSRF)".
- **The unguarded siblings.** `serve-client.ts:56-62` `readDescriptor` is
  `JSON.parse(...) as ServeDescriptor` — a type assertion, not a check. The raw
  `host`/`port` flow straight into `healthy()`'s fetch
  (`http://${desc.host}:${desc.port}/health`, `serve-client.ts:68`) and, if the attacker's
  server answers `{ok:true}`, into `callServeTool` (`:127-149`), which POSTs
  `{directory, args}` (`:136-140`) with the descriptor's own token header (`:135`). The Pi
  extension duplicates the same raw parse (`src/pi/extension.ts:400-404`), the same
  unguarded probe (`:408`), and the same tool POST (`:453-462`, keepalive at `:1083`).
- **The blast radius is the agent's context.** The stdio MCP server delegates every tool
  call through the unguarded client path (`mcp.ts:2391` `ensureServeDaemon`, `:2566`
  `callServeTool`, `:2684` a second probe). So a hostile repo's serve.json can (a) make
  OpenLore fetch an arbitrary — including internal — address (SSRF/egress), (b) exfiltrate
  the POSTed project directory and full tool arguments (which can carry source snippets,
  e.g. `find_clones --snippet`), and (c) return attacker-authored "tool results" that are
  injected verbatim into the coding agent's context — result poisoning through a file the
  repo controls.

## What changes

1. **One shared descriptor validator.** Extract `serve.ts`'s existing checks into a
   dependency-light module (per the MCP↔Pi parity doctrine: shared logic in one module
   both surfaces import; the Pi host must not pull in the analyzer, and this module needs
   nothing heavy): loopback-only host, integer port 1–65535, integer pid > 0, token
   absent-or-string. No new checks invented — the guard that exists, made shared.
2. **All three readers use it.** `serve.ts` `readDescriptor` delegates to it (behavior
   unchanged); `serve-client.ts:56-62` and `pi/extension.ts:400-404` replace their raw
   casts with it. A descriptor that fails validation is treated exactly as absent —
   `readDescriptor` returns null, so the existing paths take over (spawn a fresh daemon or
   fall back to in-process dispatch, the degradation the module already promises,
   `serve-client.ts:10-11`) — with a debug-level disclosure, never a followed endpoint.
3. **No fourth door.** A grep audit confirms these are the only serve.json readers today; a
   test pins that every reader resolves descriptors through the shared validator, so a
   future reader cannot silently re-open the gap.

Cross-reference: sibling change `harden-local-http-surfaces` guards the **inbound** face of
the same threat model (requests arriving at a local HTTP surface). This change is the
**outbound** face of the same artifact class: what a local client is willing to trust and
connect to. Together they close both directions.

## Why this is in scope

`mcp-security` already requires untrusted-artifact deserialization to fail closed — the
audit shows the requirement is enforced at one of three reader sites. Cloning a repo must
never be enough to point OpenLore's tool traffic at an attacker. The fix is deterministic,
local, dependency-free, and reuses validation code that already exists.

## Impact

- Files: new shared validator module (extracted from `serve.ts:247-271`);
  `src/core/services/serve-client.ts`, `src/pi/extension.ts`, `src/cli/commands/serve.ts`
  converted to it; tests for poisoned-descriptor rejection at each reader.
- Specs: `mcp-security` — 1 ADDED requirement (ServeDescriptorValidatedAtEveryReader).
- Tool surface: unchanged (no new tool, no payload-budget impact).
- Risk: low. A legitimately non-loopback descriptor cannot exist today — `serve` itself
  only binds non-loopback with an explicit flag and refuses to start without a token
  (`serve.ts:330`), and the guarded reader already rejects such a descriptor on the
  `serve stop`/status path — so treating one as absent changes no working setup.
