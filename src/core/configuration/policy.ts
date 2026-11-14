import { repositoryPath, validateFilePolicies } from './validation.js';
export { repositoryPath, validPolicyPattern, validateFilePolicies } from './validation.js';
import { CONFIGURATION_POLICY_VERSION } from '../../constants.js';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import ignoreModule from 'ignore';
import type { ConfigurationLane, FilePolicies, FilePolicyRule } from './types.js';

const ignore =
  (ignoreModule as typeof ignoreModule & { default?: typeof ignoreModule }).default ?? ignoreModule;
/** Canonical JSON for revision/plan identities; no object-prototype assignment. */
export function canonicalConfiguration(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalConfiguration).join(',') + ']';
  return (
    '{' +
    Object.keys(value)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map(
        (k) =>
          JSON.stringify(k) + ':' + canonicalConfiguration((value as Record<string, unknown>)[k])
      )
      .join(',') +
    '}'
  );
}
export function configurationDigest(value: unknown): string {
  return createHash('sha256').update(canonicalConfiguration(value)).digest('hex');
}
/** No repository rule can force an already excluded path open. Trusted legacy includes are resolved first. */
export class FilePolicyResolver {
  readonly revision: string;
  private readonly rules: Array<{ rule: FilePolicyRule; matcher: ReturnType<typeof ignore> }>;
  private readonly protectedMatcher: ReturnType<typeof ignore>;
  constructor(policies?: FilePolicies, protectedPatterns: string[] = []) {
    if (policies && validateFilePolicies(policies).length) throw new Error('Invalid file policy');
    this.rules = (policies?.rules ?? []).map((rule) => ({
      rule,
      matcher: ignore().add(repositoryPath(rule.pattern)),
    }));
    this.protectedMatcher = ignore().add(protectedPatterns.map(repositoryPath));
    this.revision = configurationDigest({
      version: CONFIGURATION_POLICY_VERSION,
      rules: policies?.rules ?? [],
    });
  }
  hasRulesFor(lane: ConfigurationLane): boolean {
    return this.rules.some(
      ({ rule }) => rule.lanes[lane] || (lane === 'embed' && rule.lanes.index)
    );
  }
  revisionFor(lane: ConfigurationLane): string {
    return configurationDigest({
      version: CONFIGURATION_POLICY_VERSION,
      rules: this.rules
        .filter(({ rule }) => rule.lanes[lane] || (lane === 'embed' && rule.lanes.index))
        .map(({ rule }) => ({
          pattern: repositoryPath(rule.pattern),
          decision: rule.lanes[lane],
          ...(lane === 'embed' ? { index: rule.lanes.index } : {}),
        })),
    });
  }
  admitted(
    path: string,
    lane: ConfigurationLane,
    legacyAdmitted: boolean,
    directory = false
  ): boolean {
    const rel = repositoryPath(path);
    if (!rel || rel === '.') return legacyAdmitted;
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('../')) return false;
    const key = directory && !rel.endsWith('/') ? rel + '/' : rel;
    if (this.protectedMatcher.ignores(key) || !legacyAdmitted) return false;
    let admitted: boolean = legacyAdmitted;
    for (const { rule, matcher } of this.rules) {
      if (rule.lanes[lane] && matcher.ignores(key)) admitted = rule.lanes[lane] === 'include';
    }
    if (lane === 'embed' && !this.admitted(path, 'index', legacyAdmitted, directory)) return false;
    return admitted;
  }
  mayIncludeDescendant(path: string): boolean {
    const dir = repositoryPath(path).replace(/\/$/, '');
    return this.rules.some(({ rule }) => {
      if (rule.lanes.index !== 'include') return false;
      const prefix = rule.pattern.replace(/^\//, '').split(/[?*[]/)[0].replace(/\/$/, '');
      return !prefix || prefix === dir || prefix.startsWith(dir + '/');
    });
  }
  matches(rule: FilePolicyRule, path: string): boolean {
    return ignore().add(repositoryPath(rule.pattern)).ignores(repositoryPath(path));
  }
}
