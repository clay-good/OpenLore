/**
 * Rust test attributes (change: fix-rust-test-detection).
 *
 * Over-marking is the dangerous direction — marking a production function a test hides it from
 * every code ranking — so the cases that must NOT match are asserted as carefully as the ones
 * that must.
 */
import { describe, it, expect } from 'vitest';
import { hasRustTestAttribute } from './rust-test-attributes.js';

const at = (src: string, name: string): boolean => {
  const lines = src.split('\n');
  const idx = lines.findIndex(l => l.includes(`fn ${name}`));
  if (idx < 0) throw new Error(`no fn ${name} in the fixture`);
  return hasRustTestAttribute(lines, idx + 1);
};

const SRC = `pub fn verify_chain(x: u32) -> u32 { x }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verifies_a_chain() { assert_eq!(verify_chain(1), 1); }

    #[tokio::test]
    async fn verifies_async() {}

    #[rstest]
    #[case(1)]
    fn verifies_cases(x: u32) {}

    #[test]
    #[should_panic]
    fn panics() {}

    /// A helper the tests share. No attribute of its own.
    fn build_fixture() -> u32 { 1 }
}

#[inline]
pub fn not_a_test(y: u32) -> u32 { y }

#[cfg_attr(feature = "x", test)]
fn conditionally_a_test() {}

#[derive(Debug)]
pub struct Latest {}

pub fn attest(z: u32) -> u32 { z }
`;

describe('hasRustTestAttribute', () => {
  it('marks every attributed form of a Rust test', () => {
    expect(at(SRC, 'verifies_a_chain')).toBe(true);
    expect(at(SRC, 'verifies_async')).toBe(true);
    expect(at(SRC, 'verifies_cases')).toBe(true);
    expect(at(SRC, 'panics')).toBe(true);
    expect(at(SRC, 'conditionally_a_test')).toBe(true);
  });

  it('never marks production code, however close to the tests it sits', () => {
    expect(at(SRC, 'verify_chain')).toBe(false);
    expect(at(SRC, 'not_a_test')).toBe(false);
    // `attest` and `Latest` contain "test" as a substring; the attribute match is on a word.
    expect(at(SRC, 'attest')).toBe(false);
  });

  it('leaves an unattributed helper inside a test module in the production set', () => {
    // Under-marking only over-reports; over-marking would HIDE code. The helper keeps its place.
    expect(at(SRC, 'build_fixture')).toBe(false);
  });

  it('stops at the first line of ordinary code above the function', () => {
    const src = '#[test]\nfn earlier() {}\n\nfn later() {}\n';
    expect(at(src, 'earlier')).toBe(true);
    expect(at(src, 'later')).toBe(false);
  });

  it('scans a bounded number of lines', () => {
    const src = '#[test]\n' + '#[allow(dead_code)]\n'.repeat(80) + 'fn far_below() {}\n';
    expect(at(src, 'far_below')).toBe(false);
  });
});

// The whole path, through the real builder: a Rust inline test module must not leave its tests
// in the production graph.
describe('Rust inline tests through the builder', () => {
  const SOURCE = `pub fn sha256_hex(input: &str) -> String { format!("{:x}", input.len()) }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_a_string() { let v = sha256_hex("a"); assert_eq!(v, "1"); }

    fn fixture() -> &'static str { "a" }
}
`;

  it('marks the attributed test and keeps it out of the entry points', async () => {
    const { CallGraphBuilder } = await import('./call-graph.js');
    const result = await new CallGraphBuilder().build([
      { path: 'src/util.rs', content: SOURCE, language: 'Rust' },
    ]);

    const byName = new Map([...result.nodes.values()].map(n => [n.name, n]));
    expect(byName.get('hashes_a_string')?.isTest).toBe(true);
    expect(byName.get('sha256_hex')?.isTest).toBeFalsy();
    expect(result.entryPoints.map(n => n.name)).not.toContain('hashes_a_string');

    // The unattributed helper stays production code: under-marking over-reports, which is the
    // safe direction, and the coverage caveat says so.
    expect(byName.get('fixture')?.isTest).toBeFalsy();
  });
});
