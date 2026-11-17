import { join } from 'node:path';
import {
  verifiedSettingsCoordinationDir,
  withGuardedConfigWrite,
  isGuardedWriteFailure,
} from '../runtime/guarded-config-write.js';
import { confinedAtomicWriteFile, readFileConfinedWithStat } from '../../utils/path-confinement.js';
import { configurationDigest } from './policy.js';
import { CONFIGURATION_REVIEW_INTERVAL_MS } from '../../constants.js';
import {
  dismissConfigurationReview,
  reviewConfiguration,
  type ConfigurationReviewSignal,
  type ConfigurationReviewState,
  type ConfigurationReviewResult,
} from './review.js';
import type { ConfigurationInspection } from './types.js';

async function updateReviewState<T>(
  root: string,
  mutate: (previous: ConfigurationReviewState) => { state: ConfigurationReviewState; result: T }
): Promise<T | { reason: string }> {
  const dir = await verifiedSettingsCoordinationDir();
  const file = join(
    dir,
    'configuration-review-' + configurationDigest(root).slice(0, 24) + '.json'
  );
  return withGuardedConfigWrite(dir, file, async (journal) => {
    let snapshot: Awaited<ReturnType<typeof readFileConfinedWithStat>> | null = null;
    try {
      snapshot = await readFileConfinedWithStat(dir, file, 1024 * 1024, true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const previous = snapshot
      ? (JSON.parse(snapshot.content) as ConfigurationReviewState)
      : { version: 1 as const, root, evidenceRevision: '', conditions: {} };
    if (
      previous.version !== 1 ||
      previous.root !== root ||
      !previous.conditions ||
      typeof previous.conditions !== 'object'
    )
      throw new Error('Invalid private review state');
    const { state, result } = mutate(previous);
    const text = JSON.stringify(state);
    if (Buffer.byteLength(text) > 1024 * 1024)
      throw new Error('Private review state budget reached; manual review is required');
    await confinedAtomicWriteFile(dir, file, text, {
      mode: 0o600,
      expectedIdentity: snapshot?.stat ?? null,
      expectedContent: snapshot?.content,
      recoveryJournalPath: journal,
    });
    return result;
  });
}
/** Reserve bounded reassessment across host processes, before an expensive survey. */
export async function claimConfigurationReview(
  root: string,
  metadataRevision: string,
  now = Date.now()
): Promise<boolean> {
  const result = await updateReviewState(root, (previous) => {
    if (
      previous.lastMetadataRevision === metadataRevision ||
      (previous.lastSurveyAt !== undefined &&
        now - previous.lastSurveyAt < CONFIGURATION_REVIEW_INTERVAL_MS)
    )
      return { state: previous, result: false };
    return {
      state: { ...previous, lastSurveyAt: now, lastMetadataRevision: metadataRevision },
      result: true,
    };
  });
  return !isGuardedWriteFailure(result) && result === true;
}
/** Private state and notification delivery are serialized across Pi/MCP/CLI sessions. */
export async function reviewConfigurationWithStore(
  inspection: ConfigurationInspection,
  signals: readonly ConfigurationReviewSignal[],
  options: {
    mode?: 'manual' | 'notify';
    idle: boolean;
    operationActive: boolean;
    now?: number;
    dismiss?: string;
    snoozedUntil?: number;
    canDeliver?: () => boolean;
  }
): Promise<ConfigurationReviewResult> {
  const result = await updateReviewState(inspection.root, (previous) => {
    if (options.dismiss)
      previous = dismissConfigurationReview(previous, options.dismiss, options.snoozedUntil);
    const reviewed = reviewConfiguration(inspection, signals, {
      ...options,
      idle: options.idle && (options.canDeliver?.() ?? true),
      previous,
      deliveryClaimed: true,
    });
    return { state: reviewed.state, result: reviewed };
  });
  if (isGuardedWriteFailure(result))
    return {
      state: {
        version: 1,
        root: inspection.root,
        evidenceRevision: inspection.evidenceRevision,
        conditions: {},
      },
      diagnostics: ['Shared delivery claim unavailable: ' + result.reason],
    };
  return result;
}
