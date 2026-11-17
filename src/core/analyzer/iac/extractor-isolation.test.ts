/**
 * One failing ecosystem must not erase the infrastructure graph, and a failure must be named
 * (change: fix-projection-integrity).
 *
 * `classifyYaml` is a heuristic — it tags a file without parsing it — so a file it calls
 * Kubernetes may be anything, including one the YAML parser refuses outright. A single such
 * file used to take every resource, reference and deploy binding of all eleven ecosystems with
 * it, and nothing anywhere said so: `orient` reported no infrastructure (read as "no resource
 * runs a function in scope") and `unresolvedDeployBindings` was absent (read as "every binding
 * resolved").
 */
import { describe, it, expect } from 'vitest';
import { buildIacGraph } from './index.js';

/** Nested aliases past the `yaml` library's own `maxAliasCount` guard, which throws. */
function aliasBomb(): string {
  const lines = ['a: &a ["x","x","x","x","x","x","x","x","x"]'];
  for (let i = 0; i < 10; i++) {
    const prev = i === 0 ? 'a' : `b${i - 1}`;
    lines.push(`b${i}: &b${i} [*${prev},*${prev},*${prev},*${prev},*${prev},*${prev},*${prev},*${prev},*${prev}]`);
  }
  return lines.join('\n') + '\n';
}

const compose = {
  path: 'docker-compose.yml',
  language: 'Docker Compose',
  content: 'services:\n  api:\n    image: node:22\n',
};

describe('buildIacGraph isolates each ecosystem', () => {
  it('keeps the other ecosystems when one extractor throws, and names the failure', () => {
    const failures: string[] = [];
    const graph = buildIacGraph(
      [compose, { path: 'k8s/bomb.yaml', language: 'Kubernetes', content: aliasBomb() }],
      failures,
    );

    // The compose service survives the Kubernetes failure.
    expect(graph.resources.some(r => r.language === 'Docker Compose')).toBe(true);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/^Kubernetes: /);
  });

  it('reports no failures for input every extractor can read', () => {
    const failures: string[] = [];
    const graph = buildIacGraph([compose], failures);
    expect(failures).toEqual([]);
    expect(graph.resources.length).toBeGreaterThan(0);
  });

  it('still never throws, with or without a failure sink', () => {
    expect(() => buildIacGraph([{ path: 'k8s/bomb.yaml', language: 'Kubernetes', content: aliasBomb() }])).not.toThrow();
  });
});
