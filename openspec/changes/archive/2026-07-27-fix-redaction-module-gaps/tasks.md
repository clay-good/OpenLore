# Tasks — fix redaction-module gaps

## Implementation
- [x] Authorization pattern (secret-redaction.ts:28): consume the full header value
      (scheme + credential, to end-of-line/value) so Basic/Digest/any scheme redacts like
      Bearer; keep the Bearer-specific pattern (:27) for bare occurrences
- [x] Cycle branch (secret-redaction.ts:53): replace return-the-original with an
      original→redacted-twin WeakMap so a re-encountered object resolves to its scrubbed
      copy (cycle-preserving), or a '[CYCLE]' placeholder — never the unredacted object;
      update the contract comment (:46) to match the chosen shape

## Verification
- [x] `Authorization: Basic dXNlcjpzZWNyZXQ=` → `Authorization: [REDACTED]` (no residual
      token); same for Digest and a custom scheme; Bearer behavior unchanged
- [x] Multi-line text: only the Authorization line is consumed; following lines intact
- [x] Cyclic object (a → b → a) with a secret-keyed field inside the cycle: output contains
      no unredacted object identity from the input (assert via reference inequality walk)
      and the secret value appears nowhere in `JSON.stringify` of the output (with a
      cycle-safe serializer)
- [x] Self-referencing array and object-with-`cause`-cycle fixtures terminate and redact
- [x] Full suite green

## Spec
- [x] `mcp-security` delta: ADD AuthorizationHeaderRedactionConsumesTheFullValue,
      CycleSafeRedactionNeverReturnsUnredactedInput
