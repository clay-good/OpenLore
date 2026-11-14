# Show what a function touches, and where shared state can be corrupted

> Priority: P3 · Not built
> Reaches the agent through: `orient`, `blast_radius`, `verify_claim`, `verify_change`, and the after-edit moment
> Why it helps the agent: it stops guessing from names whether a function is pure, and it sees when its edit splits an update to shared state across an `await`.

Folds in `add-shared-state-hazard-conclusions` (removed; restore from commit 0dd75dbef).

## Problem

Many edits depend on one question: does this function change shared state or do I/O? Is it safe to
call twice, to memoize, to move out of a loop? OpenLore holds no such fact, so the agent guesses
from the name (`get…` is probably pure). The agent also cannot see module-level state that other
functions write. In async code, an `await` between a read and a write of the same module binding
lets another task run in between. The stored control-flow data holds the reads and writes
but not the `await` points, and nothing reports the shape.

## What changes

- **Effect fact per function (analyzer).** A closed vocabulary: `pure`, `mutates-params`,
  `module-state`, `io`, `unknown`. Direct effects come from the existing walk: assignment to a
  module binding, a write through a parameter, a call that matches a closed I/O pattern table
  (file system, network, process, console). The fact closes over resolved call edges. An
  unresolved, external or dynamic callee joins as `unknown`. `pure` is never claimed across an edge
  the graph cannot see.
- **Module bindings named.** For a `module-state` effect, the fact names each binding with file and
  line, and counts the other functions that write it.
- **`orient` and `blast_radius` field `effects`** on each function they already list: the effect
  classes, the bindings, and for `unknown` the callee that blocks the proof.
- **`verify_claim` kind `effect-free`** (subject = a symbol): `confirmed` only when the closure
  proves purity; `refuted` with the call path to the write or I/O site; `unverifiable` with the
  blocking callee named.
- **`verify_change` advisory finding `shared-state-interleaved-update`.** In a function the diff
  touches: a read of a module binding, then an `await`, then a write of the same binding. The
  finding gives the three lines and the other writers of that binding. The after-edit receipt
  carries the same finding when the edit introduced the shape.
- **`verify_change` advisory finding `pure-annotation-contradicted`.** A `#__PURE__` or
  `@__NO_SIDE_EFFECTS__` target whose closure proves an effect. The effect path is the proof. It
  never fires on `unknown`.

## What does not change

- No new MCP tool, preset or CLI command. `analyze_shared_state` is not built.
- Both findings are advisory. They are registered in `FINDING_CODE_REGISTRY`, so an operator can opt
  in to blocking.
- Local and static. No runtime instrumentation, no LLM.
- Works without OpenSpec.
- `analyze_error_propagation` still owns exception effects. `plan_parallel_work` hazard classes
  stay as they are.

## Limits we disclose

- Languages: TypeScript, JavaScript, Python. Other languages carry no effect fact and no finding.
  This is stated, not shown as an empty result.
- A lower bound. A write through an alias, a reflective assignment or an unresolved receiver is not
  seen. The answer never says a binding is unshared, race-free or safe.
- Not a race detector: no lock analysis, no alias analysis, no ordering proof. The finding reports a
  shape with its lines, not a proven bug.
- The I/O pattern table can miss a library. That weakens the `io` label, but `pure` still needs
  every callee resolved.

## Depends on

Nothing. It uses shipped code: the Pass-1 walk, the CFG/def-use overlay (`cfg.ts`), the
reachability precompute (`condensation.ts`), and the after-edit hook.
