/**
 * The single canonical file-extension → language detector (change:
 * fix-language-detection-single-source).
 *
 * This is the ONE place the analyzer decides "what language is this file?" from a path.
 * Every component that maps a file path to a language — signature extraction, AST-aware
 * chunking, skeleton reduction, route parsing, and any future consumer — resolves through
 * {@link detectLanguage} here. A rival `detectLanguage` definition or extension→language
 * literal map anywhere else in the tree is a silent re-divergence (the exact defect this
 * consolidation closes) and fails the singularity guard in `language-support.test.ts`.
 *
 * It lives in this dedicated, dependency-free leaf module (not directly inside
 * `language-support.ts`) so it can be imported by both the signature extractor and the
 * registry without a module cycle — `language-support.ts` derives its capability matrix
 * eagerly from `signature-extractor.ts`'s `SIGNATURE_LANGUAGES`, so the extractor cannot
 * import the registry back. The registry re-exports this function as its public surface,
 * so callers may import it from either module; both resolve to this one definition.
 *
 * Deterministic, no LLM, no I/O.
 */

/**
 * The canonical file-extension → language map. Keys are the lowercased extension WITHOUT
 * the leading dot. (Terraform and Bicep are detected by suffix rather than a plain
 * final-segment extension — `*.tf.json` and the like — so they are handled in
 * {@link detectLanguage} directly, not here.) The `.h` header defaults to C++ (the superset
 * that parses C headers acceptably); a project-aware C-vs-C++ decision is a separate
 * concern — see `resolveHeaderLanguage` in `signature-extractor.ts`.
 */
export const EXTENSION_TO_LANGUAGE: Readonly<Record<string, string>> = {
  py: 'Python',
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript',
  js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  go: 'Go',
  rs: 'Rust',
  rb: 'Ruby',
  java: 'Java',
  kt: 'Kotlin', kts: 'Kotlin',
  php: 'PHP', phtml: 'PHP',
  cs: 'C#',
  cpp: 'C++', cc: 'C++', cxx: 'C++', h: 'C++', hpp: 'C++',
  c: 'C',
  swift: 'Swift',
  scala: 'Scala', sc: 'Scala',
  dart: 'Dart',
  lua: 'Lua',
  ex: 'Elixir', exs: 'Elixir',
  sh: 'Bash', bash: 'Bash',
  vue: 'Vue', svelte: 'Svelte', astro: 'Astro',
};

/**
 * Resolve a file path to its analyzer language, or the honest `'unknown'` fallback for an
 * extension the canonical map does not know (never a guessed language).
 */
export function detectLanguage(filePath: string): string {
  const lower = filePath.toLowerCase();
  // Terraform is unambiguous by extension (incl. the *.tf.json variant).
  if (lower.endsWith('.tf') || lower.endsWith('.tfvars') || lower.endsWith('.tf.json')) {
    return 'Terraform';
  }
  // Bicep is unambiguous by extension (Azure IaC DSL).
  if (lower.endsWith('.bicep')) {
    return 'Bicep';
  }
  const ext = lower.split('.').pop() ?? '';
  return EXTENSION_TO_LANGUAGE[ext] ?? 'unknown';
}

/**
 * Whether a JavaScript/TypeScript-family file needs tree-sitter-typescript's TSX grammar.
 * Keep this path decision beside the canonical extension map so parser consumers cannot drift.
 */
export function usesTsxGrammar(filePath?: string): boolean {
  if (!filePath) return false;
  const lower = filePath.toLowerCase();
  return lower.endsWith('.tsx') || lower.endsWith('.jsx');
}
