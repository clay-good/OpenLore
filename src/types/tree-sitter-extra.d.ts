// Ambient declarations for spec-08 modules that ship no usable types.
// Dart is loaded via a portable WASM build (@repomix/tree-sitter-wasms) through
// web-tree-sitter, which we access through a minimal structural interface.
declare module 'web-tree-sitter';

// Ambient fallbacks for the optional tree-sitter grammars (package.json
// `optionalDependencies`). These native packages are loaded soft — at runtime
// via loadGrammarSoft()/dynamic import, which already tolerates them being
// absent. Without these declarations, `tsc` (the build) fails with TS2307 on
// any CI run where an optional native dep does not install (e.g. its node-gyp
// build is skipped on the runner), even though the typecheck job — which did
// install it — passes. Declaring the modules here makes the build resolve them
// regardless of install state, matching tree-sitter-cpp.d.ts.
declare module '@tree-sitter-grammars/tree-sitter-lua' {
  const language: object;
  export default language;
}
declare module 'tree-sitter-bash' {
  const language: object;
  export default language;
}
declare module 'tree-sitter-c' {
  const language: object;
  export default language;
}
declare module 'tree-sitter-c-sharp' {
  const language: object;
  export default language;
}
declare module 'tree-sitter-elixir' {
  const language: object;
  export default language;
}
declare module 'tree-sitter-kotlin' {
  const language: object;
  export default language;
}
declare module 'tree-sitter-php' {
  const language: object;
  export default language;
}
declare module 'tree-sitter-scala' {
  const language: object;
  export default language;
}
declare module 'tree-sitter-swift' {
  const language: object;
  export default language;
}
