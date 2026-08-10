/**
 * Task derivation for `openlore prove` (Spec 25 Q2).
 *
 * The benchmark's win shows up on orientation questions about an unfamiliar
 * codebase. We auto-derive such questions from the user's own call graph, with
 * an oracle taken from the graph itself (so correctness is verifiable without a
 * human). Pure + deterministic so it unit-tests without a repo.
 */

/** Minimal call-graph fact per function — adapted from the EdgeStore by the CLI. */
export interface GraphFact {
  name: string;
  filePath: string;
  callerNames: string[];
  calleeNames: string[];
  isEntryPoint: boolean;
}

export interface ProveTask {
  id: string;
  prompt: string;
  /** Answer is correct if it contains AT LEAST ONE of these (case-insensitive). */
  mustIncludeAny: string[];
  /** Short note on what structural fact this probes. */
  probes: string;
}

/** Minimum direct fan-in needed to derive a stable orientation task. */
export const PROVE_MIN_CALLERS = 2;

/** A single qualifying function is enough to derive the locate/caller tasks. */
export const PROVE_MIN_ELIGIBLE_FUNCTIONS = 1;

export interface ProveEligibility {
  eligibleFunctions: number;
  requiredEligibleFunctions: number;
  minCallers: number;
  eligible: boolean;
}

/** Measure the exact structural precondition shared by install and prove. */
export function measureProveEligibility(facts: GraphFact[]): ProveEligibility {
  const eligibleFunctions = facts.filter(f => f.callerNames.length >= PROVE_MIN_CALLERS).length;
  return {
    eligibleFunctions,
    requiredEligibleFunctions: PROVE_MIN_ELIGIBLE_FUNCTIONS,
    minCallers: PROVE_MIN_CALLERS,
    eligible: eligibleFunctions >= PROVE_MIN_ELIGIBLE_FUNCTIONS,
  };
}

/** True iff the agent's answer contains at least one oracle substring. */
export function scoreAnswer(task: ProveTask, answer: string): boolean {
  const a = answer.toLowerCase();
  return task.mustIncludeAny.some(s => a.includes(s.toLowerCase()));
}

/** basename without extension, e.g. "src/core/edge-store.ts" → "edge-store". */
function fileStem(filePath: string): string {
  const base = filePath.split('/').pop() ?? filePath;
  return base.replace(/\.[^.]+$/, '');
}

/**
 * A name is a good oracle target if it's distinctive enough that the agent's
 * answer will quote it verbatim rather than a synonym — long, and not a generic
 * one-word English term. Avoids ambiguous targets like `run`/`get`/`handle`.
 */
function isDistinctive(name: string): boolean {
  if (name.length < 6) return false;
  return /[A-Z_]/.test(name.slice(1)) || /[._]/.test(name); // camelCase / snake_case / qualified
}

/**
 * Derive up to `max` orientation tasks from graph facts. Deterministic: facts
 * are sorted by a stable key before selection so the same graph yields the same
 * tasks. Tasks use forgiving, structurally-grounded oracles (a file path, or any
 * one of many valid callers/callees) so a correct answer is reliably recognized —
 * an earlier "which function has the most callers?" task was too ambiguous (the
 * agent named a plausible-but-different function) and is gone. Returns [] when
 * the graph is too sparse to form an oracle-able task.
 */
export function deriveTasks(facts: GraphFact[], max = 3): ProveTask[] {
  const tasks: ProveTask[] = [];

  // Most-called first, then by name (stable tie-break) — no Date/random.
  const byCallers = [...facts].sort(
    (a, b) => b.callerNames.length - a.callerNames.length || a.name.localeCompare(b.name),
  );

  // Hub = a well-connected function with a distinctive name (so the oracle is
  // unambiguous), falling back to the most-called function if none qualifies.
  const hub = byCallers.find(f => f.callerNames.length >= PROVE_MIN_CALLERS && isDistinctive(f.name)) ?? byCallers[0];

  if (hub && hub.callerNames.length >= PROVE_MIN_CALLERS) {
    // Task 1 — locate: "which file defines `hub`?" Oracle = the file path/stem,
    // which a correct answer will quote verbatim. Very robust.
    tasks.push({
      id: 'locate',
      prompt: `In this codebase, which file defines the function \`${hub.name}\`? Answer with the file path.`,
      mustIncludeAny: [hub.filePath, fileStem(hub.filePath)],
      probes: `definition site of ${hub.name} (${hub.filePath})`,
    });

    // Task 2 — a caller of the hub (any one of many valid callers counts).
    tasks.push({
      id: 'caller',
      prompt: `Name one function that directly calls \`${hub.name}\` in this codebase.`,
      mustIncludeAny: hub.callerNames.slice(0, 25),
      probes: `a direct caller of ${hub.name}`,
    });
  }

  // Task 3 — a callee of a distinctive, high-fan-out function.
  const byCallees = [...facts].sort(
    (a, b) => b.calleeNames.length - a.calleeNames.length || a.name.localeCompare(b.name),
  );
  const fanOutHub = byCallees.find(f => f.calleeNames.length >= 2 && isDistinctive(f.name) && f.name !== hub?.name)
    ?? byCallees.find(f => f.calleeNames.length >= 2);
  if (fanOutHub) {
    tasks.push({
      id: 'callee',
      prompt: `Name one function that \`${fanOutHub.name}\` calls (directly invokes) in this codebase.`,
      mustIncludeAny: fanOutHub.calleeNames.slice(0, 25),
      probes: `a callee of ${fanOutHub.name}`,
    });
  }

  return tasks.slice(0, max);
}
