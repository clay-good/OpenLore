/**
 * Interface-contract language tags (change: add-contract-node-projection).
 *
 * A dependency-free leaf, like `iac/types.ts`: the language-support registry, the projector,
 * and every "is this a code node?" predicate import it without pulling in a reader.
 *
 * A contract element is a DECLARATION, not a code unit. Its node rides on the same graph
 * primitives as code (so orient/search_code/get_subgraph/find_path and the SCIP + federation
 * exports see it unchanged), but it is excluded from every candidate set that ranks source code
 * — hubs, entry points, dead code, coverage gaps, change significance — and its edges never
 * change a function's fan-in or fan-out.
 */

/** Schema-format tags a contract node can carry as its `language`. */
export type ContractLanguage = 'OpenAPI' | 'Protobuf' | 'GraphQL';

/** All contract language tags (single source of truth for gating). */
export const CONTRACT_LANGUAGES: readonly ContractLanguage[] = ['OpenAPI', 'Protobuf', 'GraphQL'];

const CONTRACT_LANGUAGE_SET: ReadonlySet<string> = new Set<string>(CONTRACT_LANGUAGES);

/**
 * Whether a GraphQL schema file sits under an explicit FIXTURE path. Such a schema describes a fake
 * service: read as the contract, its `type Query` makes the real root ambiguous and unbinds every
 * resolver. Deliberately narrow — `tests/`, `e2e/` and `test/` often hold a real service's schema —
 * and applied to GraphQL only: protobuf resolves through imports, so a fixture `.proto` shadows
 * nothing and is read as before.
 */
export function isFixtureSchemaPath(path: string): boolean {
  return /(?:^|\/)(?:__tests__|__fixtures__|fixtures?|test-?data|testdata)\//i.test(path) || /\.(?:test|spec)\.(?:graphqls?|gql)$/i.test(path);
}

/** Whether a node's language tag is an interface-contract format. */
export function isContractLanguage(language: string | undefined): boolean {
  return !!language && CONTRACT_LANGUAGE_SET.has(language);
}
