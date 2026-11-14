import { stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { safeJoin } from '../../utils/path-confinement.js';
import { readConfiguration, inspectConfiguration } from './inspect.js';
import { observeConfiguration } from './observe.js';
import { claimConfigurationReview, reviewConfigurationWithStore } from './review-store.js';
import { configurationDigest } from './policy.js';
import type { ConfigurationOptions } from './types.js';
import type { ConfigurationReviewResult, ConfigurationReviewSignal } from './review.js';
import {
  CONFIGURATION_REVIEW_INTERVAL_MS,
  CONFIGURATION_MATERIAL_WATCH_DIRECTORIES,
} from '../../constants.js';

const lastReview = new Map<
  string,
  { at: number; metadata: string; paths: string[]; stamps?: Map<string, string> }
>();
/** Explicit opt-in, idle-only, bounded metadata checks; never invokes an agent or applies settings. */
export async function reviewConfigurationOnIdle(
  options: ConfigurationOptions & {
    idle: boolean;
    operationActive: boolean;
    notificationsAuthorized?: boolean;
    canDeliver?: () => boolean;
  }
): Promise<ConfigurationReviewResult | undefined> {
  if (!options.notificationsAuthorized || !options.idle || options.operationActive)
    return undefined;
  const config = await readConfiguration(options);
  if (
    (config.effective.configurationAssistant as { reviewMode?: string } | undefined)?.reviewMode !==
    'notify'
  )
    return undefined;
  const previous = lastReview.get(config.root),
    now = Date.now();
  if (previous && now - previous.at < CONFIGURATION_REVIEW_INTERVAL_MS) return undefined;
  const paths = previous?.paths ?? [
    '',
    'package.json',
    'tsconfig.json',
    'Cargo.toml',
    'pyproject.toml',
    'go.mod',
    '.gitignore',
    '.openlore-ignore',
    '.git/HEAD',
    '.openlore/serve.json',
  ];
  const revisions = await Promise.all(
    paths.slice(0, 256).map(async (path) => {
      try {
        const info = await stat(safeJoin(config.root, path));
        return [path, info.size, info.mtimeMs, info.ctimeMs];
      } catch {
        return [path, 'absent'];
      }
    })
  );
  const stamps = new Map(
    revisions.map((parts) => [String(parts[0]), JSON.stringify(parts.slice(1))])
  );
  const changed = previous?.stamps
    ? [...stamps]
        .filter(([path, value]) => previous.stamps?.get(path) !== value)
        .map(([path]) => path)
    : [];
  const scope =
    changed.length === 1 && changed[0].includes('/') && !changed[0].startsWith('.')
      ? dirname(changed[0])
      : undefined;
  const metadata = configurationDigest({ revision: config.revision, revisions });
  if (previous?.metadata === metadata) {
    previous.at = now;
    return undefined;
  }
  // Reserve the interval before asynchronous work; multiple turns coalesce to one survey.
  if (lastReview.size >= 1000) return undefined;
  lastReview.set(config.root, { at: now, metadata, paths, stamps });
  if (!(await claimConfigurationReview(config.root, metadata, now))) return undefined;
  const inspection = await inspectConfiguration({ ...options, ...(scope ? { scope } : {}) });
  const observed = await (options.observe
    ? options.observe(config.root, options.signal)
    : observeConfiguration(options));
  const signals: ConfigurationReviewSignal[] = [];
  const existing =
    (config.effective.filePolicies as { rules?: Array<{ pattern: string }> } | undefined)?.rules ??
    [];
  const explicitIncludes =
    (config.effective.analysis as { includePatterns?: string[] } | undefined)?.includePatterns ??
    [];
  for (const recommendation of inspection.recommendations) {
    const scope = recommendation.rule.pattern.replace(/\/$/, '');
    if (
      recommendation.basis !== 'declared' ||
      !inspection.excludedDirectories.some((path) => path === scope)
    )
      continue;
    const watched =
      observed.watchedPaths?.filter((path) => path === scope || path.startsWith(scope + '/')) ?? [];
    signals.push({
      kind: 'watched-output',
      scope,
      action: 'Review exclusions for declared output',
      observed: watched.length > 0,
      material: watched.length >= CONFIGURATION_MATERIAL_WATCH_DIRECTORIES,
      actionable: true,
      explicitChoice:
        explicitIncludes.length > 0 ||
        existing.some((rule) => rule.pattern.replace(/\/$/, '') === scope),
    });
  }
  const result = await reviewConfigurationWithStore(inspection, signals, {
    mode: 'notify',
    idle: options.idle,
    operationActive: options.operationActive,
    canDeliver: options.canDeliver,
  });
  lastReview.set(config.root, {
    at: now,
    metadata,
    stamps,
    paths: [
      ...new Set([
        ...paths,
        ...inspection.recommendations.map((item) => item.rule.pattern.replace(/\/$/, '')),
        ...inspection.evidence
          .filter((item) => item.kind === 'manifest' || item.kind === 'ignore')
          .map((item) => item.path),
      ]),
    ].slice(0, 256),
  });
  return result;
}
