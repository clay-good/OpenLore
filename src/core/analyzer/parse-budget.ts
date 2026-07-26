/**
 * Per-file parse budget (change: fix-analyze-native-abort-and-file-cost-budget).
 *
 * Extraction of one file used to be unbounded in wall-clock time. Measured on a 300 KB file of
 * a repeated unterminated block-comment opener: 84 s inside `parser.parse()` alone, yielding a
 * 100,002-deep tree. A minified bundle or a generated client in an ordinary repository reaches
 * the same path, so this is not only a hostile-input problem.
 *
 * ## Why the bound is in-band, not a timer
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
 * dropped: {@link ParseBudgetExceededError} carries the elapsed time, the caller records the
 * file with reason `budget-exceeded`, and conclusions built over it disclose the boundary. The
 * bound is disabled by setting `OPENLORE_PARSE_BUDGET_MS=0`, which reproduces the previous
 * behavior exactly — the escape hatch for anyone who would rather wait than be told.
 *
 * A binding whose `setTimeoutMicros` is unavailable (older native builds, and the web-tree-sitter
 * WASM lane) simply parses unbounded, as it did before. That is disclosed by
 * {@link parseBudgetSupported} rather than assumed away: an unenforceable budget must not read
 * as an enforced one.
 */

import { PER_FILE_PARSE_BUDGET_MS, PARSE_BUDGET_ENV } from '../../constants.js';

/**
 * Stable prefix on {@link ParseBudgetExceededError}'s message.
 *
 * The message is the ONLY channel that survives an extraction worker: a throw crossing the
 * `worker_threads` boundary is structured-cloned, so its class, prototype and properties are
 * gone by the time the parent sees it. Keying the reason off a message prefix is what makes the
 * pooled and serial lanes classify the same failure identically — an `instanceof` check would
 * behave differently on the two lanes, which is the bug this prefix exists to avoid.
 */
export const PARSE_BUDGET_MESSAGE_PREFIX = 'openlore:parse-budget-exceeded';

/** Thrown when tree-sitter abandoned a parse at the deadline. Carries the bound and what was spent. */
export class ParseBudgetExceededError extends Error {
  readonly elapsedMs: number;
  readonly budgetMs: number;

  constructor(elapsedMs: number, budgetMs: number) {
    super(
      `${PARSE_BUDGET_MESSAGE_PREFIX}: abandoned after ${elapsedMs}ms `
      + `(budget ${budgetMs}ms; raise or disable with ${PARSE_BUDGET_ENV})`,
    );
    this.name = 'ParseBudgetExceededError';
    this.elapsedMs = elapsedMs;
    this.budgetMs = budgetMs;
  }
}

/**
 * Read `message` as a budget-exceeded signal, returning the BUDGET it names.
 *
 * Message-based on purpose — see {@link PARSE_BUDGET_MESSAGE_PREFIX}. Returns `undefined` for
 * any other failure, so an ordinary parse failure is never re-labelled as a budget overrun.
 *
 * The budget rather than the elapsed time, because the caller records it in a persisted artifact
 * that must be byte-identical across re-analyses of a fixed repository state — see
 * `FileParseHealth.budgetMs`.
 */
export function parseBudgetOverrunMs(message: string | undefined): number | undefined {
  if (!message || !message.startsWith(PARSE_BUDGET_MESSAGE_PREFIX)) return undefined;
  const m = /budget (\d+)ms/.exec(message);
  // A marked message with no readable budget is still a budget overrun — falling through to
  // `undefined` would silently re-label it as an ordinary parse failure.
  return m ? Number(m[1]) : parseBudgetMs();
}

/**
 * The active budget in milliseconds, or `0` when disabled.
 *
 * Read per call rather than cached at module load: extraction workers inherit `process.env`, and
 * tests set the override around a single build. A value that is not a finite, non-negative number
 * is ignored in favour of the default — a typo must not silently disable the bound.
 */
export function parseBudgetMs(): number {
  const raw = process.env[PARSE_BUDGET_ENV];
  if (raw === undefined || raw.trim() === '') return PER_FILE_PARSE_BUDGET_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return PER_FILE_PARSE_BUDGET_MS;
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
 * Parsers whose `setTimeoutMicros` EXISTS but does not work.
 *
 * Presence is not capability. `web-tree-sitter@0.25` exposes `setTimeoutMicros` and throws
 * `TypeError: Cannot convert 0 to a BigInt` from inside it — its WASM shim passes a Number where
 * the import demands a BigInt. Left to propagate, arming the deadline made every file in the
 * WASM-grammar languages (Dart, Lua) fail to extract: a bound that silently deleted real work,
 * which is the exact failure mode this change exists to prevent. So the first refusal demotes that
 * parser to unbounded for the rest of the process rather than being paid, and thrown, per file.
 *
 * A `WeakSet` so a parser that is discarded is not kept alive by this record.
 */
const deadlineUnsupported = new WeakSet<object>();

/** Can this parser actually enforce a deadline? `false` means it parses unbounded, as before. */
export function parseBudgetSupported(parser: object): boolean {
  if (deadlineUnsupported.has(parser)) return false;
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
    deadlineUnsupported.add(parser);
    return false;
  }
}

/**
 * Parse `content` under the active per-file budget.
 *
 * Returns the tree on success. Throws {@link ParseBudgetExceededError} when the deadline fired,
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
  const budgetMs = parseBudgetMs();
  // Arming can FAIL on a binding whose deadline API is nominally present but unusable. When it
  // does, this parse is unbounded — the honest outcome, and the one that preserves today's
  // behaviour — never a failed file.
  const bounded = budgetMs > 0
    && parseBudgetSupported(parser)
    && setDeadline(parser, budgetMs * 1000);
  const startedAt = Date.now();
  let tree: TTree | null | undefined;
  try {
    tree = parser.parse(content);
  } finally {
    // Always clear the deadline, including on a throw: leaving it armed would apply this
    // file's remaining budget to the NEXT file on the same singleton parser.
    if (bounded) setDeadline(parser, 0);
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
    if (bounded) throw new ParseBudgetExceededError(Date.now() - startedAt, budgetMs);
    throw new Error('tree-sitter returned no tree');
  }
  return tree;
}
