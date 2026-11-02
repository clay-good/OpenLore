/**
 * Rust test functions, read from the attribute that marks each one
 * (change: fix-rust-test-detection).
 *
 * `isTestFile` is a PATH-only predicate, and Rust's dominant convention is not a path: a test
 * lives in an inline `#[cfg(test)] mod tests` beside the code it tests. On a real Cargo
 * workspace that left 2,496 of 3,363 "entry points" as test functions, `report_coverage_gaps`
 * claiming 96% of the code had no reaching test while 2,759 `#[test]` attributes sat in the
 * source, and `suggest_insertion_points` offering a `#[test]` function as the place to add a
 * feature.
 *
 * The signal used here is the ATTRIBUTE ON THE FUNCTION, not the enclosing module: every form of
 * Rust test — `#[test]`, `#[tokio::test]`, `#[rstest]`, `#[test_case(…)]`, `#[bench]` — attributes
 * each function individually, so no brace matching and no module-range tracking is needed. That
 * matters for soundness: marking a function a test HIDES it from the code rankings, so a
 * mis-detected range would be worse than the gap it closes. A helper inside a `#[cfg(test)] mod`
 * that carries no test attribute of its own stays in the production set — under-marking, which
 * only over-reports, never hides.
 *
 * Reads the lines directly above the function, skipping other attributes, doc comments, ordinary
 * comments and blank lines. Every scan is bounded by {@link MAX_ATTRIBUTE_LINES}.
 */

/** How far above a function the attribute block is followed. */
const MAX_ATTRIBUTE_LINES = 32;

/** The attribute's path, past an optional `cfg_attr(<predicate>,` wrapper: `#[tokio::test]` → `tokio::test`. */
const ATTRIBUTE_PATH = /^#\s*\[\s*(?:cfg_attr\s*\([^)]*,\s*)?([\w:]+)/;

/**
 * Attribute names that mark a test, matched EXACTLY on the last path segment.
 *
 * An exact list, not a substring search: `#[attest]` and a `fn attest` are ordinary code, and
 * marking either a test would hide it from every ranking.
 */
const TEST_ATTRIBUTES = new Set([
  'test', 'bench', 'test_case', 'rstest', 'proptest', 'quickcheck', 'should_panic',
]);

/**
 * Whether the Rust function starting at `startLine` (1-based) carries a test attribute.
 *
 * `lines` is the file split on newlines, passed in so a caller marking many functions in one
 * file splits it once.
 */
export function hasRustTestAttribute(lines: readonly string[], startLine: number): boolean {
  // One line above the signature; `startLine` is 1-based, so index `startLine - 1` is the
  // signature itself.
  for (let i = startLine - 2, scanned = 0; i >= 0 && scanned < MAX_ATTRIBUTE_LINES; i--, scanned++) {
    const line = lines[i]?.trim() ?? '';
    if (line === '') continue;
    if (line.startsWith('//')) continue;
    if (!line.startsWith('#')) return false; // ordinary code: the attribute block has ended
    const path = ATTRIBUTE_PATH.exec(line)?.[1];
    if (path && TEST_ATTRIBUTES.has(path.split('::').pop()!)) return true;
  }
  return false;
}
