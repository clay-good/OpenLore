/**
 * Unit tests for the pure escape-analysis core (add-footprint-escape-detection).
 * These exercise the deterministic algorithm directly with synthetic modified-symbol
 * lists; the structural-diff integration (computing those symbols from a real diff)
 * is covered in structural-diff.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  analyzeEscape,
  normalizeDeclaredFootprint,
  type ModifiedSymbol,
  type NormalizedFootprint,
} from './footprint-escape.js';

function declared(taskId: string, writes: Array<[string, ('append' | 'modify')?, string?]>, reads: string[] = []): NormalizedFootprint {
  return normalizeDeclaredFootprint({
    taskId,
    writeSet: writes.map(([id, writeMode, filePath]) => ({ id, writeMode, filePath: filePath ?? id.split('::')[0] })),
    readSet: reads,
  });
}

function mod(id: string, editNature: ModifiedSymbol['editNature'], name?: string): ModifiedSymbol {
  return { id, name: name ?? id.split('::')[1] ?? id, filePath: id.split('::')[0], editNature };
}

describe('analyzeEscape — escape set', () => {
  it('a diff within its declared write-set reports an empty escape set', () => {
    const d = declared('t1', [['src/a.ts::foo', 'modify'], ['src/a.ts::bar', 'modify']]);
    const result = analyzeEscape([mod('src/a.ts::foo', 'modifies-existing'), mod('src/a.ts::bar', 'pure-addition')], d, []);
    expect(result.escapes).toEqual([]);
    expect(result.summary.escapes).toBe(0);
  });

  it('an out-of-scope write is flagged out-of-scope', () => {
    const d = declared('t1', [['src/a.ts::foo', 'modify']]);
    const result = analyzeEscape([mod('src/b.ts::other', 'modifies-existing')], d, []);
    expect(result.escapes).toHaveLength(1);
    expect(result.escapes[0]).toMatchObject({ id: 'src/b.ts::other', classification: 'out-of-scope-write' });
  });

  it('modifying a read-set-only symbol is a read-set intrusion', () => {
    const d = declared('t1', [['src/a.ts::foo', 'modify']], ['src/lib.ts::helper']);
    const result = analyzeEscape([mod('src/lib.ts::helper', 'modifies-existing')], d, []);
    expect(result.escapes[0]).toMatchObject({ id: 'src/lib.ts::helper', classification: 'read-set-intrusion' });
  });

  it('a new symbol in a declared file is scope-creep-within-file (lower severity)', () => {
    const d = declared('t1', [['src/a.ts::foo', 'modify', 'src/a.ts']]);
    const result = analyzeEscape([mod('src/a.ts::newHelper', 'added')], d, []);
    expect(result.escapes[0]).toMatchObject({ id: 'src/a.ts::newHelper', classification: 'scope-creep-within-file' });
    // scope-creep findings are severity info, not warn
    const f = result.findings.find(f => f.subject === 'src/a.ts::newHelper');
    expect(f?.severity).toBe('info');
  });

  it('precedence: read-set intrusion outranks scope-creep when both could apply', () => {
    // helper is in a declared write FILE but was only in the read-set → intrusion wins.
    const d = declared('t1', [['src/a.ts::foo', 'modify', 'src/a.ts']], ['src/a.ts::helper']);
    const result = analyzeEscape([mod('src/a.ts::helper', 'modifies-existing')], d, []);
    expect(result.escapes[0].classification).toBe('read-set-intrusion');
  });
});

describe('analyzeEscape — newly-opened conflicts', () => {
  it('an escape landing in a peer write-set opens a new WAW naming the peer', () => {
    const d = declared('t1', [['src/a.ts::foo', 'modify']]);
    const peer = declared('t2', [['src/b.ts::shared', 'modify']]);
    const result = analyzeEscape([mod('src/b.ts::shared', 'modifies-existing')], d, [peer]);
    expect(result.newlyOpenedConflicts).toHaveLength(1);
    expect(result.newlyOpenedConflicts[0]).toMatchObject({
      symbol: 'src/b.ts::shared', peerTaskId: 't2', verdict: 'WAW',
    });
    expect(result.findings.some(f => f.code === 'footprint-escape-new-conflict' && f.subject === 'src/b.ts::shared')).toBe(true);
  });

  it('an escape NOT in any peer write-set opens no conflict', () => {
    const d = declared('t1', [['src/a.ts::foo', 'modify']]);
    const peer = declared('t2', [['src/c.ts::elsewhere', 'modify']]);
    const result = analyzeEscape([mod('src/b.ts::other', 'modifies-existing')], d, [peer]);
    expect(result.newlyOpenedConflicts).toEqual([]);
    expect(result.escapes).toHaveLength(1);
  });

  it('a task never conflicts with itself (peer sharing its id is skipped)', () => {
    const d = declared('t1', [['src/a.ts::foo', 'modify']]);
    const selfPeer = declared('t1', [['src/b.ts::shared', 'modify']]);
    const result = analyzeEscape([mod('src/b.ts::shared', 'modifies-existing')], d, [selfPeer]);
    expect(result.newlyOpenedConflicts).toEqual([]);
  });
});

describe('analyzeEscape — registry collision resolution (back-side of shared-append)', () => {
  it('two disjoint additions to one registry symbol resolve by merge, not a conflict', () => {
    // We append a case to dispatchTool; peer declared an append to the same symbol.
    const d = declared('t1', [['src/dispatch.ts::dispatchTool', 'append']]);
    const peer = declared('t2', [['src/dispatch.ts::dispatchTool', 'append']]);
    const result = analyzeEscape([mod('src/dispatch.ts::dispatchTool', 'pure-addition')], d, [peer]);
    expect(result.registryResolutions).toHaveLength(1);
    expect(result.registryResolutions[0]).toMatchObject({ symbol: 'src/dispatch.ts::dispatchTool', peerTaskId: 't2' });
    expect(result.newlyOpenedConflicts).toEqual([]);
  });

  it('a modification of an existing member is a real WAW even if both declared append', () => {
    // Escape case: symbol is in the peer write-set but NOT in our declared set, and we
    // modified existing code → newly-opened WAW.
    const d = declared('t1', [['src/a.ts::foo', 'modify']]);
    const peer = declared('t2', [['src/dispatch.ts::dispatchTool', 'append']]);
    const result = analyzeEscape([mod('src/dispatch.ts::dispatchTool', 'modifies-existing')], d, [peer]);
    expect(result.registryResolutions).toEqual([]);
    expect(result.newlyOpenedConflicts).toHaveLength(1);
    expect(result.newlyOpenedConflicts[0].verdict).toBe('WAW');
  });

  it('an out-of-scope pure-addition into a peer\'s MODIFY write-set is still a WAW (peer not declared append)', () => {
    const d = declared('t1', [['src/a.ts::foo', 'modify']]);
    const peer = declared('t2', [['src/reg.ts::registry', 'modify']]);
    const result = analyzeEscape([mod('src/reg.ts::registry', 'pure-addition')], d, [peer]);
    expect(result.newlyOpenedConflicts).toHaveLength(1);
    expect(result.registryResolutions).toEqual([]);
  });
});

describe('analyzeEscape — adversarial conflict cases', () => {
  it('a REMOVED symbol that is in a peer write-set is a WAW with deletion-accurate wording', () => {
    const d = declared('t1', [['src/a.ts::foo', 'modify']]);
    const peer = declared('t2', [['src/b.ts::shared', 'modify']]);
    const result = analyzeEscape([mod('src/b.ts::shared', 'removed')], d, [peer]);
    expect(result.newlyOpenedConflicts).toHaveLength(1);
    expect(result.newlyOpenedConflicts[0].verdict).toBe('WAW');
    // the reason must not claim "modifies existing code" for a deletion
    expect(result.newlyOpenedConflicts[0].reason).toMatch(/REMOVES/);
    expect(result.newlyOpenedConflicts[0].reason).not.toMatch(/modifies existing code/);
  });

  it('an escape in TWO peers\' write-sets reports a conflict for each, deterministically ordered', () => {
    const d = declared('t1', [['src/a.ts::foo', 'modify']]);
    const p2 = declared('t2', [['src/shared.ts::s', 'modify']]);
    const p3 = declared('t3', [['src/shared.ts::s', 'modify']]);
    const result = analyzeEscape([mod('src/shared.ts::s', 'modifies-existing')], d, [p3, p2]);
    expect(result.newlyOpenedConflicts.map(c => c.peerTaskId)).toEqual(['t2', 't3']); // sorted, both present
  });

  it('a peer explicitly sharing the declared task id is skipped (never self-conflict)', () => {
    const d = declared('t1', [['src/a.ts::foo', 'modify']]);
    const selfPeer = declared('t1', [['src/b.ts::shared', 'modify']]);
    const result = analyzeEscape([mod('src/b.ts::shared', 'modifies-existing')], d, [selfPeer]);
    expect(result.newlyOpenedConflicts).toEqual([]);
  });

  it('a PLANNED overlap (symbol in both our and the peer\'s declared write-set) is NOT a newly-opened conflict', () => {
    // The plan already knew about this overlap; the back-side check only reports
    // conflicts an ESCAPE newly opens. A planned, modified shared symbol is excluded.
    const d = declared('t1', [['src/shared.ts::s', 'modify']]);
    const peer = declared('t2', [['src/shared.ts::s', 'modify']]);
    const result = analyzeEscape([mod('src/shared.ts::s', 'modifies-existing')], d, [peer]);
    expect(result.newlyOpenedConflicts).toEqual([]); // distinct from a conflict the plan already had
    expect(result.escapes).toEqual([]);              // it was in our declared write-set
    expect(result.registryResolutions).toEqual([]);  // not a clean append on our side
  });
});

describe('analyzeEscape — duplicate-line edit nature is git-consistent (no unsafe false-negative)', () => {
  // editNatureOf lives in structural-diff, but the safety contract is: a real clobber
  // (an existing line's content disappears) must never be reported as a clean append.
  // These exercise the analyzer's reliance on that contract via the editNature it is fed.
  it('a removed/changed line content that disappears is modifies-existing → real WAW, not resolved-by-merge', () => {
    const d = declared('t1', [['src/reg.ts::registry', 'append']]);
    const peer = declared('t2', [['src/reg.ts::registry', 'append']]);
    // Caller (structural-diff) computed modifies-existing because a base line vanished.
    const result = analyzeEscape([mod('src/reg.ts::registry', 'modifies-existing')], d, [peer]);
    expect(result.registryResolutions).toEqual([]);            // NOT downgraded to a merge
    expect(result.misDeclaredAppends).toHaveLength(1);         // declared append, actually modified
  });
});

describe('analyzeEscape — mis-declared append', () => {
  it('flags a symbol declared append whose diff actually modified existing code', () => {
    const d = declared('t1', [['src/reg.ts::registry', 'append']]);
    const result = analyzeEscape([mod('src/reg.ts::registry', 'modifies-existing')], d, []);
    expect(result.misDeclaredAppends).toHaveLength(1);
    expect(result.misDeclaredAppends[0].symbol).toBe('src/reg.ts::registry');
    expect(result.findings.some(f => f.code === 'mis-declared-append')).toBe(true);
    // it is NOT an escape (the symbol was in the declared write-set)
    expect(result.escapes).toEqual([]);
  });

  it('a declared append that stayed a pure addition is not flagged', () => {
    const d = declared('t1', [['src/reg.ts::registry', 'append']]);
    const result = analyzeEscape([mod('src/reg.ts::registry', 'pure-addition')], d, []);
    expect(result.misDeclaredAppends).toEqual([]);
  });
});

describe('analyzeEscape — findings are advisory and well-formed', () => {
  it('every finding carries a registered code and the footprint-escape source', () => {
    const d = declared('t1', [['src/a.ts::foo', 'modify']]);
    const peer = declared('t2', [['src/b.ts::shared', 'modify']]);
    const result = analyzeEscape([mod('src/b.ts::shared', 'modifies-existing')], d, [peer]);
    for (const f of result.findings) {
      expect(['footprint-escape', 'footprint-escape-new-conflict', 'mis-declared-append']).toContain(f.code);
      expect(f.source).toBe('footprint-escape');
      expect(f.subject.length).toBeGreaterThan(0);
      expect(f.message.length).toBeGreaterThan(0);
    }
  });

  it('carries the structural-only disclosure', () => {
    const d = declared('t1', [['src/a.ts::foo', 'modify']]);
    const result = analyzeEscape([], d, []);
    expect(result.disclosure).toMatch(/semantic conflict/i);
  });
});

describe('analyzeEscape — determinism', () => {
  it('produces a byte-identical result regardless of input order', () => {
    const d = declared('t1', [['src/a.ts::foo', 'modify']]);
    const peers = [declared('t2', [['src/b.ts::s1', 'modify']]), declared('t3', [['src/c.ts::s2', 'append']])];
    const mods1: ModifiedSymbol[] = [
      mod('src/b.ts::s1', 'modifies-existing'),
      mod('src/c.ts::s2', 'pure-addition'),
      mod('src/z.ts::zzz', 'added'),
    ];
    const mods2 = [...mods1].reverse();
    const r1 = analyzeEscape(mods1, d, peers);
    const r2 = analyzeEscape(mods2, d, [...peers].reverse());
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  it('de-dups a symbol surfacing twice, keeping modifies-existing over pure-addition', () => {
    const d = declared('t1', []);
    const result = analyzeEscape(
      [mod('src/a.ts::foo', 'pure-addition'), mod('src/a.ts::foo', 'modifies-existing')],
      d,
      [],
    );
    expect(result.escapes).toHaveLength(1);
    expect(result.escapes[0].editNature).toBe('modifies-existing');
  });
});

describe('normalizeDeclaredFootprint — tolerant of malformed input', () => {
  it('drops malformed members and never throws', () => {
    const n = normalizeDeclaredFootprint({
      taskId: 'x',
      writeSet: [{ id: 'ok::a', writeMode: 'append' }, { id: 123 as unknown as string }, {} as never],
      readSet: ['r1', 42 as unknown as string, ''],
    });
    expect([...n.writeModeById.keys()]).toEqual(['ok::a']);
    expect(n.writeModeById.get('ok::a')).toBe('append');
    expect([...n.readIds]).toEqual(['r1']);
  });

  it('defaults writeMode to modify and taskId to the fallback', () => {
    const n = normalizeDeclaredFootprint({ writeSet: [{ id: 'a::b' }] }, 'fallback');
    expect(n.writeModeById.get('a::b')).toBe('modify');
    expect(n.taskId).toBe('fallback');
  });

  it('an empty/undefined footprint yields empty sets', () => {
    const n = normalizeDeclaredFootprint(undefined);
    expect(n.writeModeById.size).toBe(0);
    expect(n.readIds.size).toBe(0);
  });
});
