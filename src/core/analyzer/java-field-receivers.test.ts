import { describe, expect, it } from 'vitest';
import { CallGraphBuilder } from './call-graph.js';
import { inferTypesFromSource, inferUnambiguousFileTypes } from './type-inference-engine.js';

/** A Java call through a field resolves by the field's declared type (ROADMAP P0, #724). */
describe('Java calls through fields', () => {
  it('binds an in-repo field type precisely and never fans an external one out by name', async () => {
    const g = await new CallGraphBuilder().build([
      { path: 'src/main/java/app/OrderService.java', language: 'Java', content: 'package app;\n\nimport org.slf4j.Logger;\nimport org.slf4j.LoggerFactory;\nimport java.util.Map;\n\npublic class OrderService {\n    private final Logger log = LoggerFactory.getLogger(OrderService.class);\n    private final Map<String, Integer> cache;\n    private final Repo repo;\n\n    public OrderService(Repo repo, Map<String, Integer> cache) { this.repo = repo; this.cache = cache; }\n\n    public void place(String id) {\n        log.info("placing " + id);\n        cache.get(id);\n        repo.save(id);\n    }\n}\n' },
      { path: 'src/main/java/app/Repo.java', language: 'Java', content: 'package app;\n\npublic class Repo {\n    public void save(String id) { info(id); }\n    public void info(String s) { }\n    public Integer get(String k) { return 0; }\n}\n' },
      { path: 'src/main/java/app/Audit.java', language: 'Java', content: 'package app;\n\npublic class Audit {\n    public void info(String s) { }\n}\n' },
    ]);
    const fromPlace = g.edges.filter(e => e.callerId.endsWith('OrderService.place')).map(e => `${e.calleeId}|${e.synthesizedBy ?? '-'}`).sort();
    expect(fromPlace).toEqual([
      'external::cache.get|-',
      'external::log.info|-',
      'src/main/java/app/Repo.java::Repo.save|cha-declared-type',
    ]);
  });
});

describe('Java declaration inference', () => {
  it('reads generic declarations as their base type', () => {
    expect(inferTypesFromSource('private final Map<String, List<Integer>> cache = new HashMap<>();', 'Java').get('cache')).toBe('Map');
  });
  it('keeps only names declared one way in the file', () => {
    const src = 'class A { private Repo repo; void f() { Audit a = null; } void g() { Logger a; } }';
    expect([...inferUnambiguousFileTypes(src, 'Java')]).toEqual([['repo', 'Repo']]);
    expect(inferUnambiguousFileTypes(src, 'Python').size).toBe(0);
  });
});
