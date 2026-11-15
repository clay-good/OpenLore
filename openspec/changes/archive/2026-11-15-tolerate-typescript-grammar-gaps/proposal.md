# Tolerate the TypeScript grammar's known gaps

## Why

The published TypeScript grammar (tree-sitter-typescript 0.23.2, the latest on npm) cannot parse
`import('x').T` inside generic arguments and parameter types, `typeof import('x')` as a type
argument, `using` as a plain variable, and `export type * from`. On this repository 57 files had
parse errors, all from these constructs: every orient answer carried a "lower bound" warning and
`openlore doctor` warned, and call edges inside the error regions were lost.

## What Changes

Before a TypeScript or TSX parse, a length-preserving, parse-only mask rewrites those constructs
(`src/core/analyzer/ts-grammar-gaps.ts`, applied in `parseWithBudget`). Offsets, lines and columns
are unchanged, and no masked text can become a function or call name. Measured on this repository:
files with parse errors 57 → 0, error regions 111 → 0, functions +8, call edges +87, and no node,
callee or signature contains masked text.
