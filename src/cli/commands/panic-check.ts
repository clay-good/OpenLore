/**
 * openlore panic-check
 *
 * Reads panic-state.json and outputs a structured JSON decision for the
 * Claude Code PreToolUse hook. Always exits 0 — severity is encoded in
 * the payload, not the exit code, so the hook runtime never sees an error.
 *
 * Designed for minimal startup overhead: imports only node built-ins and
 * constants. Heavy MCP dependencies are never loaded.
 */

import { Command } from 'commander';
import {
  readPanicState,
  recordHookInterventionLocked,
  buildPanicCheckOutput,
  deescalatePanicByWallClock,
  parsePendingToolName,
  isRecoveryTool,
} from '../../core/services/mcp-handlers/panic-response.js';
import { queryGryphSignals, applyGryphDelta } from '../../core/services/mcp-handlers/gryph-bridge.js';
import { readOpenLoreConfig } from '../../core/services/config-manager.js';
import { emit } from '../../core/services/telemetry.js';
import { readStdin } from '../../utils/stdin.js';
import { resolve } from 'node:path';
import { readLiveLedger } from '../../core/services/session-ledger.js';

type HookFormat = 'claude' | 'kilo' | 'codex';

export const panicCheckCommand = new Command('panic-check')
  .description('Check current panic level (PreToolUse hook consumer)')
  // Fail-open invariant: a PreToolUse hook must NEVER surface a non-zero exit to the agent runtime.
  // Commander would exit(1) on an unknown/extra option BEFORE the action's try/catch runs, so we
  // tolerate unknown options and force every parse-layer exit (incl. --help) to 0.
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .exitOverride(() => process.exit(0))
  .option('-d, --directory <path>', 'Project directory', process.cwd())
  .option('-f, --format <format>', 'Hook format: claude|kilo|codex', 'claude')
  .action(async (options: { directory: string; format: string }) => {
    try {
      const dir = options.directory;
      const format = options.format as HookFormat;

      // Policy gate — config is single source of truth
      const cfg = await readOpenLoreConfig(dir);
      const mode = cfg?.panicResponse?.mode ?? 'off';

      if (mode === 'off' || mode === 'observe') {
        // Panic disabled or observe-only: hook passes through silently
        process.exit(0);
      }

      let state = readPanicState(dir);

      // Gryph runtime enrichment (fail-open). queryGryphSignals returns null when the
      // `gryph` binary is absent — the common case — so this is a no-op for users who
      // have not installed it. Query only the window since the last intervention
      // (gryphWindowStart), with a 2-min fallback to avoid replaying hours of history.
      const since = state.gryphWindowStart ?? new Date(Date.now() - 2 * 60 * 1000).toISOString();
      const gryphSignals = queryGryphSignals(since);
      if (gryphSignals) {
        const enrichedTriggers = [...state.triggers];
        const enrichedScore = applyGryphDelta(state.panicScore, gryphSignals, state.panicLevel >= 2, enrichedTriggers);
        if (enrichedScore !== state.panicScore) {
          state = { ...state, panicScore: enrichedScore, triggers: enrichedTriggers };
        }
      }

      const output = buildPanicCheckOutput(state);

      if (output.decision === 'warn') {
        const now = new Date().toISOString();
        // Cross-process atomic increment — concurrent panic-check hooks must not lose increments
        // (the count drives the advisory→directive escalation gate).
        const newCount = recordHookInterventionLocked(
          dir,
          { lastHookInterventionAt: now, gryphWindowStart: now },
          state.interventionCountSinceStable + 1,
        );
        emit(dir, 'panic', {
          event: 'hook_intervention',
          channel: 'pre_tool_use',
          format,
          panic_level: state.panicLevel,
          severity: output.severity,
          directive_mode: newCount >= 3,
          intervention_count: newCount,
          gryph_enriched: gryphSignals !== null,
        });
      }

      // experimental_blocking: emit a block signal at L4 — the runtime decides enforcement.
      // advisory:true is always present: OpenLore recommends, never mandates. Still exits 0.
      //
      // Two escape hatches keep the block from trapping the agent it supervises:
      //  1. The prescribed recovery call (orient + read-only recovery no-ops) is parsed from the
      //     PreToolUse payload and always allowed through — the block message demands orient(),
      //     so blocking orient() would leave no exit but a human config edit.
      //  2. Bounded wall-clock deescalation: an agent working only via Bash/Edit never rewrites the
      //     panic score, so without this the level 4 block is permanent. Passive decay (existing
      //     constants, no new tuning value) settles the level down over its disclosed window, so
      //     even an unparseable payload cannot leave a permanent block.
      if (mode === 'experimental_blocking' && state.panicLevel >= 4) {
        const effective = deescalatePanicByWallClock(state);
        if (effective.panicLevel >= 4) {
          const pendingTool = parsePendingToolName(await readStdin());
          if (!isRecoveryTool(pendingTool)) {
            const blockOutput = { decision: 'block' as const, advisory: true, panicLevel: effective.panicLevel, message: output.message };
            process.stdout.write(JSON.stringify(blockOutput) + '\n');
            process.exit(0);
          }
        }
        // Deescalated below L4, or the pending call is a prescribed recovery tool → fall through
        // to the normal (advisory warn) output; the block is not emitted.
      }

      process.stdout.write(formatOutput(withLedgerFacts(output, dir, format), format) + '\n');
    } catch {
      // fail-open: any error → silent exit 0
    }
    process.exit(0);
  });

/**
 * The live session ledger's facts, as data on the JSON output (change: add-session-structural-ledger):
 * `backgroundChanges[]` and `editOscillation[]`, present only when not empty. Plain-text formats
 * carry the panic message only.
 */
function withLedgerFacts(output: ReturnType<typeof buildPanicCheckOutput>, dir: string, format: HookFormat): ReturnType<typeof buildPanicCheckOutput> {
  if (format !== 'claude' && format !== 'codex') return output;
  const live = readLiveLedger(resolve(dir));
  if (!('ledger' in live)) return output;
  const { backgroundChanges, editOscillation } = live.ledger;
  if (!backgroundChanges.length && !editOscillation.length) return output;
  return { ...output, sessionLedger: { backgroundChanges, editOscillation } } as ReturnType<typeof buildPanicCheckOutput>;
}

function formatOutput(output: ReturnType<typeof buildPanicCheckOutput>, format: HookFormat): string {
  // claude and codex both consume raw JSON — codex uses the same Claude Code hook schema
  if (format === 'claude' || format === 'codex') {
    return JSON.stringify(output);
  }

  // kilo: plain-text message (some runtimes just want a string signal)
  if (output.decision === 'allow') return '';
  return output.message ?? `[PANIC:${output.severity?.toUpperCase() ?? 'WARN'}] Destabilization detected — call orient().`;
}
