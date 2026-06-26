/**
 * Shared "is this a source-code symbol we rank?" predicates.
 *
 * Both the structural test-coverage gap report (`coverage-gaps`) and the change
 * significance briefing (`briefing-since`) rank CODE by call-graph significance, so
 * both must scope their candidate set the same way: real source functions only —
 * not external/stdlib leaves, not infrastructure (IaC) resources, and not generated
 * or vendored shims. Keeping the predicate in one place stops the two scopes from
 * drifting apart.
 */

import { isIacLanguage } from '../../analyzer/iac/types.js';
import type { FunctionNode } from '../../analyzer/call-graph.js';

/** A code node we can reason about: not external, not infrastructure (IaC). */
export function isCodeNode(n: FunctionNode): boolean {
  return !n.isExternal && !isIacLanguage(n.language);
}

/**
 * Generated / vendored paths are excluded — a generated binding or a `.d.ts` shim
 * is not a hand-authored change worth ranking. The analyzer already skips most of
 * these at walk time; this is a defensive second pass so a stray generated node
 * never slips into a significance ranking.
 */
export function isExcludedPath(filePath: string): boolean {
  // Prefix a slash so a leading path segment (e.g. "vendor/lib.ts") matches the
  // same "/segment/" tests as a nested one ("src/vendor/lib.ts").
  const p = '/' + filePath.replace(/^\/+/, '');
  return (
    p.endsWith('.d.ts') ||
    p.includes('.generated.') ||
    p.includes('/generated/') ||
    p.includes('/__generated__/') ||
    p.includes('/node_modules/') ||
    p.includes('/vendor/') ||
    p.includes('/vendored/')
  );
}
