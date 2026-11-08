/**
 * Per-file EXTRACTION budget (changes: fix-analyze-native-abort-and-file-cost-budget,
 * bound-large-literal-extraction).
 *
 * The bound covers one file's whole extraction — the parse AND everything the per-language
 * extractor then does with the tree. It began as a parse-only bound, and that was not the bound
 * the documentation claimed: a generated `demo.pb.go` parsed in milliseconds and then spent 82 s
 * in a post-parse tree walk, so a documented 20 s per-file bound let an 82 s file through with no
 * disclosure at all. A bound that does not hold is an honesty defect as much as a performance one,
 * so the clock now starts at {@link runWithExtractionBudget} and covers every phase.
 *
 * Extraction of one file used to be unbounded in wall-clock time. Measured on a 300 KB file of
 * a repeated unterminated block-comment opener: 84 s inside `parser.parse()` alone, yielding a
 * 100,002-deep tree. A minified bundle or a generated client in an ordinary repository reaches
 * the same path, so this is not only a hostile-input problem.
 *
 * ## Why the bound is in-band, not a timer
 *
 * Nothing here is a timer: an extraction is synchronous JS over a native tree, so the event loop
 * does not run until it returns and a `setTimeout` could never fire in time to stop it. The bound
 * is instead checked at COOPERATIVE CHECKPOINTS the extraction already passes through:
 *
 *  1. inside `parser.parse()`, via tree-sitter's own deadline (see below), armed with the time
 *     REMAINING on the file's budget rather than the whole of it;
 *  2. at each shared post-parse phase boundary (the style / parse-health / dynamic-boundary /
 *     content-hash / CFG / class-relationship tallies every language extractor funnels through);
 *  3. once per node inside the shared tree-walk children boundary (`readNamedChildren`);
 *  4. conclusively when the file's extraction RETURNS — see {@link runWithExtractionBudget}.
 *
 * Checkpoint 4 is what makes the bound hold absolutely for the GRAPH: no file whose extraction
 * exceeded the budget is admitted, whether or not a checkpoint interrupted it. Checkpoints 1–3 are
 * what usually make it hold in WALL CLOCK too. A phase carrying none of them can still overshoot
 * until it finishes — that is a real, disclosed limit of a cooperative bound, not a covered case.
 *
 * `parser.parse()` is one synchronous call into a native binding. A `setTimeout` cannot preempt
 * it — the event loop does not run until it returns — and terminating the worker that holds it
 * is precisely what turns a slow parse into a process-level `abort()` (V8 can only interrupt a
 * thread at a JS boundary; an interrupt delivered inside a native frame surfaces as a C++
 * exception with nowhere to go). tree-sitter's own deadline is the only bound that can actually
 * stop the work: it is checked inside the parse loop, and on expiry `parse()` simply returns no
 * tree. Nothing is killed, and the parser stays reusable for the next file.
 *
 * ## Honesty
 *
 * A budgeted result is a LOWER BOUND and reads as one. An abandoned file is never silently
 * dropped: {@link ExtractionBudgetExceededError} carries the elapsed time, the caller records the
 * file with reason `budget-exceeded`, and conclusions built over it disclose the boundary. The
 * bound is disabled by setting `OPENLORE_PARSE_BUDGET_MS=0`, which reproduces the previous
 * behavior exactly — the escape hatch for anyone who would rather wait than be told.
 *
 * A binding whose `setTimeoutMicros` is unavailable or unusable (older native builds, and the
 * web-tree-sitter WASM lane) simply parses unbounded, as it did before — {@link parseBudgetSupported}
 * reports which. That is a real limit of CHECKPOINT 1, not a covered case: on those languages a
 * runaway PARSE still runs to completion. Checkpoints 2–4 are language-independent, so such a file
 * is still abandoned and disclosed once the parse returns — it is the wall clock that is unbounded
 * there, not the graph.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { PER_FILE_EXTRACTION_BUDGET_MS, PARSE_BUDGET_ENV } from '../../constants.js';
import { recordPerfWork } from './perf-counters.js';

/**
 * Stable prefix on {@link ExtractionBudgetExceededError}'s message.
 *
 * The message is the ONLY channel that survives an extraction worker: a throw crossing the
 * `worker_threads` boundary is structured-cloned, so its class, prototype and properties are
 * gone by the time the parent sees it. Keying the reason off a message prefix is what makes the
 * pooled and serial lanes classify the same failure identically — an `instanceof` check would
 * behave differently on the two lanes, which is the bug this prefix exists to avoid.
 */
export const EXTRACTION_BUDGET_MESSAGE_PREFIX = 'openlore:extraction-budget-exceeded';

/** Thrown when one file's extraction was abandoned at the deadline. Carries the bound and the spend. */
export class ExtractionBudgetExceededError extends Error {
  readonly elapsedMs: number;
  readonly budgetMs: number;

  constructor(elapsedMs: number, budgetMs: number) {
    super(
      `${EXTRACTION_BUDGET_MESSAGE_PREFIX}: abandoned after ${elapsedMs}ms `
      + `(budget ${budgetMs}ms; raise or disable with ${PARSE_BUDGET_ENV})`,
    );
    this.name = 'ExtractionBudgetExceededError';
    this.elapsedMs = elapsedMs;
    this.budgetMs = budgetMs;
  }
}

/**
 * Read `message` as a budget-exceeded signal, returning the BUDGET it names.
 *
 * Message-based on purpose — see {@link EXTRACTION_BUDGET_MESSAGE_PREFIX}. Returns `undefined` for
 * any other failure, so an ordinary parse failure is never re-labelled as a budget overrun.
 *
 * The budget rather than the elapsed time, because the caller records it in a persisted artifact
 * that must be byte-identical across re-analyses of a fixed repository state — see
 * `FileParseHealth.budgetMs`.
 */
export function extractionBudgetOverrunMs(message: string | undefined): number | undefined {
  if (!message || !message.startsWith(EXTRACTION_BUDGET_MESSAGE_PREFIX)) return undefined;
  const m = /budget (\d+)ms/.exec(message);
  // A marked message with no readable budget is still a budget overrun — falling through to
  // `undefined` would silently re-label it as an ordinary parse failure.
  return m ? Number(m[1]) : extractionBudgetMs();
}

/**
 * The active budget in milliseconds, or `0` when disabled.
 *
 * Read per call rather than cached at module load: extraction workers inherit `process.env`, and
 * tests set the override around a single build. A value that is not a finite, non-negative number
 * is ignored in favour of the default — a typo must not silently disable the bound.
 */
export function extractionBudgetMs(): number {
  const raw = process.env[PARSE_BUDGET_ENV];
  if (raw === undefined || raw.trim() === '') return PER_FILE_EXTRACTION_BUDGET_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return PER_FILE_EXTRACTION_BUDGET_MS;
  return Math.floor(parsed);
}

/** The minimum shape {@link parseWithBudget} needs. Narrow so tests can supply a plain object. */
export interface BudgetableParser<TTree> {
  parse(content: string): TTree | null | undefined;
  setTimeoutMicros?(micros: number): void;
  /**
   * Discard partial parse state. Load-bearing after a deadline fires — see
   * {@link parseWithBudget}. Optional so a test double need not supply it.
   */
  reset?(): void;
}

/**
 * Constructors whose `setTimeoutMicros` EXISTS but does not work.
 *
 * Presence is not capability. `web-tree-sitter@0.25` exposes `setTimeoutMicros` and throws
 * `TypeError: Cannot convert 0 to a BigInt` from inside it — its WASM shim passes a Number where
 * the import demands a BigInt. Left to propagate, arming the deadline made every file in the
 * WASM-grammar languages fail to extract: a bound that silently deleted real work, which is the
 * exact failure mode this change exists to prevent. So the first refusal demotes that KIND of
 * parser to unbounded rather than being paid, and thrown, per file.
 *
 * The lane that provoked this has since narrowed to Dart alone (Lua moved to the native lane,
 * #472) and `web-tree-sitter@0.27` omits `setTimeoutMicros` altogether, so today Dart takes the
 * plain unsupported path above rather than this one. The demotion stays: it is keyed on the
 * binding, not on a language, and it is the only thing standing between a future
 * exists-but-throws deadline and silently empty extraction.
 *
 * Keyed on the parser's PROTOTYPE, not the instance. Keying the instance looked right and was
 * useless on the one lane it was written for: the WASM grammar handle constructs a fresh parser
 * for every file (its heap must not be shared), so the instance recorded on file N was never
 * consulted on file N+1 and the throw was re-paid every time. All instances from one binding share
 * a prototype, so this records the binding's capability, which is what is actually being learned.
 *
 * A `WeakSet` so nothing here keeps a discarded binding alive.
 */
const deadlineUnsupported = new WeakSet<object>();

/**
 * The key under which a parser's deadline capability is remembered — see above.
 *
 * The CONSTRUCTOR, so every instance from one binding shares an entry. Not the prototype: a plain
 * object literal's prototype is `Object.prototype`, shared with every other object literal in the
 * process, so one refusing parser would demote unrelated ones. Anything without a distinct
 * constructor falls back to its own identity — narrower, and never wrong.
 */
function capabilityKey(parser: object): object {
  const ctor = (parser as { constructor?: unknown }).constructor;
  return typeof ctor === 'function' && ctor !== Object ? (ctor as object) : parser;
}

/** Can this parser actually enforce a deadline? `false` means it parses unbounded, as before. */
export function parseBudgetSupported(parser: object): boolean {
  if (deadlineUnsupported.has(capabilityKey(parser))) return false;
  return typeof (parser as { setTimeoutMicros?: unknown }).setTimeoutMicros === 'function';
}

/**
 * Arm (or clear) the deadline, returning whether it actually took. A parser that refuses is
 * recorded and never asked again — see {@link deadlineUnsupported}.
 */
function setDeadline(parser: { setTimeoutMicros?(micros: number): void }, micros: number): boolean {
  try {
    parser.setTimeoutMicros!(micros);
    return true;
  } catch {
    deadlineUnsupported.add(capabilityKey(parser));
    return false;
  }
}

/**
 * Parse `content` under the active per-file budget.
 *
 * Returns the tree on success. Throws {@link ExtractionBudgetExceededError} when the deadline fired,
 * so the existing per-file `try`/`catch` in the builder — which already records a file that
 * contributed nothing — classifies and discloses it without every extractor growing a new return
 * shape.
 *
 * The deadline is re-applied before each parse rather than once at parser construction: these
 * parsers are per-language singletons shared across a whole build (and reused by the watcher
 * across builds), so a budget set once could be left stale by any other caller. Setting it is a
 * single native field write.
 */
export function parseWithBudget<TTree>(parser: BudgetableParser<TTree>, content: string): TTree {
  const budgetMs = extractionBudgetMs();
  // The parse gets the time REMAINING on the file's budget, not the whole of it: the budget bounds
  // the file's extraction, and the parse is only its first phase. With no extraction scope open
  // (query-time callers, and a disabled budget) this is the whole budget, exactly as before.
  // Floored at 1 ms rather than 0, because 0 micros means "no deadline" to the binding — an already
  // exhausted budget must not arm an UNBOUNDED parse.
  const deadlineAt = extractionDeadline();
  const parseBudgetMs = deadlineAt === undefined
    ? budgetMs
    : Math.max(1, deadlineAt - Date.now());
  // Arming can FAIL on a binding whose deadline API is nominally present but unusable. When it
  // does, this parse is unbounded — the honest outcome, and the one that preserves today's
  // behaviour — never a failed file.
  const bounded = budgetMs > 0
    && parseBudgetSupported(parser)
    && setDeadline(parser, parseBudgetMs * 1000);
  const startedAt = Date.now();
  let tree: TTree | null | undefined;
  try {
    recordPerfWork('sourceParses');
    tree = parser.parse(content);
  } finally {
    // Always clear the deadline, including on a throw: leaving it armed would apply this
    // file's remaining budget to the NEXT file on the same singleton parser.
    //
    // A failure to CLEAR must not demote the parser. Arming already succeeded, so the binding
    // demonstrably supports deadlines; demoting here would mean every later expiry of the
    // still-armed deadline came back as a generic "no tree" and got filed as `parse-failure`
    // instead of `budget-exceeded` — a wrong cause on top of a leaked deadline.
    if (bounded) {
      try { parser.setTimeoutMicros!(0); } catch { /* deadline leaked; the reset below still runs */ }
    }
  }
  if (tree === null || tree === undefined) {
    // CRITICAL: a timed-out parse is SUSPENDED, not discarded. tree-sitter keeps the partial state
    // so a caller may resume by calling `parse` again — which means the next file handed to this
    // singleton parser would resume the ABANDONED file's parse instead of starting its own. That
    // silently corrupts every subsequent file in the language (measured: the file after the
    // pathological one produced zero symbols and a spurious parse-health record). Resetting is
    // what makes the bound cost exactly one file.
    parser.reset?.();
    // A bounded parser returns no tree only at the deadline. An UNBOUNDED one returning no tree
    // is a different failure — reported as such, never mislabelled as a budget overrun.
    if (bounded) throw new ExtractionBudgetExceededError(Date.now() - startedAt, budgetMs);
    throw new Error('tree-sitter returned no tree');
  }
  return tree;
}

// ============================================================================
// THE EXTRACTION-WIDE DEADLINE (change: bound-large-literal-extraction)
// ============================================================================

/** One file's active budget. See {@link runWithExtractionBudget}. */
interface ExtractionBudgetScope {
  /** When this file's extraction began — the clock the whole budget is measured against. */
  readonly startedAt: number;
  /** The budget in force, carried so the recorded `budgetMs` is the bound, not the spend. */
  readonly budgetMs: number;
  /** `startedAt + budgetMs`, precomputed so a hot loop can compare without arithmetic. */
  readonly deadlineAt: number;
}

/**
 * Async-local rather than a module variable: extraction is `async`, and one `dispatchFileExtract`
 * may fan out (a script container extracts each embedded lane concurrently). A module variable
 * would leak one file's deadline into whatever ran next on the same thread; an async-local scope
 * is inherited by exactly the work this file's extraction started.
 */
const extractionBudgets = new AsyncLocalStorage<ExtractionBudgetScope>();

/**
 * Run ONE file's extraction under the per-file budget.
 *
 * On return, the elapsed time is checked a final time and an overrun THROWS rather than returning
 * the facts. That final check is the one that makes the documented bound true of the graph: a phase
 * with no cooperative checkpoint of its own cannot be interrupted, but its file is still abandoned
 * and disclosed as `budget-exceeded` instead of being quietly admitted over budget.
 *
 * Discarding facts that were in fact computed is deliberate. The alternative — admit them because
 * they happen to exist — makes the bound unpredictable (a file is in the graph or not depending on
 * where the clock ran out), and leaves a file that costs minutes costing minutes on every re-analysis
 * with nothing in `parse-health.json` naming it.
 *
 * A budget of `0` (`OPENLORE_PARSE_BUDGET_MS=0`) opens no scope at all, so every checkpoint below
 * is inert and the behaviour is the pre-bound one byte for byte. A nested call does NOT restart the
 * clock: the outermost scope owns the file.
 */
export async function runWithExtractionBudget<T>(run: () => Promise<T>): Promise<T> {
  const budgetMs = extractionBudgetMs();
  if (budgetMs <= 0) return run();
  if (extractionBudgets.getStore()) return run();
  const startedAt = Date.now();
  const result = await extractionBudgets.run(
    { startedAt, budgetMs, deadlineAt: startedAt + budgetMs },
    run,
  );
  const elapsedMs = Date.now() - startedAt;
  if (elapsedMs > budgetMs) throw new ExtractionBudgetExceededError(elapsedMs, budgetMs);
  return result;
}

/**
 * The active deadline as an absolute epoch-ms value, or `undefined` when no budget is in force.
 *
 * For a hot loop that must not pay an async-local lookup per iteration: read this ONCE before the
 * loop, then compare `Date.now()` against it periodically and call {@link checkExtractionBudget} to
 * throw. Returning the raw number rather than a callback is what keeps the per-node cost to one
 * numeric comparison.
 */
export function extractionDeadline(): number | undefined {
  return extractionBudgets.getStore()?.deadlineAt;
}

/**
 * A cooperative checkpoint: throw if this file has already spent its budget.
 *
 * Inert — one async-local read and one subtraction — when no budget is in force, which is the case
 * for every query-time caller of the shared walks.
 */
export function checkExtractionBudget(): void {
  const scope = extractionBudgets.getStore();
  if (!scope) return;
  const elapsedMs = Date.now() - scope.startedAt;
  if (elapsedMs > scope.budgetMs) throw new ExtractionBudgetExceededError(elapsedMs, scope.budgetMs);
}
