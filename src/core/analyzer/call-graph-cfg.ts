/**
 * Per-function CFG / data-flow overlay helper — extracted from `call-graph.ts`
 * (change: modularize-call-graph-builder; analyzer: StableCallGraphBarrel).
 *
 * `buildCfgFor` wraps `buildFunctionCfg` (./cfg.js) with the body-resolution +
 * fail-soft policy the call-graph builder needs: it descends a declaration wrapper
 * (a `const f = () => {}`, a Python `@decorator`'d def) to the node that actually
 * owns the body, and swallows any CFG-builder surprise so the additive overlay can
 * never drop a function's base node/edge data. File-internal (never on
 * `call-graph.ts`'s public surface); imported back by the builder, so the surface
 * is unchanged.
 */

import { buildFunctionCfg, type FunctionCfg, type CfgNode } from './cfg.js';

/**
 * Build the per-function CFG + reaching-definitions overlay for one function
 * while its parse tree is still live. `fnNode` is the node captured as the
 * function (may be a declaration wrapper, e.g. a `const f = () => {}`
 * lexical_declaration); this resolves to the node that actually owns the body
 * so arrow/function-expression bodies and params are analyzed too. Fail-soft:
 * returns undefined for unsupported languages or any analysis surprise.
 */
export function buildCfgFor(fnNode: CfgNode, language: string): FunctionCfg | undefined {
  // The overlay is strictly additive: a CFG-builder surprise (an unexpected
  // grammar shape, a partially-loaded optional grammar after the tree-sitter
  // deps became optional) must never propagate and drop the function's node/edge
  // data from the call graph — or, in watch mode, roll back the per-file swap.
  // Fail soft to no overlay; the base call graph is unaffected.
  try {
    let target = fnNode;
    if (!fnNode.childForFieldName('body')) {
      // Dig (breadth-first) for the node that actually owns the body: a TS arrow/
      // function-expression assigned to a variable, or — crucially — the inner
      // `function_definition` of a Python `@decorator`'d function, whose captured
      // node is the `decorated_definition` wrapper (no `body` field of its own).
      const stack = [...fnNode.namedChildren];
      while (stack.length) {
        const n = stack.shift()!;
        if (
          (n.type === 'arrow_function' || n.type === 'function_expression' ||
           n.type === 'function' || n.type === 'function_definition') &&
          n.childForFieldName('body')
        ) { target = n; break; }
        stack.push(...n.namedChildren);
      }
    }
    return buildFunctionCfg(target as unknown as CfgNode, language);
  } catch (error) {
    if (process.env.DEBUG) {
      console.debug(`[cfg] overlay skipped for a ${language} function: ${(error as Error).message}`);
    }
    return undefined;
  }
}
