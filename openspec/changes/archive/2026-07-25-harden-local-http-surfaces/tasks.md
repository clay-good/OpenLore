# Tasks — harden local HTTP surfaces

## Implementation
- [x] Extract serve.ts guard (Host allowlist, Origin check, constant-time token, non-loopback
      token requirement) into a shared module; serve.ts imports it (behavior-identical)
- [x] Apply guard to all view.ts /api/* routes; inject token into the served UI page
- [x] /api/chat requires token even on loopback
- [x] view.ts SIGINT/SIGTERM graceful shutdown + descriptor file (stale-instance detection)

## Verification
- [x] Rebinding-shaped request (loopback IP, foreign Host/Origin) → 403 on every view API route
- [x] Served UI same-origin flow works end-to-end (chat, skeleton, search)
- [x] /api/chat without token → 401 even from localhost
- [x] serve daemon suite unchanged and green against the shared module

## Spec
- [x] `mcp-security` delta: ADD AllLocalHttpSurfacesShareTheGuard (folded into main spec)
