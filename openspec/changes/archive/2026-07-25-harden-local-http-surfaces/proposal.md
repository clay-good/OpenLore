# Harden the view server to the serve daemon's security model

> Status: SHIPPED (2026-07-18, PR #235; status reconciled 2026-07-19). Originally proposed (2026-07-03, e2e audit). OpenLore runs two local HTTP surfaces with two
> different security postures. The `serve` daemon has the right one — loopback default,
> Host/Origin DNS-rebinding guard, constant-time token comparison, non-loopback-requires-token
> (`serve.ts:20-24`, `:178-192`, `:239-258`). The `view` graph server has none of it, while
> exposing strictly more dangerous endpoints. One threat model, two doors; this change locks the
> second door with the first door's lock.

## The gap

`src/cli/commands/view.ts` mounts, with **no Host check, no Origin check, no token**:

- `/api/chat` (`view.ts:483`) — drives a full `runChatAgent`, spending the user's LLM API key and
  running tools;
- `/api/skeleton` (`view.ts:390`) — returns the contents/structure of arbitrary in-project files;
- `/api/search` — semantic search over the codebase.

Loopback binding (`127.0.0.1`, `constants.ts:188`) does not stop DNS rebinding: a malicious web
page the user visits can re-point its hostname at `127.0.0.1` and issue same-"origin" requests to
the view server — exfiltrating source via `/api/skeleton`/`/api/search` and burning the user's API
key via `/api/chat`. The sibling daemon's header comment documents this exact attack and defends
it; the view server predates that work and never inherited it.

Secondary gaps from the same audit: the view server has no graceful shutdown (no
SIGINT/SIGTERM → `server.close()`; `view.ts:643`) and no stale-instance detection, both of which
`serve` also already solves (descriptor + health model).

## What changes

1. **Extract the guard `serve` already has into a shared middleware** (one dependency-light
   module; per the parity doctrine, shared logic lives in one module both surfaces import):
   Host-header allowlist (`localhost`, `127.0.0.1`, `[::1]`, with the bound port), Origin check for
   browser requests, and the constant-time token path for any non-loopback binding.
2. **Apply it to every `/api/*` route of the view server.** The browser UI it serves gets the
   token injected into the page it ships (same-origin requests keep working); foreign origins get
   403. `/api/chat` additionally requires the token even on loopback — it spends money; the UI has
   it, a rebinding page does not.
3. **Lifecycle parity:** SIGINT/SIGTERM handlers with `server.close()`, and the serve-style
   descriptor file so a stale viewer is detected rather than mysteriously occupying the port.
4. **Regression tests** in the shape of the daemon's existing suite: rebinding-shaped request
   (correct IP, foreign Host/Origin) → 403 on every API route; loopback UI request → 200;
   `/api/chat` without token → 401.

## Why this is in scope

`mcp-security` already requires daemon Host/Origin defense; the audit shows the requirement is
narrower than the attack surface. This closes the gap with code that exists, no new dependency,
no behavior change for legitimate use.

## Impact

- `view.ts`, a shared guard module extracted from `serve.ts`, tests.
- Specs: `mcp-security` — 1 ADDED requirement (AllLocalHttpSurfacesShareTheGuard).
- Risk: a proxy/tunnel setup with a rewritten Host header would need the token — disclosed in the
  viewer docs; correct behavior for that setup anyway.
