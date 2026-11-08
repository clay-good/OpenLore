/**
 * Reading a tree-sitter node's children exactly once per node
 * (change: bound-large-literal-extraction).
 *
 * `SyntaxNode.namedChildren` and `SyntaxNode.children` are GETTERS over the native binding, not
 * cached arrays: each access re-marshals the node and unmarshals a brand-new JS object for every
 * child. So the innocuous-looking
 *
 * ```ts
 * for (let i = node.namedChildren.length - 1; i >= 0; i--) stack.push(node.namedChildren[i]);
 * ```
 *
 * materializes k children k+1 times for a node with k children — O(k²) work and O(k²) allocations
 * in one statement. On a generated `demo.pb.go` (a `[]byte{…}` literal of ~4,400 elements) that one
 * shape cost 82 s for an 89 KB file; measured end to end, extraction grew as N^2.5 in the element
 * count. Hoisting the read makes it O(k).
 *
 * This is a DIFFERENT hazard from the `child(i)`-is-O(i) one already guarded elsewhere in the
 * walker family (`WIDE_NODE_CHILDREN`): there the index accessor rescans from the first child; here
 * the array accessor is re-evaluated. Both end in O(k²) on a wide node, and a walk has to avoid
 * both. Reading the array once, through this helper, avoids each of them.
 *
 * The helper also reports how many child nodes it materialized, which is the deterministic measure
 * a linearity test can assert on instead of wall clock.
 */

import { checkExtractionBudget } from './extraction-budget.js';
import { recordPerfWork } from './perf-counters.js';

/**
 * How many nodes pass through before the per-file extraction budget is re-checked.
 *
 * A sampling interval, not state: the checkpoint only has to fire often enough that a runaway walk
 * cannot outlive the budget by much, and reading the async-local budget scope on every node of
 * every tree would be a cost paid by every ordinary file for the benefit of the pathological one.
 * A power of two so the test is a mask.
 */
const BUDGET_CHECK_INTERVAL = 1024;

let sinceBudgetCheck = 0;

/**
 * A node's named children, read with EXACTLY ONE access to the getter.
 *
 * Returns the binding's own array (never copied): callers in this repository read it and push its
 * elements, and copying every node's children on a whole-tree walk is the allocation cost this
 * helper exists to remove.
 */
export function readNamedChildren<T extends { namedChildren: T[] }>(node: T): T[] {
  // A cooperative checkpoint for the per-file extraction budget: every walk routed through here is
  // a whole-tree walk, which is exactly the phase that can run away. Throws past the deadline, so
  // the file is abandoned and disclosed rather than running to completion over budget.
  if (++sinceBudgetCheck >= BUDGET_CHECK_INTERVAL) {
    sinceBudgetCheck = 0;
    checkExtractionBudget();
  }
  const kids = node.namedChildren;
  recordPerfWork('astChildNodesMaterialized', kids.length);
  return kids;
}
