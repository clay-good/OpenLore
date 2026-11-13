import { isAbsolute, sep } from 'node:path';
import { CONFIGURATION_MAX_RULES, CONFIGURATION_MAX_STRING } from '../../constants.js';
import type { FilePolicies } from './types.js';

export function repositoryPath(path: string): string {
  return sep === '\\' ? path.replace(/\\/g, '/') : path;
}
export function validPolicyPattern(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= CONFIGURATION_MAX_STRING &&
    !isAbsolute(value) &&
    !/^[a-z]:/i.test(value) &&
    !value.startsWith('!') &&
    !repositoryPath(value).split('/').includes('..') &&
    ![...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  );
}
export function validateFilePolicies(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return ['filePolicies must be an object'];
  if (Object.keys(value).some((k) => k !== 'rules')) return ['Unknown filePolicies field'];
  const rules = (value as FilePolicies).rules;
  if (!Array.isArray(rules) || rules.length > CONFIGURATION_MAX_RULES)
    return ['filePolicies.rules must contain at most 100 rules'];
  const ids = new Set<string>();
  const errors: string[] = [];
  for (const [index, rule] of rules.entries()) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      errors.push(`Invalid rule ${index}`);
      continue;
    }
    if (
      Object.keys(rule).some(
        (k) => !['id', 'pattern', 'lanes', 'reason', 'evidenceRefs'].includes(k)
      )
    )
      errors.push(`Unknown rule field at ${index}`);
    if (typeof rule.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(rule.id) || ids.has(rule.id))
      errors.push(`Invalid or duplicate rule id at ${index}`);
    ids.add(rule.id);
    if (!validPolicyPattern(rule.pattern)) errors.push(`Invalid pattern at ${index}`);
    if (
      typeof rule.reason !== 'string' ||
      !rule.reason.trim() ||
      rule.reason.length > CONFIGURATION_MAX_STRING
    )
      errors.push(`Missing/bounded reason at ${index}`);
    if (
      !rule.lanes ||
      typeof rule.lanes !== 'object' ||
      Array.isArray(rule.lanes) ||
      !Object.keys(rule.lanes).length ||
      Object.entries(rule.lanes).some(
        ([k, v]) => !['index', 'watch', 'embed'].includes(k) || !['include', 'exclude'].includes(v)
      )
    )
      errors.push(`Invalid lanes at ${index}`);
    if (
      rule.evidenceRefs !== undefined &&
      (!Array.isArray(rule.evidenceRefs) ||
        rule.evidenceRefs.length > 16 ||
        rule.evidenceRefs.some((x) => typeof x !== 'string' || x.length > CONFIGURATION_MAX_STRING))
    )
      errors.push(`Invalid evidence references at ${index}`);
  }
  return errors;
}
