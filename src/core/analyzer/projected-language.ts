/**
 * The projected (non-code) language tags (change: add-contract-node-projection).
 *
 * Infrastructure resources and interface-contract elements both ride on the code graph's
 * primitives, and both must be kept out of the candidate sets that rank SOURCE CODE. The two
 * exclusions were one predicate (`!isIacLanguage`) while IaC was the only projection; naming the
 * union once stops the next projected language from silently entering those rankings as code.
 */

import { isIacLanguage } from './iac/types.js';
import { isContractLanguage } from './contract/types.js';

/** Whether a node's language is a projected declaration (infrastructure or contract), not code. */
export function isProjectedLanguage(language: string | undefined): boolean {
  return isIacLanguage(language ?? '') || isContractLanguage(language);
}
