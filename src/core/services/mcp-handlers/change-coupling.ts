/**
 * MCP handler for change-coupling & volatility queries (spec-22).
 *
 * "What changes together with this file?" and "what's the most volatile code?" —
 * answered from the change-coupling snapshot mined from local git history at
 * analyze time. Advisory signals (correlation, not causation); never a rule.
 */

import { validateDirectory, readCachedContext, diagnoseIndexUnservable } from './utils.js';
import { volatilityLevel } from '../../provenance/change-coupling.js';

const SOUNDNESS = {
  posture: 'advisory-signal',
  caveats: [
    'Co-change is CORRELATION, not causation — a signal to check the sibling, not a rule.',
    'Statistical: it needs sufficient history. On a young or shallow repo, treat low counts skeptically.',
    'Bulk commits (formatting sweeps, mass renames, vendored drops) are filtered by a size threshold so they do not manufacture coupling.',
  ],
};

export interface GetChangeCouplingInput {
  directory: string;
  /** A file to query its coupling/volatility. Omit for the most-volatile overview. */
  file?: string;
  /** Cap results (default 20). */
  limit?: number;
}

export async function handleGetChangeCoupling(input: GetChangeCouplingInput): Promise<unknown> {
  const absDir = await validateDirectory(input.directory);
  const ctx = await readCachedContext(absDir);
  if (!ctx) return await diagnoseIndexUnservable(absDir);
  if (!ctx.edgeStore) return { error: 'Call graph index is empty or unavailable — run analyze_codebase to (re)build it (a version upgrade resets the graph index until the next analyze).' };

  if (ctx.edgeStore.countChangeCoupling() === 0) {
    return {
      message: 'No change-coupling data. Either this is not a git repo, history is too shallow, or analyze_codebase predates this feature — re-run analyze_codebase.',
      soundness: SOUNDNESS,
    };
  }

  const limit = Math.max(1, Math.min(input.limit ?? 20, 200));

  if (input.file) {
    const recs = ctx.edgeStore.getChangeCouplingForFiles([input.file]);
    if (recs.length === 0) {
      return { file: input.file, message: 'No change-coupling record for this file (it may have changed too rarely to register).', soundness: SOUNDNESS };
    }
    const r = recs[0];
    return {
      file: r.filePath,
      volatility: { level: volatilityLevel(r.churn), changes: r.churn },
      frequentlyChangesWith: r.coupledWith.slice(0, limit),
      soundness: SOUNDNESS,
    };
  }

  // Overview: most-volatile files + their coupling.
  const top = ctx.edgeStore.getTopVolatile(limit);
  return {
    mostVolatile: top.map(r => ({
      file: r.filePath,
      volatility: { level: volatilityLevel(r.churn), changes: r.churn },
      frequentlyChangesWith: r.coupledWith.slice(0, 5),
    })),
    note: 'Pass a `file` to query its coupling/volatility directly.',
    soundness: SOUNDNESS,
  };
}
