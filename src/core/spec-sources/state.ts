/**
 * "No spec source" is a state of the repository, not an error and not an empty result
 * (change: spec-framework-neutrality, design section 3). Every surface that depends on a spec
 * corpus says it with this one vocabulary: `reason: "no-spec-source"` and `lookedFor`, the source
 * ids checked.
 *
 * `SPEC_SOURCES_LOOKED_FOR` lists only the sources this version actually detects. Each adapter that
 * lands (Spec Kit, BMAD, ADR folders, …) adds its id here, so "looked for" never names a source
 * that was not checked.
 */
export const SPEC_SOURCES_LOOKED_FOR: readonly string[] = ['openspec'];

export const NO_SPEC_SOURCE = 'no-spec-source' as const;

/** Where a decision lives when there is no OpenSpec corpus to sync it into. */
export const DECISIONS_KEPT_LOCALLY = 'no OpenSpec corpus; decisions are kept in .openlore/decisions/';

/** The human-readable form: `no spec source found (looked for: openspec)`. */
export function noSpecSourceText(): string {
  return `no spec source found (looked for: ${SPEC_SOURCES_LOOKED_FOR.join(', ')})`;
}
