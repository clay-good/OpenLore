import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { EdgeStore, SCHEMA_VERSION } from './edge-store.js';
import type { CallEdge, FunctionNode, ClassNode } from '../analyzer/call-graph.js';

async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'edge-store-test-'));
}

const edgeAB: CallEdge = {
  callerId:   'src/a.ts::foo',
  calleeId:   'src/b.ts::bar',
  calleeName: 'bar',
  confidence: 'import',
};

const edgeCA: CallEdge = {
  callerId:   'src/c.ts::baz',
  calleeId:   'src/a.ts::foo',
  calleeName: 'foo',
  confidence: 'name_only',
  line:       12,
};

describe('EdgeStore', () => {
  let dir: string;
  let dbPath: string;
  let store: EdgeStore;

  beforeEach(async () => {
    dir = await makeTmpDir();
    dbPath = join(dir, 'call-graph.db');
    store = EdgeStore.open(dbPath);
    store.insertEdges([edgeAB, edgeCA]);
  });

  afterEach(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  describe('incremental-closure hot-path infra (fix-transitive-incremental-staleness)', () => {
    it('indexes edges(callee_name) so consumer lookups are not full scans', () => {
      const raw = new DatabaseSync(dbPath);
      try {
        const idx = raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_callee_name'").get();
        expect(idx).toBeDefined();
        const plan = raw.prepare(
          "EXPLAIN QUERY PLAN SELECT DISTINCT caller_file FROM edges WHERE callee_name='bar' AND confidence='import'",
        ).all() as Array<{ detail: string }>;
        expect(plan.some((p) => /USING INDEX idx_callee_name/.test(p.detail))).toBe(true);
      } finally {
        raw.close();
      }
    });

    it('getNameOnlyConsumers returns the current callee id (for the prune comparison)', () => {
      // edgeCA: src/c.ts::baz -> src/a.ts::foo, confidence name_only, callee_name 'foo'.
      const consumers = store.getNameOnlyConsumers('foo');
      expect(consumers).toEqual([{ file: 'src/c.ts', calleeId: 'src/a.ts::foo' }]);
    });
  });

  /** Write a store at an old SCHEMA_VERSION with one node — a pre-upgrade index. */
  async function makeStaleStore(version: number): Promise<{ d: string; p: string }> {
    const d = await makeTmpDir();
    const p = join(d, 'cg.db');
    const old = new DatabaseSync(p);
    old.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)');
    old.prepare('INSERT INTO schema_version (version) VALUES (?)').run(version);
    old.exec('CREATE TABLE nodes (id TEXT PRIMARY KEY, name TEXT, file_path TEXT, is_external INTEGER NOT NULL DEFAULT 0)');
    old.prepare("INSERT INTO nodes (id, name, file_path) VALUES ('a::foo','foo','a')").run();
    old.close();
    return { d, p };
  }

  describe('schema-bump rebuild on the analyze/write path (wasReset)', () => {
    it('a current-version store reports wasReset === false', () => {
      expect(store.wasReset).toBe(false);
    });

    it('openForAnalyze on a stale-version DB wipes it and reports wasReset === true', async () => {
      const { d, p } = await makeStaleStore(1);
      const es = EdgeStore.openForAnalyze(p);
      try {
        expect(es.wasReset).toBe(true);      // detected the stale version
        expect(es.notReady).toBeNull();      // the write path repopulates — not a read fault
        expect(es.countNodes()).toBe(0);     // and wiped the data (rebuild-on-bump)
      } finally {
        es.close();
        await rm(d, { recursive: true, force: true });
      }
    });

    it('a pre-stableId store (nodes without stable_id) rebuilds and repopulates with stableIds — no migration', async () => {
      // change: add-content-addressed-stable-symbol-ids — AdditiveStableIdentity
      // "Older store loads without migration": the nodes table predating stable_id
      // is dropped on the version bump and repopulated, with stableId persisted.
      const d = await makeTmpDir();
      const p = join(d, 'cg.db');
      const old = new DatabaseSync(p);
      old.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)');
      old.prepare('INSERT INTO schema_version (version) VALUES (7)').run(); // immediately-prior version
      // v7 nodes table: no stable_id column at all.
      old.exec('CREATE TABLE nodes (id TEXT PRIMARY KEY, name TEXT NOT NULL, file_path TEXT NOT NULL, is_external INTEGER NOT NULL DEFAULT 0)');
      old.prepare("INSERT INTO nodes (id, name, file_path) VALUES ('src/a.ts::legacy','legacy','src/a.ts')").run();
      old.close();

      const es = EdgeStore.openForAnalyze(p);
      try {
        expect(es.wasReset).toBe(true);
        expect(es.countNodes()).toBe(0); // legacy row gone, no migration attempted
        // The rebuilt schema accepts and round-trips stable_id.
        const node: FunctionNode = {
          id: 'src/a.ts::foo', name: 'foo', filePath: 'src/a.ts', stableId: 'sid:foo(x: number)',
          isAsync: false, language: 'TypeScript', startIndex: 0, endIndex: 10, fanIn: 0, fanOut: 0,
        };
        es.insertNodes([node]);
        expect(es.getNode('src/a.ts::foo')?.stableId).toBe('sid:foo(x: number)');
        expect(es.getNodeByStableId('sid:foo(x: number)')?.id).toBe('src/a.ts::foo');
      } finally {
        es.close();
        await rm(d, { recursive: true, force: true });
      }
    });
  });

  describe('read paths never destroy the index (harden-index-store-lifecycle)', () => {
    it('open() on a current-version store is healthy (notReady === null)', () => {
      expect(store.notReady).toBeNull();
    });

    it('open() on a stale-version DB reports schema-mismatch and destroys no data (no DROP, no re-stamp)', async () => {
      const { d, p } = await makeStaleStore(1);
      const es = EdgeStore.open(p);
      try {
        expect(es.notReady).not.toBeNull();
        expect(es.notReady?.reason).toBe('schema-mismatch');
        expect(es.notReady?.onDiskVersion).toBe(1);
        expect(es.notReady?.message).toMatch(/openlore analyze/);
        expect(es.wasReset).toBe(false); // a read never wipes
      } finally {
        es.close();
      }
      // The read ran no destructive migration: the stale data row survives and the
      // on-disk schema version is NOT re-stamped to current — so the next analyze
      // still detects the mismatch and rebuilds. (SQLite flips the WAL header bit on
      // any open; that is not data destruction, which is the invariant that matters.)
      const raw = new DatabaseSync(p);
      try {
        expect((raw.prepare('SELECT COUNT(*) c FROM nodes').get() as { c: number }).c).toBe(1);
        expect((raw.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number }).version).toBe(1);
      } finally {
        raw.close();
        await rm(d, { recursive: true, force: true });
      }
    });

    it('a subsequent openForAnalyze still rebuilds the stale store (analyze heals it)', async () => {
      const { d, p } = await makeStaleStore(1);
      // A read left it not-ready…
      const r = EdgeStore.open(p);
      expect(r.notReady?.reason).toBe('schema-mismatch');
      r.close();
      // …and analyze rebuilds it, because the read preserved the mismatch on disk.
      const w = EdgeStore.openForAnalyze(p);
      try {
        expect(w.wasReset).toBe(true);
        expect(w.notReady).toBeNull();
        expect(w.countNodes()).toBe(0);
      } finally {
        w.close();
        await rm(d, { recursive: true, force: true });
      }
    });
  });

  describe('corrupt-store quarantine at open (CorruptGraphStoreQuarantineParity)', () => {
    it('open() quarantines a corrupt DB to *.corrupt-0 and returns not-ready — no crash, no silent empty', async () => {
      const d = await makeTmpDir();
      const p = join(d, 'cg.db');
      // A file that is not a valid SQLite database.
      writeFileSync(p, 'this is not a sqlite database at all — truncated garbage');
      try {
        const es = EdgeStore.open(p);
        expect(es.notReady?.reason).toBe('quarantined');
        expect(es.notReady?.quarantinePath).toBe(`${p}.corrupt-0`);
        expect(es.notReady?.message).toMatch(/openlore analyze/);
        es.close();
        // The corrupt bytes are preserved aside, and NO empty store was recreated at `p`.
        expect(existsSync(`${p}.corrupt-0`)).toBe(true);
        expect(existsSync(p)).toBe(false);
      } finally {
        await rm(d, { recursive: true, force: true });
      }
    });

    it('a second corrupt open takes the next free suffix — no bytes lost', async () => {
      const d = await makeTmpDir();
      const p = join(d, 'cg.db');
      try {
        writeFileSync(p, 'garbage one');
        EdgeStore.open(p).close();          // → cg.db.corrupt-0
        writeFileSync(p, 'garbage two');
        EdgeStore.open(p).close();          // → cg.db.corrupt-1
        expect(existsSync(`${p}.corrupt-0`)).toBe(true);
        expect(existsSync(`${p}.corrupt-1`)).toBe(true);
        expect(readFileSync(`${p}.corrupt-0`, 'utf-8')).toBe('garbage one');
        expect(readFileSync(`${p}.corrupt-1`, 'utf-8')).toBe('garbage two');
      } finally {
        await rm(d, { recursive: true, force: true });
      }
    });

    it('openForAnalyze quarantines a corrupt DB then opens a fresh store to repopulate', async () => {
      const d = await makeTmpDir();
      const p = join(d, 'cg.db');
      writeFileSync(p, 'not a database');
      try {
        const es = EdgeStore.openForAnalyze(p);
        expect(es.notReady).toBeNull();     // analyze gets a usable, empty store to fill
        expect(es.countNodes()).toBe(0);
        es.close();
        expect(existsSync(`${p}.corrupt-0`)).toBe(true); // corrupt bytes preserved aside
      } finally {
        await rm(d, { recursive: true, force: true });
      }
    });
  });

  describe('exists / dbPath helpers', () => {
    it('exists() returns true when DB is present', () => {
      expect(EdgeStore.exists(dir)).toBe(true);
    });

    it('exists() returns false when no DB', async () => {
      const empty = await makeTmpDir();
      try {
        expect(EdgeStore.exists(empty)).toBe(false);
      } finally {
        await rm(empty, { recursive: true, force: true });
      }
    });

    it('dbPath() returns the correct path', () => {
      expect(EdgeStore.dbPath(dir)).toBe(join(dir, 'call-graph.db'));
    });
  });

  describe('getCallerFiles', () => {
    it('returns files that call into calleeFile', () => {
      const callers = store.getCallerFiles('src/b.ts');
      expect(callers).toContain('src/a.ts');
    });

    it('returns empty array when nothing calls the file', () => {
      expect(store.getCallerFiles('src/nonexistent.ts')).toEqual([]);
    });

    it('returns all distinct caller files (no duplicates)', () => {
      const extra: CallEdge = { callerId: 'src/a.ts::foo2', calleeId: 'src/b.ts::bar', calleeName: 'bar', confidence: 'import' };
      store.insertEdges([extra]);
      const callers = store.getCallerFiles('src/b.ts');
      expect(callers).toHaveLength(1);
      expect(callers[0]).toBe('src/a.ts');
    });
  });

  describe('getEdgesForFile', () => {
    it('returns outgoing edges for caller file', () => {
      const { outgoing } = store.getEdgesForFile('src/a.ts');
      expect(outgoing).toHaveLength(1);
      expect(outgoing[0].calleeId).toBe('src/b.ts::bar');
    });

    it('returns incoming edges for callee file', () => {
      const { incoming } = store.getEdgesForFile('src/b.ts');
      expect(incoming).toHaveLength(1);
      expect(incoming[0].callerId).toBe('src/a.ts::foo');
    });

    it('round-trips optional fields (line, confidence)', () => {
      const { outgoing } = store.getEdgesForFile('src/c.ts');
      expect(outgoing[0].line).toBe(12);
      expect(outgoing[0].confidence).toBe('name_only');
    });
  });

  describe('deleteEdgesForFile', () => {
    it('removes edges where file is caller', () => {
      store.deleteEdgesForFile('src/a.ts');
      expect(store.getEdgesForFile('src/a.ts').outgoing).toHaveLength(0);
    });

    it('removes edges where file is callee', () => {
      store.deleteEdgesForFile('src/b.ts');
      expect(store.getEdgesForFile('src/a.ts').outgoing).toHaveLength(0);
    });

    it('does not remove unrelated edges', () => {
      store.deleteEdgesForFile('src/b.ts');
      // edgeCA (c → a) is unrelated to b
      const { outgoing } = store.getEdgesForFile('src/c.ts');
      expect(outgoing).toHaveLength(1);
    });
  });

  describe('deleteOutgoingEdgesForFile', () => {
    it('removes only outgoing edges, leaving incoming intact', () => {
      // src/a.ts has outgoing edge to src/b.ts and incoming from src/c.ts
      store.deleteOutgoingEdgesForFile('src/a.ts');
      expect(store.getEdgesForFile('src/a.ts').outgoing).toHaveLength(0);
      // incoming from c → a should still be present
      expect(store.getEdgesForFile('src/a.ts').incoming).toHaveLength(1);
    });
  });

  describe('insertEdges', () => {
    it('inserts edges that are then queryable', () => {
      const newEdge: CallEdge = { callerId: 'src/d.ts::qux', calleeId: 'src/a.ts::foo', calleeName: 'foo', confidence: 'same_file' };
      store.insertEdges([newEdge]);
      const callers = store.getCallerFiles('src/a.ts');
      expect(callers).toContain('src/d.ts');
    });

    it('round-trips synthesized-edge provenance (confidence + synthesizedBy)', () => {
      const synth: CallEdge = {
        callerId: 'src/x.ts::trigger', calleeId: 'src/x.ts::onMount', calleeName: 'onMount',
        confidence: 'synthesized', kind: 'calls', synthesizedBy: 'event-channel',
      };
      store.insertEdges([synth]);
      const out = store.getCallees('src/x.ts::trigger').find(e => e.calleeId === 'src/x.ts::onMount');
      expect(out?.confidence).toBe('synthesized');
      expect(out?.synthesizedBy).toBe('event-channel');
      // A directly-resolved edge carries no synthesizedBy after the round-trip.
      const direct = store.getCallees('src/c.ts::baz').find(e => e.calleeId === 'src/a.ts::foo');
      expect(direct?.synthesizedBy).toBeUndefined();
    });

    it('stores an identical structural edge only once across retries', () => {
      const duplicate: CallEdge = {
        callerId: 'src/retry.ts::run',
        calleeId: 'src/a.ts::foo',
        calleeName: 'foo',
        confidence: 'import',
        kind: 'calls',
        line: 17,
      };
      store.insertEdges([duplicate, duplicate]);
      store.insertEdges([duplicate]);

      expect(store.getCallees(duplicate.callerId)).toEqual([duplicate]);
    });
  });

  describe('nodes', () => {
    const nodeA: FunctionNode = {
      id: 'src/a.ts::foo', name: 'foo', filePath: 'src/a.ts',
      isAsync: false, language: 'TypeScript', startIndex: 0, endIndex: 10,
      fanIn: 1, fanOut: 2,
    };
    const nodeB: FunctionNode = {
      id: 'src/b.ts::bar', name: 'bar', filePath: 'src/b.ts',
      isAsync: true, language: 'TypeScript', startIndex: 5, endIndex: 20,
      fanIn: 0, fanOut: 0,
    };
    const nodeExternal: FunctionNode = {
      id: 'src/b.ts::baz', name: 'baz', filePath: 'src/b.ts',
      isAsync: false, language: 'TypeScript', startIndex: 0, endIndex: 5,
      fanIn: 0, fanOut: 0, isExternal: true,
    };

    it('insertNodes + getNode round-trips basic fields', () => {
      store.insertNodes([nodeA]);
      const got = store.getNode(nodeA.id);
      expect(got?.name).toBe('foo');
      expect(got?.filePath).toBe('src/a.ts');
      expect(got?.isAsync).toBe(false);
      expect(got?.fanIn).toBe(1);
    });

    it('getNode returns null for unknown id', () => {
      expect(store.getNode('no::such')).toBeNull();
    });

    it('getNodesForFile returns all nodes in file', () => {
      store.insertNodes([nodeA, nodeB]);
      expect(store.getNodesForFile('src/a.ts')).toHaveLength(1);
      expect(store.getNodesForFile('src/b.ts')).toHaveLength(1);
    });

    it('deleteNodesForFile removes only that file', () => {
      store.insertNodes([nodeA, nodeB]);
      store.deleteNodesForFile('src/a.ts');
      expect(store.getNode(nodeA.id)).toBeNull();
      expect(store.getNode(nodeB.id)).not.toBeNull();
    });

    it('insertNodes stamps is_hub and is_entry_point from sets', () => {
      store.insertNodes([nodeA, nodeB], new Set([nodeA.id]), new Set([nodeB.id]));
      const hubs = store.getHubs(10);
      expect(hubs.some(n => n.id === nodeA.id)).toBe(true);
      const entries = store.getEntryPoints(10);
      expect(entries.some(n => n.id === nodeB.id)).toBe(true);
    });

    it('countNodes excludes external nodes', () => {
      store.insertNodes([nodeA, nodeB, nodeExternal]);
      expect(store.countNodes()).toBe(2); // nodeExternal excluded
    });

    it('counts internal nodes meeting a fan-in threshold in one aggregate read', () => {
      const popular = { ...nodeB, fanIn: 2 };
      const externalPopular = { ...nodeExternal, fanIn: 99 };
      store.insertNodes([nodeA, popular, externalPopular]);
      expect(store.countNodesWithMinFanIn(2)).toBe(1);
      expect(store.countNodesWithMinFanIn(3)).toBe(0);
    });

    it('searchNodes finds by name substring', () => {
      store.insertNodes([nodeA, nodeB]);
      const results = store.searchNodes('fo');
      expect(results.some(n => n.id === nodeA.id)).toBe(true);
    });

    it('searchNodes handles IaC resource names with FTS-special chars (spec-17)', () => {
      const iacNode: FunctionNode = {
        id: 'src/app.ts::Bucket:logs', name: 'Bucket:logs', filePath: 'src/app.ts',
        isAsync: false, language: 'Pulumi', startIndex: 0, endIndex: 0, fanIn: 0, fanOut: 0,
      };
      store.insertNodes([iacNode]);
      // ':' would be read as an FTS5 column filter unquoted — must not throw, must match.
      expect(store.searchNodes('Bucket:logs').some(n => n.id === iacNode.id)).toBe(true);
      expect(store.searchNodes('bucket').some(n => n.id === iacNode.id)).toBe(true);
    });

    it('getCallers returns edges where node is callee', () => {
      store.insertNodes([nodeA]);
      const callers = store.getCallers(nodeA.id);
      // edgeCA: src/c.ts::baz → src/a.ts::foo
      expect(callers.some(e => e.callerId === 'src/c.ts::baz')).toBe(true);
    });

    it('getCallees returns edges where node is caller', () => {
      store.insertNodes([nodeA]);
      const callees = store.getCallees(nodeA.id);
      // edgeAB: src/a.ts::foo → src/b.ts::bar
      expect(callees.some(e => e.calleeId === 'src/b.ts::bar')).toBe(true);
    });

    it('clearAll removes all nodes and edges', () => {
      store.insertNodes([nodeA, nodeB]);
      store.clearAll();
      expect(store.getNode(nodeA.id)).toBeNull();
      expect(store.getEdgesForFile('src/a.ts').outgoing).toHaveLength(0);
      expect(store.countNodes()).toBe(0);
    });
  });

  describe('classes', () => {
    const cls: ClassNode = {
      id: 'src/a.ts::Foo', name: 'Foo', filePath: 'src/a.ts',
      language: 'TypeScript', parentClasses: ['Base'], interfaces: ['IFoo'],
      methodIds: ['src/a.ts::Foo::method'], fanIn: 2, fanOut: 3,
    };

    it('insertClasses + getClass round-trips', () => {
      store.insertClasses([cls]);
      const got = store.getClass(cls.id);
      expect(got?.name).toBe('Foo');
      expect(got?.parentClasses).toEqual(['Base']);
      expect(got?.interfaces).toEqual(['IFoo']);
      expect(got?.methodIds).toEqual(['src/a.ts::Foo::method']);
    });

    it('getClassesForFile returns all classes in file', () => {
      store.insertClasses([cls]);
      expect(store.getClassesForFile('src/a.ts')).toHaveLength(1);
      expect(store.getClassesForFile('src/b.ts')).toHaveLength(0);
    });

    it('deleteClassesForFile removes only that file', () => {
      store.insertClasses([cls]);
      store.deleteClassesForFile('src/a.ts');
      expect(store.getClass(cls.id)).toBeNull();
    });
  });

  describe('file hash cache', () => {
    it('returns null when hash not set', () => {
      expect(store.getFileHash('src/a.ts')).toBeNull();
    });

    it('stores and retrieves a hash', () => {
      store.setFileHash('src/a.ts', 'abc123');
      expect(store.getFileHash('src/a.ts')).toBe('abc123');
    });

    it('overwrites an existing hash', () => {
      store.setFileHash('src/a.ts', 'old');
      store.setFileHash('src/a.ts', 'new');
      expect(store.getFileHash('src/a.ts')).toBe('new');
    });
  });

  // ── Pass-1 fact memo (optimize-hash-keyed-analyze) ────────────────────────────
  describe('pass-1 fact memo', () => {
    const row = (p: string, h = 'hash-1', facts = '{"v":1,"n":[],"e":[]}') =>
      ({ filePath: p, contentHash: h, facts });

    // The memo table is created on the ANALYZE path only (a read must never take the write
    // lock — see the read-mode test below), so these exercise an analyze-mode handle.
    beforeEach(() => {
      store.close();
      store = EdgeStore.openForAnalyze(dbPath);
    });

    it('serves a row only on an exact path + content + stamp match', () => {
      store.putPass1Facts([row('src/a.ts')], 'stamp-1');
      expect(store.getPass1Facts('src/a.ts', 'hash-1', 'stamp-1')).toBe('{"v":1,"n":[],"e":[]}');
      expect(store.getPass1Facts('src/a.ts', 'hash-2', 'stamp-1')).toBeUndefined();
      expect(store.getPass1Facts('src/a.ts', 'hash-1', 'stamp-2')).toBeUndefined();
      expect(store.getPass1Facts('src/other.ts', 'hash-1', 'stamp-1')).toBeUndefined();
    });

    it('keeps one row per file — a re-extraction replaces, never accumulates', () => {
      store.putPass1Facts([row('src/a.ts', 'hash-1')], 'stamp-1');
      store.putPass1Facts([row('src/a.ts', 'hash-2')], 'stamp-1');
      expect(store.countPass1Facts()).toBe(1);
      expect(store.getPass1Facts('src/a.ts', 'hash-1', 'stamp-1')).toBeUndefined();
      expect(store.getPass1Facts('src/a.ts', 'hash-2', 'stamp-1')).toBeDefined();
    });

    it('SURVIVES clearAll — it is the memo the rebuild depends on, not graph data', () => {
      store.putPass1Facts([row('src/a.ts')], 'stamp-1');
      store.clearAll();
      expect(store.countNodes()).toBe(0);
      expect(store.getPass1Facts('src/a.ts', 'hash-1', 'stamp-1')).toBeDefined();
    });

    it('prunes exactly the files that left the analyzed set', () => {
      store.putPass1Facts([row('src/a.ts'), row('src/b.ts'), row('src/c.ts')], 'stamp-1');
      expect(store.prunePass1Facts(['src/a.ts', 'src/c.ts'])).toBe(1);
      expect(store.listPass1FactKeys().map(r => r.filePath)).toEqual(['src/a.ts', 'src/c.ts']);
      expect(store.prunePass1Facts(['src/a.ts', 'src/c.ts'])).toBe(0);
    });

    /**
     * A read must never become a writer. Adding a table a previously-built store lacks would
     * make the first read-mode open after an upgrade take SQLite's write lock — so a tool
     * call landing while a rebuild holds that lock would fail with `database is locked` on a
     * path that never needed the lock before.
     */
    it('is NOT created by a read-mode open — reads never take the write lock', () => {
      store.close();
      // A store as a previous OpenLore left it: same schema version, no memo table.
      const raw = new DatabaseSync(dbPath);
      raw.exec('DROP TABLE IF EXISTS pass1_facts');
      raw.close();

      const reader = EdgeStore.open(dbPath);
      try {
        expect(reader.notReady).toBeNull();
        expect(() => reader.countPass1Facts()).toThrow(); // absent, not silently created
      } finally {
        reader.close();
      }
      const check = new DatabaseSync(dbPath);
      const present = check
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pass1_facts'")
        .get();
      check.close();
      expect(present).toBeUndefined();

      // The analyze path is the one that creates it.
      store = EdgeStore.openForAnalyze(dbPath);
      expect(store.countPass1Facts()).toBe(0);
    });

    it('is dropped by a SCHEMA_VERSION bump — the conservative direction', () => {
      store.putPass1Facts([row('src/a.ts')], 'stamp-1');
      store.close();
      const raw = new DatabaseSync(dbPath);
      raw.exec(`UPDATE schema_version SET version = ${SCHEMA_VERSION - 1}`);
      raw.close();

      store = EdgeStore.openForAnalyze(dbPath);
      expect(store.wasReset).toBe(true);
      expect(store.countPass1Facts()).toBe(0);
    });

    it('pruning to an empty analyzed set clears it, and touches nothing else', () => {
      store.putPass1Facts([row('src/a.ts')], 'stamp-1');
      expect(store.prunePass1Facts([])).toBe(1);
      expect(store.countPass1Facts()).toBe(0);
      expect(store.getEdgesForFile('src/a.ts').outgoing.length).toBeGreaterThan(0);
    });
  });

  // ── Provenance (spec-18) ──────────────────────────────────────────────────────
  describe('provenance', () => {
    const rec = {
      filePath: 'src/a.ts',
      lastAuthor: { name: 'Bob', email: 'bob@example.com' },
      lastDate: '2026-02-01T10:00:00Z',
      lastCommit: 'abc1234',
      lastSubject: 'fix: b (#42)',
      recentAuthors: [{ name: 'Bob', email: 'bob@example.com' }, { name: 'Alice', email: 'alice@example.com' }],
      prs: [{ number: 42, title: 'Fix', state: 'merged' }],
    };

    beforeEach(() => store.insertProvenance([rec]));

    it('round-trips a per-file provenance record', () => {
      expect(store.countProvenance()).toBe(1);
      const got = store.getProvenanceForFiles(['src/a.ts']);
      expect(got).toHaveLength(1);
      expect(got[0]).toMatchObject({
        filePath: 'src/a.ts',
        lastAuthor: { name: 'Bob', email: 'bob@example.com' },
        recentAuthors: [{ name: 'Bob' }, { name: 'Alice' }],
        prs: [{ number: 42, title: 'Fix', state: 'merged' }],
      });
    });

    it('matches across relative/absolute path forms', () => {
      expect(store.getProvenanceForFiles(['/abs/project/src/a.ts']).map(r => r.filePath)).toEqual(['src/a.ts']);
    });

    it('returns nothing for unknown files', () => {
      expect(store.getProvenanceForFiles(['src/zzz.ts'])).toEqual([]);
      expect(store.getProvenanceForFiles([])).toEqual([]);
    });

    it('insertProvenance replaces the prior snapshot wholesale', () => {
      store.insertProvenance([{ ...rec, filePath: 'src/b.ts' }]);
      expect(store.countProvenance()).toBe(1);
      expect(store.getProvenanceForFiles(['src/a.ts'])).toEqual([]);
      expect(store.getProvenanceForFiles(['src/b.ts'])).toHaveLength(1);
    });

    it('clearAll wipes provenance too', () => {
      store.clearAll();
      expect(store.countProvenance()).toBe(0);
    });
  });

  // ── Change coupling & volatility (spec-22) ─────────────────────────────────────
  describe('change coupling', () => {
    const result = {
      churn: new Map([['src/a.ts', 4], ['src/b.ts', 4], ['src/c.ts', 1]]),
      coupling: new Map([
        ['src/a.ts', [{ file: 'src/b.ts', support: 4, confidence: 1 }]],
        ['src/b.ts', [{ file: 'src/a.ts', support: 4, confidence: 1 }]],
      ]),
      stats: { commitsScanned: 5, bulkCommitsFiltered: 1, filesTracked: 3 },
    };

    beforeEach(() => store.insertChangeCoupling(result));

    it('persists churn for every tracked file (coupling may be empty)', () => {
      expect(store.countChangeCoupling()).toBe(3);
      const c = store.getChangeCouplingForFiles(['src/c.ts']);
      expect(c[0]).toMatchObject({ filePath: 'src/c.ts', churn: 1, coupledWith: [] });
    });

    it('round-trips coupling for a file', () => {
      const a = store.getChangeCouplingForFiles(['src/a.ts']);
      expect(a[0]).toMatchObject({ filePath: 'src/a.ts', churn: 4, coupledWith: [{ file: 'src/b.ts', support: 4, confidence: 1 }] });
    });

    it('matches across relative/absolute path forms', () => {
      expect(store.getChangeCouplingForFiles(['/abs/proj/src/a.ts']).map(r => r.filePath)).toEqual(['src/a.ts']);
    });

    it('getTopVolatile returns highest-churn files first', () => {
      const top = store.getTopVolatile(2);
      expect(top.map(r => r.churn)).toEqual([4, 4]);
    });

    it('insertChangeCoupling replaces the prior snapshot; clearAll wipes it', () => {
      store.insertChangeCoupling({ churn: new Map([['src/z.ts', 2]]), coupling: new Map(), stats: { commitsScanned: 1, bulkCommitsFiltered: 0, filesTracked: 1 } });
      expect(store.countChangeCoupling()).toBe(1);
      expect(store.getChangeCouplingForFiles(['src/a.ts'])).toEqual([]);
      store.clearAll();
      expect(store.countChangeCoupling()).toBe(0);
    });
  });

  // ── Decision projection (spec-16) ─────────────────────────────────────────────
  describe('decisions', () => {
    const decNode = {
      id: 'decision::c6d1ad07',
      decisionId: 'c6d1ad07',
      kind: 'decision' as const,
      title: 'Use JWTs for stateless auth',
      status: 'verified' as const,
      rationale: 'Avoids a session store',
      consequences: "Tokens can't be revoked early",
      affectedDomains: ['auth'],
      affectedFiles: ['src/a.ts'],
      confidence: 'high' as const,
    };

    beforeEach(() => {
      store.insertDecisions(
        [decNode],
        [{ decisionNodeId: 'decision::c6d1ad07', filePath: 'src/a.ts', kind: 'affects' }],
      );
    });

    it('round-trips a projected decision node', () => {
      const all = store.getAllDecisions();
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({
        id: 'decision::c6d1ad07',
        decisionId: 'c6d1ad07',
        kind: 'decision',
        title: 'Use JWTs for stateless auth',
        affectedDomains: ['auth'],
        affectedFiles: ['src/a.ts'],
      });
      expect(store.countDecisions()).toBe(1);
    });

    it('getDecisionsForFiles joins affects edges to governing decisions', () => {
      // src/a.ts is governed; this is the deterministic graph join, not a code-edge query.
      const govs = store.getDecisionsForFiles(['src/a.ts']);
      expect(govs.map(d => d.decisionId)).toEqual(['c6d1ad07']);
    });

    it('getDecisionsForFiles matches across relative/absolute path forms', () => {
      const govs = store.getDecisionsForFiles(['/abs/project/src/a.ts']);
      expect(govs.map(d => d.decisionId)).toEqual(['c6d1ad07']);
    });

    it('returns nothing for files no decision governs', () => {
      expect(store.getDecisionsForFiles(['src/b.ts'])).toEqual([]);
      expect(store.getDecisionsForFiles([])).toEqual([]);
    });

    it('insertDecisions replaces the prior projection wholesale (idempotent re-project)', () => {
      store.insertDecisions(
        [{ ...decNode, id: 'decision::ffff0000', decisionId: 'ffff0000', affectedFiles: ['src/z.ts'] }],
        [{ decisionNodeId: 'decision::ffff0000', filePath: 'src/z.ts', kind: 'affects' }],
      );
      expect(store.countDecisions()).toBe(1);
      expect(store.getDecisionsForFiles(['src/a.ts'])).toEqual([]);
      expect(store.getDecisionsForFiles(['src/z.ts']).map(d => d.decisionId)).toEqual(['ffff0000']);
    });

    it('clearAll wipes decisions too', () => {
      store.clearAll();
      expect(store.countDecisions()).toBe(0);
      expect(store.getDecisionsForFiles(['src/a.ts'])).toEqual([]);
    });
  });

  describe('attestation reconciliation inputs (add-index-integrity-attestation)', () => {
    const nodeA: FunctionNode = {
      id: 'src/a.ts::foo', name: 'foo', filePath: 'src/a.ts',
      isAsync: false, language: 'TypeScript', startIndex: 0, endIndex: 10, fanIn: 0, fanOut: 0,
    };
    const nodeB: FunctionNode = {
      id: 'src/b.ts::bar', name: 'bar', filePath: 'src/b.ts',
      isAsync: false, language: 'TypeScript', startIndex: 0, endIndex: 10, fanIn: 0, fanOut: 0,
    };
    const nodeExternal: FunctionNode = {
      id: 'ext::baz', name: 'baz', filePath: 'node_modules/x.ts',
      isAsync: false, language: 'TypeScript', startIndex: 0, endIndex: 5, fanIn: 0, fanOut: 0, isExternal: true,
    };
    const cls: ClassNode = {
      id: 'src/a.ts::C', name: 'C', filePath: 'src/a.ts', language: 'TypeScript',
      parentClasses: [], interfaces: [], methodIds: [], fanIn: 0, fanOut: 0, isModule: false,
    };

    it('countFiles counts distinct internal files only (excludes external)', () => {
      store.insertNodes([nodeA, nodeB, nodeExternal]);
      expect(store.countFiles()).toBe(2); // src/a.ts, src/b.ts — not node_modules/x.ts
    });

    it('countEdges and countClasses return row counts', () => {
      // beforeEach already inserted 2 edges (edgeAB, edgeCA).
      expect(store.countEdges()).toBe(2);
      store.insertClasses([cls]);
      expect(store.countClasses()).toBe(1);
    });

    it('getSchemaVersion returns the current store schema version', () => {
      expect(store.getSchemaVersion()).toBe(SCHEMA_VERSION);
    });

    it('checkpoint is a safe no-throw on an open store', () => {
      expect(() => store.checkpoint()).not.toThrow();
      // still usable afterward
      expect(store.countEdges()).toBe(2);
    });
  });
});
