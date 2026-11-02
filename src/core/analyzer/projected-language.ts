/**
 * The projected (non-code) language tags (change: add-contract-node-projection).
 *
 * Infrastructure resources and interface-contract elements both ride on the code graph's
 * primitives, and both must be kept out of the candidate sets that rank SOURCE CODE. Naming the
 * union once stops the next projected language from silently entering those rankings as code —
 * which is what happened to infrastructure: the ranking sites never had an IaC exclusion at all,
 * so a Serverless function stanza was served as an entry point of the repository.
 */

import { isIacLanguage } from './iac/types.js';
import { isContractLanguage } from './contract/types.js';
import { isContractEdgeKind } from './contract/project.js';

/** Whether a node's language is a projected declaration (infrastructure or contract), not code. */
export function isProjectedLanguage(language: string | undefined): boolean {
  return isIacLanguage(language ?? '') || isContractLanguage(language);
}

/**
 * Whether an edge kind BINDS a declaration to the code that implements it: the contract
 * bindings plus `deploys_symbol`.
 *
 * None of them is a call, so none may contribute to a function's fan-in or fan-out. A
 * `deploys_symbol` edge was counted, which gave a deployed handler a fan-in of 1 and so removed
 * it from the entry points — leaving a YAML stanza as the only entry point of the repository.
 * The store's `recomputeStructuralMetrics` excludes exactly this set, so both copies of the
 * measurement agree.
 */
export function isDeclarationEdgeKind(kind: string | undefined): boolean {
  return isContractEdgeKind(kind) || kind === 'deploys_symbol' || kind === 'references_schema';
}
