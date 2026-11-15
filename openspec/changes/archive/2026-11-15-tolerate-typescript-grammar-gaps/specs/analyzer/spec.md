# Delta for analyzer

## ADDED Requirements

### Requirement: TypeScriptGrammarGapsAreMaskedForParsing

Before parsing TypeScript or TSX, the analyzer SHALL rewrite the constructs the bundled grammar
cannot parse with a length-preserving, parse-only mask: `import('x')` in a type position (before a
non-call `.Name`, or after `typeof`), `using` as a variable in an expression, and `export type *`.
The mask SHALL keep every offset and line break, SHALL NOT touch a runtime `import()`, a `using`
declaration, a call, a member access or a declared name, and no masked text SHALL appear as a node
name, callee name or signature.

#### Scenario: A type-position import no longer leaves an error region

- **GIVEN** a TypeScript file with `new Map<string, import('./a.js').T[]>()`
- **WHEN** it is analyzed
- **THEN** the file has no parse error, and its functions and calls are extracted as in a file without the construct

#### Scenario: A runtime dynamic import is untouched

- **GIVEN** `import('./lazy.js').then(m => m.run())`
- **WHEN** it is analyzed
- **THEN** the parsed text is the original text
