# Fix per-language fidelity defects inside claimed (✓) overlays: Ruby CFG, destructured params, env-var semantics, Go arity

> Status: PROPOSED (2026-07-08, e2e audit fifth pass). Four fidelity defects INSIDE overlays the
> capability matrix marks backed (✓) — each a quiet wrong answer within claimed scope, the exact
> class the matrix exists to prevent. Extends `widen-overlay-language-coverage` in spirit: that
> change only ADDS languages to honest `·` cells; it does not touch these broken existing `✓`s.

## The defect(s)

**(a) Ruby CFG overlay is unsound (empirically reproduced).** `RUBY_SPEC` (`cfg.ts:382`) declares
`memberTypes: new Set(['call'])` (`cfg.ts:400`) and `callTypes: new Set(['call', 'method_call'])`
(`cfg.ts:403`) — but in `recordUses` the member-access branch (`cfg.ts:1270`,
`if (spec.memberTypes.has(t))`) runs BEFORE the call branch (`cfg.ts:1282`), so every Ruby method
call is treated as a field read: the method name is recorded as a `may` variable use and the
arguments are never visited (repro: uses of `a` and `x` inside a 4-line method vanish from the
def-use overlay). Separately, `tryTypes: new Set(['begin', 'rescue'])` (`cfg.ts:385`) never
matches `processTry`'s recognized clause types — `catch_clause`/`except_clause` (`cfg.ts:892`)
and `finally_clause` (`cfg.ts:913`); Ruby's are `rescue`/`ensure` — so rescue/ensure bodies are
invisible to the CFG and the overlay emits an UNSOUND `exact` def-use edge across a begin/rescue
that reassigns (repro: `x@2` is killed on the no-exception path yet reported `exact` from line 2
to line 10). That violates the module's own contract (`cfg.ts:12-13`: "`exact` for a sound
local-scalar def-use"), and `valueReachableLines` (`cfg.ts:1869`, documented "sound toward 'may
affect'") is wrong for Ruby in BOTH directions: missing taint (arguments unvisited) and false
precision (`exact` across an untracked rescue kill).

**(b) Destructured parameters dropped (TS/JS, empirically reproduced).** `extractParamNames`
(`cfg.ts:1926-1958`) has `isBinder` accept only `identifier`/`spec.identTypes` (`cfg.ts:1934`);
object-pattern leaves are `shorthand_property_identifier_pattern`, which the visitor descends
into (it ends with `_pattern`, `cfg.ts:1946`) but never collects. `function handler({ req, res },
plain)` → `cfg.params = ["plain"]`; a use of `req` gets no def-use edge; `valueReachableLines`
seeded "from every parameter" silently omits the destructured ones (ubiquitous in Express/React
signatures), and the closure-capture bound set (`cfg.ts:1037`) misclassifies them as outer-scope
`may`-captures. `collectIdentLeaves` (`cfg.ts:1704-1706`) already handles the node type
correctly — this is a one-line-class fix.

**(c) Ruby env-var hard/soft classification INVERTED; idiomatic forms invisible.** Ruby runtime
semantics: `ENV["X"]` returns `nil` when missing (soft); `ENV.fetch("X")` without a default
raises `KeyError` (hard). `env-extractor.ts` says the opposite in both paths: the inventory path
(`env-extractor.ts:131`, `const isStrict = m[1] !== undefined; // ENV.fetch has optional
default`) marks the bracket form required and no-default fetch not-required; the read-site path
(`env-extractor.ts:345-346`, "`ENV["X"]` (m[1]) is strict") marks `ENV["X"]` `required: true` —
Python's raising `os.environ["X"]` semantics copy-pasted onto Ruby. So `analyze_env_impact`
reports a HARD break for the form that degrades softly. Also within declared scope: Go
`os.LookupEnv("X")` — the idiomatic checked form — is not matched at all (`env-extractor.ts:92`
matches only `os.Getenv`); TS/JS destructuring `const { API_KEY } = process.env` is invisible
(`env-extractor.ts:84`); and the file-global fallback heuristic (`env-extractor.ts:105-109`)
evaluates `TS_HAS_FALLBACK_RE` once per FILE, so one `?? 'x'` anywhere marks EVERY var in the
file `required: false` in the `get_env_vars` inventory (the read-site path already fixed this
per-site; the inventory path still ships file-global).

**(d) CHA arity guard vacuous for Go methods.** `arityFromSignature` (`cha.ts:61-84`) takes the
FIRST `(` (`signature.indexOf('(')`, `cha.ts:63`) — for
`func (s *Server) handle(w http.ResponseWriter, r *http.Request)` that is the receiver list, so
every Go method computes arity 1 and `arityCompatible` always passes for Go embeds hierarchies,
quietly disabling the arity filter `synthesizeOverrideEdges` relies on (`cha.ts:259`) for its
stated false-negative bias.

## What changes

- **(a)** Check `callTypes` before `memberTypes` in `recordUses` when a node type is in both (or
  give the Ruby `call` node a receiver-shaped disambiguation), so Ruby calls visit receiver AND
  arguments; align `RUBY_SPEC.tryTypes` and `processTry` clause recognition so `rescue`/`ensure`
  bodies enter the CFG and a reassigning rescue kills the crossing def — the `exact` label
  becomes true again, or degrades honestly to `may`.
- **(b)** Extend `extractParamNames`'s `isBinder` to the pattern-leaf types `collectIdentLeaves`
  already collects (`shorthand_property_identifier_pattern`, `shorthand_property_identifier`).
- **(c)** Swap the Ruby required-classification in BOTH paths to match runtime semantics
  (bracket = soft, no-default `fetch` = hard, reusing `rubyFetchRequired`); add
  `os.LookupEnv` and `process.env` destructuring to the declared-scope patterns; make the
  TS/JS inventory fallback check per-site (the read-site path's existing discipline), not
  per-file.
- **(d)** Skip a leading receiver group in `arityFromSignature` when the signature starts
  `func (`, restoring the filter for Go methods.
- Per-language CFG/env fixtures pin each repro (Ruby call-argument uses, rescue kill,
  destructured param seeding, Ruby/Go/TS env classification, Go method arity).

**Coordination note:** (a) and (b) are concrete ground-truth cases for
`add-callgraph-soundness-calibration` (pass 3) — cite them there as known unsoundness instances
when that change builds its calibration corpus (note only; that change's files are not modified).

## Why this is in scope

The substrate's whole claim (decision `c6d1ad07`) is deterministic structural answers an agent
can trust without re-deriving them; the capability matrix exists so a quiet result is
interpretable as "unsupported here" vs. "nothing found". A `✓` cell that returns a wrong answer
is worse than a `·` — it defeats the disclosure mechanism itself. Every fix here is
deterministic, local, constant-free precision work on existing claimed capabilities: no new
tuning constants, no LLM, and (a)'s rescue handling may honestly DOWNGRADE precision (`exact` →
`may`) where soundness demands it — honest boundaries over flattering labels.

## Impact

- Files: `src/core/analyzer/cfg.ts` (Ruby spec + `recordUses` ordering + `processTry` clause
  types + `extractParamNames`), `src/core/analyzer/env-extractor.ts` (Ruby/Go/TS patterns +
  per-site fallback), `src/core/analyzer/cha.ts` (`arityFromSignature`); fixtures/tests beside
  each.
- Consumers improve for free: `valueReachableLines` (value-level `analyze_impact` /
  `trace_execution_path`), `analyze_env_impact` / `get_env_vars`, CHA override synthesis.
- Specs: `analyzer` — 4 ADDED requirements (one per defect).
- Tool surface: unchanged (no new tool, no payload-budget impact).
- Risk: low. Each fix narrows to one language/one function; Ruby CFG changes may shift existing
  Ruby def-use snapshots — intended, pinned by the repro fixtures. Go embeds override edges may
  DROP (arity filter re-enabled) — that is the filter working as specified.
