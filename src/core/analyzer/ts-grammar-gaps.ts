/**
 * Parse-only masks for constructs the published TypeScript grammar (tree-sitter-typescript 0.23.2,
 * the latest on npm) cannot parse, so a file that uses them does not fill the graph with ERROR
 * regions. Measured on this repository: 56 of 57 files with parse errors were these constructs.
 *
 * Every mask is LENGTH-PRESERVING and keeps newlines, so each node's offsets, lines and columns
 * match the real file; only the masked span's text differs, and it is never a function or call name:
 *
 *  - `import('x')` in a TYPE position — followed by `.Name` that is not a call (`Map<K, import('a').T[]>`,
 *    `x?: import('a').N`), or after `typeof` — becomes an identifier of the same length (`___…`).
 *    A runtime `import('x')` (awaited, or `.then(…)`) is not touched, so dynamic-import edges stay.
 *  - `using` as a plain variable in an expression (`using === 'a'`, `f(using)`, `${using}`) becomes `usin_`.
 *    Declarations (`using r = …`), calls (`using(…)`), members (`x.using`) and declared names
 *    (`function using`, `const using`) are not touched.
 *  - `export type * from '…'` (TypeScript 5) becomes `export      * from '…'`.
 *
 * change: tolerate-typescript-grammar-gaps
 */
const TYPE_IMPORT_AFTER_TYPEOF = /(?<=\btypeof\s+)import\((['"])[^'"\n]*\1\)/g;
const TYPE_IMPORT_MEMBER = /import\((['"])[^'"\n]*\1\)(?=(?:\.[A-Za-z_$][\w$]*)+(?!\s*\(|[\w$]))/g;
const USING_IN_EXPRESSION = /(?<![\w$.]|\b(?:function|const|let|var|class)\s+)\busing\b(?=\s*(?:===|!==|==|!=|&&|\|\||\?|\)|;|,|\]|\.|\}))/g;
/** TypeScript 5 `export type * from '…'`: the grammar knows `export * from`; `type` becomes spaces. */
const EXPORT_TYPE_STAR = /(?<=\bexport\s+)type(?=\s+\*)/g;

/** True when the text contains a construct {@link maskTypeScriptGrammarGaps} rewrites. */
export function hasTypeScriptGrammarGap(content: string): boolean {
  return content.includes('import(') || content.includes('using') || content.includes('export type');
}

/** The parse-only, length-preserving masked text (see the module comment). */
export function maskTypeScriptGrammarGaps(content: string): string {
  if (!hasTypeScriptGrammarGap(content)) return content;
  return content
    .replace(TYPE_IMPORT_AFTER_TYPEOF, m => '_'.repeat(m.length))
    .replace(TYPE_IMPORT_MEMBER, m => '_'.repeat(m.length))
    .replace(USING_IN_EXPRESSION, 'usin_')
    .replace(EXPORT_TYPE_STAR, m => ' '.repeat(m.length));
}
