/**
 * Memory strategy — the pre-flight capacity estimate and the graceful-degradation ladder
 * (change: make-analyze-scale-to-any-repo).
 *
 * Two deterministic decisions, kept a pure function of DECLARED constraints so the produced
 * artifact never depends on how much RAM the machine happened to have:
 *
 *  1. {@link estimateGraphMemoryBytes} — how much heap the analysis will need, derived from the
 *     repository's own size alone (analyzed file count + total source bytes, already produced by
 *     the repository mapper). No RAM, no clock, no I/O: the same repository yields the same
 *     number, so the strategy it drives is reproducible.
 *
 *  2. {@link chooseMemoryTier} — full fidelity when the estimate fits the heap with headroom,
 *     otherwise a tier of the degradation ladder. This is the ONLY place a machine-dependent
 *     input (the heap) enters, and it can only ever REDUCE work along a declared, ordered ladder
 *     — never silently change a full-fidelity result. Two full-fidelity runs of the same
 *     repository are byte-identical regardless of each machine's RAM.
 *
 * The ladder sheds the most expensive, least-essential work first:
 *   tier 1 `shed-overlay`                 drop the CFG/def-use overlay — the biggest resident cost
 *   tier 2 `shed-overlay-and-deep-analysis`  additionally shrink LLM deep-analysis breadth
 * A usable index (call graph + search) is produced in EVERY tier.
 *
 * What was shed is disclosed through the parse-health artifact (a {@link MemoryDegradation}
 * record) and one CLI line, so a downstream conclusion reads reduced coverage as reduced, never
 * as a genuine structural absence — the same discipline as an excluded-file boundary.
 */

import { getHeapStatistics } from 'node:v8';
import { AsyncLocalStorage } from 'node:async_hooks';

// ============================================================================
// TIERS
// ============================================================================

/**
 * The chosen memory strategy. `full` is the common case and the ONLY one that changes nothing;
 * the two shed tiers are the ladder, in the order the ladder applies them.
 */
export type MemoryTier = 'full' | 'shed-overlay' | 'shed-overlay-and-deep-analysis';

/** A single capability the ladder can shed, named for disclosure. */
export type MemoryShedComponent = 'cfg-overlay' | 'deep-analysis-breadth';

/** All tiers, in ladder order, so a `force` override and tests can validate the set. */
export const MEMORY_TIERS: readonly MemoryTier[] = [
  'full',
  'shed-overlay',
  'shed-overlay-and-deep-analysis',
] as const;

/** The components each tier sheds (in ladder order). `full` sheds nothing. */
export function shedComponentsFor(tier: MemoryTier): MemoryShedComponent[] {
  switch (tier) {
    case 'full':
      return [];
    case 'shed-overlay':
      return ['cfg-overlay'];
    case 'shed-overlay-and-deep-analysis':
      return ['cfg-overlay', 'deep-analysis-breadth'];
  }
}

// ============================================================================
// ESTIMATE
// ============================================================================

/** Repository-size inputs for the estimate — everything the mapper already knows. */
export interface RepoSizeInputs {
  /** Number of files that will be analyzed (nodes/edges scale with this). */
  analyzedFileCount: number;
  /** Total bytes of the analyzed source (the graph's resident size scales with this). */
  totalSourceBytes: number;
}

/**
 * Fixed floor of the estimate — the interpreter, grammars, and fixed analyzer structures a run
 * needs before it touches any of the repository's own bytes.
 */
export const GRAPH_BYTES_BASE = 64 * 1024 * 1024;

/**
 * Peak heap, in bytes, the analysis is assumed to need per byte of analyzed source. Conservative
 * and empirically seeded: a large repository's parsed nodes, raw edges, resolution trie, CFG
 * overlay, and the transient artifacts built from them peak at many times the source text in V8
 * object memory (microsoft/TypeScript's ~1 GB graph + ~277 MB overlay at ~126k functions anchors
 * the order of magnitude). Deliberately an OVER-estimate so degradation triggers before a crash,
 * not after — the safety net is "degrade early," never "discover the ceiling by failing."
 */
export const GRAPH_BYTES_PER_SOURCE_BYTE = 18;

/** Per-file overhead independent of file size (node/edge bookkeeping, per-file records). */
export const GRAPH_BYTES_PER_FILE = 8 * 1024;

/**
 * How many files LLM deep-analysis is capped to once tier 2 sheds its breadth. Small but non-zero:
 * the index stays usable and the most important files' bodies are still carried, while the largest
 * transient the deep-analysis phase holds shrinks. Applied as a floor with the caller's own limit
 * (`min`), so a caller already asking for fewer keeps its smaller number.
 */
export const SHED_DEEP_ANALYSIS_FILE_CAP = 5;

/**
 * Conservative, deterministic estimate of the peak heap the analysis will need, from the
 * repository's size alone. Pure: no RAM, no clock, no I/O — the same inputs always yield the same
 * number, which is what makes the strategy reproducible for a given memory budget.
 *
 * An operator (or a determinism test) may pin the estimate with `OPENLORE_MEMORY_ESTIMATE_BYTES`.
 */
export function estimateGraphMemoryBytes(inputs: RepoSizeInputs): number {
  const override = readPositiveIntEnv('OPENLORE_MEMORY_ESTIMATE_BYTES');
  if (override !== undefined) return override;
  const files = Math.max(0, inputs.analyzedFileCount);
  const bytes = Math.max(0, inputs.totalSourceBytes);
  return GRAPH_BYTES_BASE + bytes * GRAPH_BYTES_PER_SOURCE_BYTE + files * GRAPH_BYTES_PER_FILE;
}

// ============================================================================
// TIER CHOICE
// ============================================================================

/**
 * Estimate at or below this fraction of the available heap ⇒ full fidelity. Leaves generous
 * headroom for the many artifacts built AFTER the graph (vector index, text-line index, the
 * degradation-free run's overlay) that the estimate does not itemize.
 */
export const FULL_FIDELITY_HEAP_FRACTION = 0.6;

/**
 * Estimate above this fraction of the available heap ⇒ shed deep-analysis breadth too (tier 2).
 * Between the two fractions only the overlay is shed (tier 1).
 */
export const DEEP_ANALYSIS_SHED_HEAP_FRACTION = 0.85;

/**
 * Choose the memory tier from the deterministic estimate and the heap available to THIS process.
 * The heap is the only machine-dependent input, and it can only move the result DOWN the ladder —
 * it never alters what a full-fidelity run produces. A non-finite or non-positive heap is treated
 * as "unknown, assume it fits" (full fidelity): we never degrade on a number we cannot trust.
 */
export function chooseMemoryTier(estimateBytes: number, availableHeapBytes: number): MemoryTier {
  if (!Number.isFinite(availableHeapBytes) || availableHeapBytes <= 0) return 'full';
  if (estimateBytes <= availableHeapBytes * FULL_FIDELITY_HEAP_FRACTION) return 'full';
  if (estimateBytes <= availableHeapBytes * DEEP_ANALYSIS_SHED_HEAP_FRACTION) return 'shed-overlay';
  return 'shed-overlay-and-deep-analysis';
}

/** The heap limit, in bytes, available to this process (post adaptive-sizing). */
export function availableHeapBytes(): number {
  return getHeapStatistics().heap_size_limit;
}

// ============================================================================
// DISCLOSURE RECORD
// ============================================================================

/**
 * What the ladder reduced, and the declared constraints that decided it. Recorded in the
 * parse-health artifact and rendered as one CLI line. Present ONLY when a tier was actually shed
 * (`full` produces none), so a healthy full-fidelity run carries no degradation record and its
 * artifact stays byte-identical to a run that never had this feature.
 *
 * Every field is a DECLARED constraint or its consequence — never a wall-clock or per-machine
 * measurement — so two runs under the same budget disclose the same thing.
 */
export interface MemoryDegradation {
  tier: Exclude<MemoryTier, 'full'>;
  /** Components shed, in ladder order (`cfg-overlay` first). */
  shed: MemoryShedComponent[];
  /** The deterministic estimate (bytes) that triggered degradation. */
  estimatedBytes: number;
  /** The heap budget (bytes) the estimate was measured against. */
  availableHeapBytes: number;
}

/** Human phrasing for one shed component, shared by every surface that renders one. */
export const SHED_COMPONENT_LABEL: Record<MemoryShedComponent, string> = {
  'cfg-overlay': 'CFG/def-use overlay',
  'deep-analysis-breadth': 'LLM deep-analysis breadth',
};

/**
 * Build the disclosure record for a chosen tier, or `undefined` for `full` (nothing shed). Pure:
 * a function of the tier and the declared constraints only, so it is reproducible.
 */
export function buildMemoryDegradation(
  tier: MemoryTier,
  estimateBytes: number,
  heapBytes: number,
): MemoryDegradation | undefined {
  if (tier === 'full') return undefined;
  return {
    tier,
    shed: shedComponentsFor(tier),
    estimatedBytes: estimateBytes,
    availableHeapBytes: heapBytes,
  };
}

/**
 * One-line, deterministic summary of a memory degradation, e.g.
 * "Reduced under memory pressure: shed CFG/def-use overlay, LLM deep-analysis breadth
 *  (estimated 3.1 GB vs 2.0 GB heap) — coverage from these is a LOWER BOUND, not genuine absence".
 * `undefined` when nothing was shed. Shared so `analyze` and any other surface word it identically.
 */
export function describeMemoryDegradation(d: MemoryDegradation | undefined): string | undefined {
  if (!d || d.shed.length === 0) return undefined;
  const shed = d.shed.map(c => SHED_COMPONENT_LABEL[c]).join(', ');
  return (
    `Reduced under memory pressure: shed ${shed} ` +
    `(estimated ${formatBytes(d.estimatedBytes)} vs ${formatBytes(d.availableHeapBytes)} heap) — ` +
    `coverage from these is a LOWER BOUND, not genuine absence`
  );
}

// ============================================================================
// STRATEGY DRIVER
// ============================================================================

/**
 * The concrete knobs the artifact generator applies for a tier. Derived once from the tier so the
 * generator never re-interprets the ladder.
 */
export interface MemoryStrategy {
  tier: MemoryTier;
  /** Skip building the per-function CFG/def-use overlay entirely. */
  shedCfgOverlay: boolean;
  /** Shrink LLM deep-analysis breadth (fewer files' bodies held and serialized). */
  shedDeepAnalysis: boolean;
  /** Disclosure record (undefined at full fidelity). */
  degradation: MemoryDegradation | undefined;
}

/** Environment override that forces a tier regardless of the estimate/heap (operator + tests). */
export const FORCE_TIER_ENV = 'OPENLORE_FORCE_MEMORY_TIER';

/**
 * Resolve the memory strategy for a repository. Reads the forced-tier override first (an operator
 * knob and the deterministic hook the ladder is tested through); otherwise estimates from the
 * repository size and compares against the heap available to this process.
 */
export function resolveMemoryStrategy(inputs: RepoSizeInputs): MemoryStrategy {
  const heap = availableHeapBytes();
  const estimate = estimateGraphMemoryBytes(inputs);
  const forced = readForcedTier();
  const tier = forced ?? chooseMemoryTier(estimate, heap);
  return {
    tier,
    shedCfgOverlay: tier !== 'full',
    shedDeepAnalysis: tier === 'shed-overlay-and-deep-analysis',
    degradation: buildMemoryDegradation(tier, estimate, heap),
  };
}

/**
 * Main-thread channel for the overlay-shed decision: an async-context store, NOT a process global.
 * The MCP server runs builds CONCURRENTLY (a background self-heal rebuild alongside a tool-call
 * build), and a process-global flag shared between two overlapping builds corrupts and leaks —
 * one build's cleanup clears the flag the other still needs, or leaves it set so a later
 * full-fidelity build silently sheds with no disclosure. An `AsyncLocalStorage` gives each build
 * its own value along its own async call chain, so concurrent builds never interfere and a
 * full-fidelity build (no store) can never be contaminated by a concurrent shedding one.
 */
const cfgOverlayShedStore = new AsyncLocalStorage<boolean>();

/**
 * Worker-isolate channel. An extraction worker is a separate V8 isolate that cannot see the main
 * thread's async store, so it receives the decision in `workerData` and latches it here at startup.
 * A module flag is safe HERE precisely because a worker isolate serves exactly one build and one
 * thread — none of the concurrency that makes a process-global unsafe on the main thread.
 */
let workerCfgOverlayShed = false;

/** Worker-side: latch the shed decision passed in `workerData`. Called once at worker startup. */
export function setWorkerCfgOverlayShed(shed: boolean): void {
  workerCfgOverlayShed = shed;
}

/**
 * True when the CFG/def-use overlay has been shed for the current build. On the main thread this is
 * the async-context store (per build, concurrency-safe); inside an extraction worker it is the
 * latched worker flag. `buildCfgFor` reads it and short-circuits.
 */
export function isCfgOverlayShed(): boolean {
  return cfgOverlayShedStore.getStore() === true || workerCfgOverlayShed;
}

/**
 * Run the call-graph build `fn` with the overlay shed when `shed` is true. Binds an async-context
 * store for the whole build so both the main-thread serial lane and — via `isCfgOverlayShed()` read
 * at worker spawn and forwarded through `workerData` — the extraction workers see one consistent,
 * build-scoped decision, with no shared mutable global to race across concurrent builds.
 */
export function withCfgOverlayShed<T>(shed: boolean, fn: () => Promise<T>): Promise<T> {
  return shed ? cfgOverlayShedStore.run(true, fn) : fn();
}

// ============================================================================
// HELPERS
// ============================================================================

function readForcedTier(): MemoryTier | undefined {
  const raw = process.env[FORCE_TIER_ENV];
  if (!raw) return undefined;
  const v = raw.trim();
  return (MEMORY_TIERS as readonly string[]).includes(v) ? (v as MemoryTier) : undefined;
}

function readPositiveIntEnv(name: string): number | undefined {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined;
}

/** Compact, deterministic byte formatting (KB/MB/GB, one decimal) for disclosure lines. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  const rounded = i === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[i]}`;
}
