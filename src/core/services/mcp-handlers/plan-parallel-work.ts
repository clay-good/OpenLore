/**
 * `plan_parallel_work` — the borrow checker's verdict, rendered for a swarm
 * (change: add-parallel-work-plan, PARALLEL-WORK-COORDINATION proposal 2).
 *
 * Composes the footprint projection + pairwise hazard classifier (proposal 1)
 * into the one conclusion an orchestrator should ask for before fanning work out
 * across worktrees: of these N proposed tasks, which subset is safe to edit
 * concurrently, which must be ordered, and what is the minimum wall-clock even
 * with unlimited agents?
 *
 * Conclusion over graph: the primary payload is the *schedule* (waves + critical
 * path), not a node-and-edge graph for the agent to color by hand. The conflict
 * graph rides along as supporting evidence with witnesses.
 *
 * Stateless `render(state)`: the tool holds nothing between calls. To re-plan
 * after a wave completes, the caller re-invokes with the remaining tasks. There
 * is no lease, no "release," no memory of which agent took which task — the
 * harness owns state and dispatch (north star `c6d1ad07`: OpenLore computes
 * conclusions; it never grows a coordinator).
 *
 * Advisory by default: the plan blocks nothing on its own. WAW conflicts and
 * unorderable RAW cycles are emitted as policy-shaped `GovernanceFinding`s
 * (`parallel-work-conflict` / `parallel-work-cycle`, registered in
 * `FINDING_CODE_REGISTRY`) so the *caller* that invokes this tool can classify
 * them with `resolveEnforcementClass(code, policy)` and choose to block in its own
 * orchestration/CI. The bundled `openlore enforce` commit gate is diff-based and
 * never runs the planner, so it never sees — and never blocks on — these findings
 * (add-finding-enforcement-policy).
 */

import { validateDirectory, readCachedContext } from './utils.js';
import {
  computeFootprint,
  classifyHazard,
  type TaskDescriptor,
  type Footprint,
  type FootprintOptions,
  type HazardVerdict,
} from './change-footprint.js';
import type { GovernanceFinding } from './enforcement-policy.js';
import type { SerializedCallGraph } from '../../analyzer/call-graph.js';

/** How many read/affected ids to surface per task footprint before truncating (no-silent-truncation). */
const FOOTPRINT_LIST_CAP = 12;

/**
 * Caps on the O(N²) supporting-evidence lists. The schedule itself (waves +
 * critical path) is O(N) and always complete; the conflict graph, advisories, and
 * findings can each reach ~N²/2 entries (e.g. 64 tasks all writing one symbol →
 * ~2,016 pairs), which would push the response into the megabytes and trip the
 * dispatch-level 256 KB structured-result cap — whose array fallback mangles the
 * payload into an unparseable string. So each is capped here with an authoritative
 * uncapped count + a truncation flag (mcp-quality: no-silent-truncation). The waves
 * still encode every conflict's scheduling consequence; the lists are evidence.
 */
const CONFLICT_LIST_CAP = 200;
const FINDINGS_LIST_CAP = 100;
/** Max witnessing symbols surfaced per conflict/advisory/finding (a whole-file WAW pair can share dozens). */
const WITNESS_CAP = 8;
/**
 * Soft byte budget for the whole response. The dispatch-level hard cap is 256 KB
 * (`MCP_TOOL_MAX_BYTES`), and its array fallback mangles an over-budget structured
 * result into an unparseable string — so we keep a margin below it and, if a plan
 * is still too large after the per-list caps (e.g. 64 tasks each seeding a whole
 * file), deterministically collapse per-task footprint *sample lists* to their
 * counts. The schedule (waves + critical path) and the counts are always retained.
 */
const SOFT_BUDGET_BYTES = 200 * 1024;

/**
 * Upper bound on tasks per call. The conflict graph is O(N²) pairs and each
 * footprint reuses graph-wide reachability, so an unbounded list would produce a
 * huge payload and slow O(N²)+O(N·E) work. A real concurrent swarm is a handful
 * to a few dozen tasks; 64 is comfortably above that and keeps the plan bounded.
 * Over the cap is an explicit error, not a silent truncation (mcp-quality).
 */
const MAX_TASKS = 64;

export interface PlanParallelWorkInput {
  directory: string;
  /** Caller-supplied task list. OpenLore schedules; it never invents or decomposes the list. */
  tasks: TaskDescriptor[];
  /** Forwarded to the footprint projection (call-distance read-set bound). */
  readMaxDistance?: number;
  /** Forwarded to the footprint projection (backward affected-set hop depth). */
  affectedMaxDepth?: number;
  /** Forwarded to the footprint projection (ambient fan-in percentile). */
  ambientFanInPercentile?: number;
}

/** A task's footprint, rendered for the plan. Every region list is capped to
 *  {@link FOOTPRINT_LIST_CAP} with an authoritative uncapped count, so a task seeded
 *  on a god-function (huge read-set / ambient deps) or a whole file (large write-set)
 *  cannot bloat the response (no-silent-truncation). */
export interface RenderedFootprint {
  taskId: string;
  writeSet: Array<{ id: string; name: string; filePath: string; writeMode: string }>;
  writeSetCount: number;
  writeSetTruncated: boolean;
  readSet: string[];
  readSetCount: number;
  readSetTruncated: boolean;
  affectedSet: string[];
  affectedSetCount: number;
  affectedSetTruncated: boolean;
  ambientReadDeps: string[];
  ambientReadDepCount: number;
  ambientReadDepsTruncated: boolean;
  couplingNeighbors: string[];
  couplingNeighborCount: number;
  couplingNeighborsTruncated: boolean;
  unresolvedSeeds: string[];
}

/** One pairwise verdict in the conflict graph (supporting evidence, not a graph to traverse). */
export interface ConflictPair {
  taskA: string;
  taskB: string;
  hazard: HazardVerdict['kind'];
  direction?: HazardVerdict['direction'];
  witnesses: string[];
}

/** One scheduled wave. */
export interface Wave {
  wave: number;
  /** Tasks safe to dispatch together in this wave. */
  taskIds: string[];
  /** Predecessor tasks (in earlier waves) that this wave's RAW dependencies wait on. */
  waitsOn: string[];
}

export interface CriticalPath {
  /** Minimum number of sequential rounds even with unlimited agents (== the schedule depth). */
  rounds: number;
  /** A witnessing longest chain of hard-ordered tasks. */
  chain: string[];
  /** Plain-language read of the parallelism ceiling. */
  summary: string;
}

export interface ParallelWorkPlan {
  taskCount: number;
  footprints: RenderedFootprint[];
  /** Pairwise hazards (only the non-`none` pairs), as supporting evidence with witnesses. Capped — see `conflictCount`. */
  conflicts: ConflictPair[];
  /** Total non-`none` pairs (uncapped); `conflicts` is truncated to {@link CONFLICT_LIST_CAP} when this exceeds it. */
  conflictCount: number;
  conflictsTruncated: boolean;
  /** The computed answer: an ordered list of dispatch waves (always complete). */
  waves: Wave[];
  criticalPath: CriticalPath;
  /** Low-risk pairs surfaced as warnings (shared-append / WAR / soft-coupling) — non-serializing. Capped — see `advisoryCount`. */
  advisories: Array<{ kind: HazardVerdict['kind']; taskA: string; taskB: string; witnesses: string[]; note: string }>;
  advisoryCount: number;
  advisoriesTruncated: boolean;
  /**
   * Governance findings (WAW conflicts / unorderable RAW cycles), shaped so a caller
   * can classify them with `resolveEnforcementClass`. Advisory by default; capped —
   * see `findingCount`. The bundled `openlore enforce` gate does NOT run the planner,
   * so it never sees these — the invoking caller/CI applies the policy.
   */
  findings: GovernanceFinding[];
  findingCount: number;
  findingsTruncated: boolean;
  /** Greedy + topological; not optimal — stated plainly. */
  scheduling: string;
  /** Standing known-unknowable disclosure. */
  disclosure: string;
  /** Set only when a large plan was shrunk to fit the response budget (counts stay authoritative). */
  truncationNote?: string;
}

const DISCLOSURE =
  'Footprints are predicted/advisory (declared seeds + structural reachability), not a record of the ' +
  'edits an agent will make. This plan reduces conflict probability and shifts detection left; it does ' +
  'NOT guarantee conflict-free parallelism — two tasks sharing no call edge and no co-change history ' +
  'can still depend on one latent invariant. Integration tests remain the ground truth.';

const SCHEDULING_NOTE =
  'Waves: greedy maximal independent set over the WAW conflict graph, constrained so every RAW ' +
  'predecessor lands in an earlier wave (shared-append / WAR / soft-coupling do not split a wave). ' +
  'Critical path: longest hard-ordered chain. Correct and deterministic, not globally optimal; ' +
  'tasks are not weighted by value.';

/** Validate the input task list; returns an error string or null. */
function validateTasks(tasks: unknown): string | null {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return 'plan_parallel_work requires a non-empty `tasks` array of task descriptors.';
  }
  if (tasks.length > MAX_TASKS) {
    return `Too many tasks (${tasks.length}); plan_parallel_work caps a single plan at ${MAX_TASKS}. Split the work into smaller batches and re-invoke per batch.`;
  }
  const ids = new Set<string>();
  for (const t of tasks as TaskDescriptor[]) {
    if (!t || typeof t.id !== 'string' || t.id.length === 0) {
      return 'Each task descriptor requires a non-empty string `id`.';
    }
    if (ids.has(t.id)) return `Duplicate task id "${t.id}" — task ids must be unique within a call.`;
    ids.add(t.id);
    const hasSeed = (t.seedSymbols && t.seedSymbols.length > 0) || (t.seedFiles && t.seedFiles.length > 0);
    if (!hasSeed) return `Task "${t.id}" has no seedSymbols or seedFiles — at least one seed is required.`;
  }
  return null;
}

export async function computePlanParallelWork(
  input: PlanParallelWorkInput,
): Promise<ParallelWorkPlan | { error: string }> {
  const taskError = validateTasks(input.tasks);
  if (taskError) return { error: taskError };

  const absDir = await validateDirectory(input.directory);
  const ctx = await readCachedContext(absDir);
  if (!ctx) return { error: 'No analysis found. Run analyze_codebase first.' };
  if (!ctx.callGraph) return { error: 'Call graph not available. Re-run analyze_codebase.' };
  const cg = ctx.callGraph as SerializedCallGraph;

  const fpOpts: FootprintOptions = {
    readMaxDistance: input.readMaxDistance,
    affectedMaxDepth: input.affectedMaxDepth,
    ambientFanInPercentile: input.ambientFanInPercentile,
    // Wrapped: an older index built before the change-coupling table existed makes
    // `getChangeCouplingForFiles` throw on the missing table. Coupling is an advisory
    // annotation, so a missing/broken store degrades to "no coupling", never a crash.
    couplingLookup: ctx.edgeStore
      ? (files: string[]) => {
          try {
            return ctx.edgeStore!.getChangeCouplingForFiles(files);
          } catch {
            return [];
          }
        }
      : undefined,
  };

  // 1. Footprint per task (proposal 1).
  const footprints: Footprint[] = input.tasks.map(t => computeFootprint(cg, t, fpOpts));
  const taskIds = footprints.map(f => f.taskId);

  // 2. Pairwise conflict graph.
  const conflicts: ConflictPair[] = [];
  const waw = new Map<string, Set<string>>(); // mutual exclusion (different waves)
  const rawPred = new Map<string, Set<string>>(); // task → its RAW predecessors
  const advisories: ParallelWorkPlan['advisories'] = [];
  const findings: GovernanceFinding[] = [];
  for (const id of taskIds) {
    waw.set(id, new Set());
    rawPred.set(id, new Set());
  }

  for (let i = 0; i < footprints.length; i++) {
    for (let j = i + 1; j < footprints.length; j++) {
      const a = footprints[i];
      const b = footprints[j];
      const v = classifyHazard(a, b);
      if (v.kind === 'none') continue;
      conflicts.push({ taskA: a.taskId, taskB: b.taskId, hazard: v.kind, direction: v.direction, witnesses: capWitnesses(v.witnesses) });

      if (v.kind === 'WAW') {
        waw.get(a.taskId)!.add(b.taskId);
        waw.get(b.taskId)!.add(a.taskId);
        findings.push({
          code: 'parallel-work-conflict',
          severity: 'warning',
          source: 'plan-parallel-work',
          subject: `${a.taskId} × ${b.taskId}`,
          message: `Write-write conflict on ${witnessSummary(v.witnesses)} — these tasks must not edit concurrently (scheduled into different waves).`,
        });
      } else if (v.kind === 'RAW') {
        applyRaw(a.taskId, b.taskId, v.direction, rawPred, waw);
      } else {
        // shared-append / WAR / soft-coupling → advisory, non-serializing.
        advisories.push({
          kind: v.kind,
          taskA: a.taskId,
          taskB: b.taskId,
          witnesses: capWitnesses(v.witnesses),
          note: advisoryNote(v.kind),
        });
      }
    }
  }

  // 2b. Disclose and break unorderable RAW cycles. A cycle of one-directional RAW
  // edges (A→B→C→A) can survive `applyRaw` (which only downgrades the 2-cycle
  // bidirectional case); bounded read-distance makes such cycles reachable. No wave
  // order can satisfy a cyclic dependency, so rather than silently break it (a
  // confidently-wrong schedule), we DISCLOSE it as a finding and place the members
  // in different waves (mutual exclusion) — the conservative, honest resolution.
  for (const cyc of detectRawCycles(taskIds, rawPred)) {
    findings.push({
      code: 'parallel-work-cycle',
      severity: 'warning',
      source: 'plan-parallel-work',
      subject: `${cyc.join(' → ')} → ${cyc[0]}`,
      message:
        `Unorderable read-after-write cycle among ${cyc.join(', ')} — no wave order can satisfy all ` +
        `dependencies. These tasks are placed in separate waves (mutually exclusive) and must not run ` +
        `concurrently; resolve the circular dependency before parallelizing.`,
    });
    const members = new Set(cyc);
    // Drop the intra-cycle RAW edges (so the schedule is acyclic) and replace them
    // with mutual exclusion, so no two cycle members ever share a wave.
    for (const m of cyc) {
      for (const p of [...rawPred.get(m)!]) if (members.has(p)) rawPred.get(m)!.delete(p);
    }
    for (let i = 0; i < cyc.length; i++) {
      for (let j = i + 1; j < cyc.length; j++) {
        waw.get(cyc[i])!.add(cyc[j]);
        waw.get(cyc[j])!.add(cyc[i]);
      }
    }
  }

  // 3. Schedule: greedy wave assignment honoring RAW order + WAW exclusion.
  const wave = assignWaves(taskIds, rawPred, waw);
  const maxWave = Math.max(1, ...taskIds.map(id => wave.get(id)!));
  const waves: Wave[] = [];
  for (let w = 1; w <= maxWave; w++) {
    const inWave = taskIds.filter(id => wave.get(id) === w).sort();
    const waitsOn = new Set<string>();
    for (const id of inWave) for (const p of rawPred.get(id)!) if (wave.get(p)! < w) waitsOn.add(p);
    waves.push({ wave: w, taskIds: inWave, waitsOn: [...waitsOn].sort() });
  }

  // 4. Critical path: longest hard-ordered chain (RAW edges + WAW wave-ordered edges).
  const chain = longestChain(taskIds, rawPred, waw, wave);
  const maxWidth = Math.max(1, ...waves.map(w => w.taskIds.length));
  const criticalPath: CriticalPath = {
    rounds: maxWave,
    chain,
    summary:
      `At most ${maxWave} sequential round(s) even with unlimited agents; ` +
      `peak wave width is ${maxWidth}, so beyond ${maxWidth} concurrent agent(s) buys nothing.`,
  };

  return boundResponse({
    taskCount: footprints.length,
    footprints: footprints.map(renderFootprint),
    conflicts: conflicts.slice(0, CONFLICT_LIST_CAP),
    conflictCount: conflicts.length,
    conflictsTruncated: conflicts.length > CONFLICT_LIST_CAP,
    waves,
    criticalPath,
    advisories: advisories.slice(0, CONFLICT_LIST_CAP),
    advisoryCount: advisories.length,
    advisoriesTruncated: advisories.length > CONFLICT_LIST_CAP,
    findings: findings.slice(0, FINDINGS_LIST_CAP),
    findingCount: findings.length,
    findingsTruncated: findings.length > FINDINGS_LIST_CAP,
    scheduling: SCHEDULING_NOTE,
    disclosure: DISCLOSURE,
  });
}

/** Cap a witness list for output; a list longer than the cap carries no extra signal. */
function capWitnesses(witnesses: string[]): string[] {
  return witnesses.slice(0, WITNESS_CAP);
}

/** Human-readable witness summary for a finding message, with an overflow count. */
function witnessSummary(witnesses: string[]): string {
  const shown = witnesses.slice(0, WITNESS_CAP).join(', ');
  return witnesses.length > WITNESS_CAP ? `${shown} (+${witnesses.length - WITNESS_CAP} more)` : shown;
}

/**
 * Deterministic response-size backstop. The per-list caps keep typical plans
 * small, but a pathological large plan (e.g. 64 tasks each seeding a whole file)
 * can still exceed {@link SOFT_BUDGET_BYTES}. Rather than let the dispatch hard cap
 * mangle the structured result, collapse the per-task footprint *sample lists* to
 * their (authoritative) counts — the schedule and counts are always retained — and
 * disclose it via `truncationNote`. Idempotent and a pure function of the input.
 */
function boundResponse(plan: ParallelWorkPlan): ParallelWorkPlan {
  if (jsonBytes(plan) <= SOFT_BUDGET_BYTES) return plan;

  // Stage 1: collapse per-task footprint sample lists to their counts.
  for (const f of plan.footprints) {
    f.writeSet = f.writeSet.slice(0, 3);
    f.writeSetTruncated = f.writeSetCount > f.writeSet.length;
    f.readSet = [];
    f.readSetTruncated = f.readSetCount > 0;
    f.affectedSet = [];
    f.affectedSetTruncated = f.affectedSetCount > 0;
    f.ambientReadDeps = [];
    f.ambientReadDepsTruncated = f.ambientReadDepCount > 0;
    f.couplingNeighbors = [];
    f.couplingNeighborsTruncated = f.couplingNeighborCount > 0;
  }
  plan.truncationNote =
    'Large plan: per-task footprint sample lists were collapsed to their counts to keep the response ' +
    'within budget. The schedule, counts, and conflict graph are authoritative; re-invoke with fewer ' +
    'tasks for per-symbol footprint detail.';
  if (jsonBytes(plan) <= SOFT_BUDGET_BYTES) return plan;

  // Stage 2: tighten the O(N²) supporting-evidence lists (the schedule still
  // encodes every conflict's consequence; counts remain authoritative).
  const trim = 50;
  const trimWit = <T extends { witnesses: string[] }>(x: T): T => ({ ...x, witnesses: x.witnesses.slice(0, 3) });
  plan.conflicts = plan.conflicts.slice(0, trim).map(trimWit);
  plan.conflictsTruncated = plan.conflictCount > plan.conflicts.length;
  plan.advisories = plan.advisories.slice(0, trim).map(trimWit);
  plan.advisoriesTruncated = plan.advisoryCount > plan.advisories.length;
  plan.findings = plan.findings.slice(0, 25);
  plan.findingsTruncated = plan.findingCount > plan.findings.length;
  plan.truncationNote =
    'Large plan: per-task footprint sample lists were collapsed to counts and the conflict / advisory / ' +
    'finding evidence lists were further trimmed to keep the response within budget. The schedule (waves ' +
    '+ critical path) and all counts are authoritative; re-invoke with fewer tasks for full detail.';
  return plan;
}

/** Cheap deterministic byte estimate of a JSON-serializable value. */
function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

/** Apply a RAW verdict as an ordering edge; a bidirectional RAW is an unorderable cycle → mutual exclusion. */
function applyRaw(
  aId: string,
  bId: string,
  direction: HazardVerdict['direction'],
  rawPred: Map<string, Set<string>>,
  waw: Map<string, Set<string>>,
): void {
  if (direction === 'B after A') {
    rawPred.get(bId)!.add(aId); // B depends on A
  } else if (direction === 'A after B') {
    rawPred.get(aId)!.add(bId); // A depends on B
  } else {
    // bidirectional: each reads the other's writes — no clean order; separate into different waves.
    waw.get(aId)!.add(bId);
    waw.get(bId)!.add(aId);
  }
}

function advisoryNote(kind: HazardVerdict['kind']): string {
  switch (kind) {
    case 'shared-append':
      return 'Both tasks append to a shared registration site; git 3-way-merges trivially. Safe to parallelize.';
    case 'WAR':
      return 'Same file, disjoint symbols (or a read-only overlap). Low risk; safe to parallelize.';
    case 'soft-coupling':
      return 'Files historically co-change but share no static call relation. Advisory only.';
    default:
      return '';
  }
}

/**
 * Greedy wave assignment. Tasks are processed in a RAW-topological order (a
 * predecessor is always placed before its dependents); each task takes the
 * smallest wave that is (a) strictly after all its RAW predecessors and (b) not
 * already occupied by a WAW-conflicting peer. Deterministic for a fixed input.
 * Cycle-safe: any task not reachable in topological order (a RAW cycle, which
 * `applyRaw` already downgrades to WAW for the bidirectional case) is appended in
 * id order.
 */
function assignWaves(
  taskIds: string[],
  rawPred: Map<string, Set<string>>,
  waw: Map<string, Set<string>>,
): Map<string, number> {
  const order = topoOrder(taskIds, rawPred);
  const wave = new Map<string, number>();
  for (const id of order) {
    let w = 1;
    for (const p of rawPred.get(id)!) {
      const pw = wave.get(p);
      if (pw !== undefined) w = Math.max(w, pw + 1);
    }
    // Bump past any WAW-conflicting peer already placed in wave w.
    const conflicts = waw.get(id)!;
    let bumped = true;
    while (bumped) {
      bumped = false;
      for (const c of conflicts) {
        if (wave.get(c) === w) {
          w++;
          bumped = true;
          break;
        }
      }
    }
    wave.set(id, w);
  }
  return wave;
}

/**
 * Strongly-connected components of size > 1 in the RAW "depends-on" graph — the
 * unorderable cycles. Tarjan's algorithm over `rawPred` (node → its predecessors);
 * a directed cycle exists in this graph iff one exists in its reverse, so the
 * adjacency direction is immaterial to cycle membership. Deterministic: nodes and
 * neighbours are visited in sorted order, and each component is returned sorted.
 */
function detectRawCycles(taskIds: string[], rawPred: Map<string, Set<string>>): string[][] {
  const taskSet = new Set(taskIds);
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  let counter = 0;

  const strongconnect = (v: string): void => {
    index.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of [...(rawPred.get(v) ?? [])].sort()) {
      if (!taskSet.has(w)) continue;
      if (!index.has(w)) {
        strongconnect(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) === index.get(v)) {
      const comp: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1) sccs.push(comp.sort());
    }
  };

  for (const v of [...taskIds].sort()) if (!index.has(v)) strongconnect(v);
  return sccs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** Kahn-style topological order by RAW predecessors; ties broken by id. */
function topoOrder(taskIds: string[], rawPred: Map<string, Set<string>>): string[] {
  const sorted = [...taskIds].sort();
  const placed = new Set<string>();
  const order: string[] = [];
  let progress = true;
  while (order.length < sorted.length && progress) {
    progress = false;
    for (const id of sorted) {
      if (placed.has(id)) continue;
      const preds = rawPred.get(id)!;
      if ([...preds].every(p => placed.has(p) || !taskIds.includes(p))) {
        order.push(id);
        placed.add(id);
        progress = true;
      }
    }
  }
  // Remainder safety net: RAW cycles are broken (→ mutual exclusion) before this runs,
  // so the progress loop always places everything; append any straggler in id order
  // rather than loop forever, should an unexpected cycle ever reach here.
  for (const id of sorted) if (!placed.has(id)) order.push(id);
  return order;
}

/** Longest chain of hard-ordered tasks: RAW edges plus WAW pairs directed by assigned wave. */
function longestChain(
  taskIds: string[],
  rawPred: Map<string, Set<string>>,
  waw: Map<string, Set<string>>,
  wave: Map<string, number>,
): string[] {
  // Build "must run after" edges: pred → succ.
  const succ = new Map<string, Set<string>>();
  for (const id of taskIds) succ.set(id, new Set());
  for (const id of taskIds) {
    for (const p of rawPred.get(id)!) if (taskIds.includes(p)) succ.get(p)!.add(id);
    for (const c of waw.get(id)!) {
      // Direct the WAW edge by wave order (lower wave → higher), ties by id, so it is acyclic.
      if (wave.get(id)! < wave.get(c)! || (wave.get(id)! === wave.get(c)! && id < c)) succ.get(id)!.add(c);
    }
  }
  const memo = new Map<string, string[]>();
  const visiting = new Set<string>();
  const best = (id: string): string[] => {
    if (memo.has(id)) return memo.get(id)!;
    if (visiting.has(id)) return [id]; // cycle guard
    visiting.add(id);
    let longest: string[] = [];
    for (const s of [...succ.get(id)!].sort()) {
      const cand = best(s);
      if (cand.length > longest.length) longest = cand;
    }
    visiting.delete(id);
    const chain = [id, ...longest];
    memo.set(id, chain);
    return chain;
  };
  let result: string[] = [];
  for (const id of [...taskIds].sort()) {
    const c = best(id);
    if (c.length > result.length) result = c;
  }
  return result;
}

function renderFootprint(f: Footprint): RenderedFootprint {
  const cap = FOOTPRINT_LIST_CAP;
  return {
    taskId: f.taskId,
    writeSet: f.writeSet
      .slice(0, cap)
      .map(w => ({ id: w.id, name: w.name, filePath: w.filePath, writeMode: w.writeMode })),
    writeSetCount: f.writeSet.length,
    writeSetTruncated: f.writeSet.length > cap,
    readSet: f.readSet.slice(0, cap),
    readSetCount: f.readSet.length,
    readSetTruncated: f.readSet.length > cap,
    affectedSet: f.affectedSet.slice(0, cap),
    affectedSetCount: f.affectedSet.length,
    affectedSetTruncated: f.affectedSet.length > cap,
    ambientReadDeps: f.ambientReadDeps.slice(0, cap),
    ambientReadDepCount: f.ambientReadDeps.length,
    ambientReadDepsTruncated: f.ambientReadDeps.length > cap,
    couplingNeighbors: f.couplingNeighbors.slice(0, cap),
    couplingNeighborCount: f.couplingNeighbors.length,
    couplingNeighborsTruncated: f.couplingNeighbors.length > cap,
    unresolvedSeeds: f.unresolvedSeeds,
  };
}

/** MCP dispatch entry. */
export async function handlePlanParallelWork(input: PlanParallelWorkInput): Promise<unknown> {
  return computePlanParallelWork(input);
}
