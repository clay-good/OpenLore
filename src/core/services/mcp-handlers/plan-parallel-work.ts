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
 * Advisory by default: the plan blocks nothing on its own. A repo MAY opt the
 * `parallel-work-conflict` finding into blocking via `enforcement.policy`
 * (add-finding-enforcement-policy), but the default is pure advice.
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
const FOOTPRINT_LIST_CAP = 50;

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

/** A task's footprint, rendered for the plan (write-set in full; large regions capped with counts). */
export interface RenderedFootprint {
  taskId: string;
  writeSet: Array<{ id: string; name: string; filePath: string; writeMode: string }>;
  readSet: string[];
  readSetCount: number;
  readSetTruncated: boolean;
  affectedSet: string[];
  affectedSetCount: number;
  affectedSetTruncated: boolean;
  ambientReadDeps: string[];
  couplingNeighbors: string[];
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
  /** Pairwise hazards (only the non-`none` pairs), as supporting evidence with witnesses. */
  conflicts: ConflictPair[];
  /** The computed answer: an ordered list of dispatch waves. */
  waves: Wave[];
  criticalPath: CriticalPath;
  /** Low-risk pairs surfaced as warnings (shared-append / WAR / soft-coupling) — non-serializing. */
  advisories: Array<{ kind: HazardVerdict['kind']; taskA: string; taskB: string; witnesses: string[]; note: string }>;
  /** Opt-in gating: WAW conflicts among the proposed tasks, as governance findings (advisory by default). */
  findings: GovernanceFinding[];
  /** Greedy + topological; not optimal — stated plainly. */
  scheduling: string;
  /** Standing known-unknowable disclosure. */
  disclosure: string;
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
    couplingLookup: ctx.edgeStore
      ? (files: string[]) => ctx.edgeStore!.getChangeCouplingForFiles(files)
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
      conflicts.push({ taskA: a.taskId, taskB: b.taskId, hazard: v.kind, direction: v.direction, witnesses: v.witnesses });

      if (v.kind === 'WAW') {
        waw.get(a.taskId)!.add(b.taskId);
        waw.get(b.taskId)!.add(a.taskId);
        findings.push({
          code: 'parallel-work-conflict',
          severity: 'warning',
          source: 'plan-parallel-work',
          subject: `${a.taskId} × ${b.taskId}`,
          message: `Write-write conflict on ${v.witnesses.join(', ')} — these tasks must not edit concurrently (scheduled into different waves).`,
        });
      } else if (v.kind === 'RAW') {
        applyRaw(a.taskId, b.taskId, v.direction, rawPred, waw);
      } else {
        // shared-append / WAR / soft-coupling → advisory, non-serializing.
        advisories.push({
          kind: v.kind,
          taskA: a.taskId,
          taskB: b.taskId,
          witnesses: v.witnesses,
          note: advisoryNote(v.kind),
        });
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

  return {
    taskCount: footprints.length,
    footprints: footprints.map(renderFootprint),
    conflicts,
    waves,
    criticalPath,
    advisories,
    findings,
    scheduling: SCHEDULING_NOTE,
    disclosure: DISCLOSURE,
  };
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

/** Kahn-style topological order by RAW predecessors; ties and cycle remainder broken by id. */
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
  // Cycle remainder (should not occur after bidirectional downgrade): append in id order.
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
  return {
    taskId: f.taskId,
    writeSet: f.writeSet.map(w => ({ id: w.id, name: w.name, filePath: w.filePath, writeMode: w.writeMode })),
    readSet: f.readSet.slice(0, FOOTPRINT_LIST_CAP),
    readSetCount: f.readSet.length,
    readSetTruncated: f.readSet.length > FOOTPRINT_LIST_CAP,
    affectedSet: f.affectedSet.slice(0, FOOTPRINT_LIST_CAP),
    affectedSetCount: f.affectedSet.length,
    affectedSetTruncated: f.affectedSet.length > FOOTPRINT_LIST_CAP,
    ambientReadDeps: f.ambientReadDeps,
    couplingNeighbors: f.couplingNeighbors,
    unresolvedSeeds: f.unresolvedSeeds,
  };
}

/** MCP dispatch entry. */
export async function handlePlanParallelWork(input: PlanParallelWorkInput): Promise<unknown> {
  return computePlanParallelWork(input);
}
