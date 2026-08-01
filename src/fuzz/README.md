# Property-based fuzzing

OpenLore's core job is reading repositories, LLM output, and local descriptors it
does **not** trust. The functions on that untrusted-input path are security
boundaries, so this directory fuzzes them with [fast-check](https://github.com/dubzzz/fast-check)
property-based tests: instead of a handful of hand-picked cases, each invariant is
checked against hundreds-to-thousands of generated inputs (including
control-character-dense strings, malformed structures, and injection look-alikes).

These are ordinary Vitest files (`*.fuzz.test.ts`), so they run in the normal
suite (`npm run test:run`) and in CI — no separate fuzzing daemon or Docker image.
Run just this directory with:

```bash
npm run fuzz
```

## Targets

| File | Function(s) under test | Core invariant |
|------|------------------------|----------------|
| `terminal-sanitizer.fuzz.test.ts` | `sanitizeForTerminal` | no ESC / C0 / C1 / DEL survives (except `\n` in keepNewlines mode); idempotent; output is a subsequence of input |
| `string-escaping.fuzz.test.ts` | `escapeRegExp`, `escapeDotString`, `parseJSON`, `isProtoPollutingKey` | escaped regex matches its input literally & never throws; DOT string never emits an unescaped `"` or raw control char; parseJSON never throws |
| `serve-descriptor.fuzz.test.ts` | `validateServeDescriptor`, `isLoopbackHost` | a validated descriptor ALWAYS has a loopback host (SSRF/egress containment) |
| `serve-health.fuzz.test.ts` | `validateServeHealth` | never throws; a non-null result always proves the root/identity match |
| `secret-redaction.fuzz.test.ts` | `redactSecretString`, `redactSecrets` | a credential never survives redaction into any output; cycle-safe; input not mutated |
| `git-ref.fuzz.test.ts` | `validateGitRef` | rejects flag-shaped (`-…`) and metacharacter refs; accepts legitimate refs; never hangs |

## Adding a target

1. Pick a **pure** (or side-effect-light) function on the untrusted-input path with
   a contract you can state as an invariant. Prefer real security/robustness
   properties over restating the implementation.
2. Create `src/fuzz/<name>.fuzz.test.ts`, importing `fc` from `fast-check` and
   `describe`/`it` from `vitest` (relative imports use the `.js` extension).
3. Assert the invariant with `fc.assert(fc.property(<arbitrary>, (x) => <boolean>))`.
   Bias generators toward the interesting branch and guard against a **vacuous**
   run (e.g. count how often the accept path fires and `expect` it exceeds a floor)
   — a property that never reaches the code it claims to test passes for free.
4. Never assert a guarantee the function does not actually make; that is how a
   property becomes seed-dependent and flaky. Run the file several times to confirm
   stability.

## Scorecard

The presence of `fast-check` in `.ts` files here satisfies OpenSSF Scorecard's
Fuzzing check (its `PropertyBasedTypeScript` probe matches the `from 'fast-check'`
import). This directory must not move under `src/test/`, which Scorecard excludes.
