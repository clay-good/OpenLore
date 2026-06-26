import { describe, it, expect } from 'vitest';
import { CallGraphBuilder, extractFileStyle } from './call-graph.js';
import {
  classifyNamingCase,
  rollupLanguage,
  buildStyleFingerprint,
  assembleFromRegions,
  attributeFilesToRegions,
  fileProfile,
  compactIdiomSummary,
  STYLE_FINGERPRINT_LANGUAGES,
  STYLE_EVIDENCE_FLOOR,
  type FileStyleRaw,
} from './style-fingerprint.js';

describe('classifyNamingCase', () => {
  it('classifies only multi-word names; single-word / screaming → null', () => {
    expect(classifyNamingCase('getUserName')).toBe('camelCase');
    expect(classifyNamingCase('UserService')).toBe('PascalCase');
    expect(classifyNamingCase('get_user_name')).toBe('snake_case');
    expect(classifyNamingCase('handle')).toBeNull(); // single lowercase word — no discretion
    expect(classifyNamingCase('MAX_RETRIES')).toBeNull(); // screaming const, not a fn-name style
    expect(classifyNamingCase('')).toBeNull();
  });

  it('a leading/trailing underscore run (privacy/dunder) does not drive the verdict', () => {
    // The privacy prefix is not a naming-CASE choice — strip it, then classify the core.
    expect(classifyNamingCase('_privateHelper')).toBe('camelCase');
    expect(classifyNamingCase('_snake_private')).toBe('snake_case');
    expect(classifyNamingCase('_')).toBeNull(); // bare underscore — NOT snake_case
    expect(classifyNamingCase('__')).toBeNull();
    expect(classifyNamingCase('__init__')).toBeNull(); // dunder → single word `init` → null
    expect(classifyNamingCase('value_')).toBeNull(); // trailing-underscore single word
  });

  it('a name mixing an interior underscore and uppercase is neither convention → null', () => {
    expect(classifyNamingCase('mixed_Case')).toBeNull();
    expect(classifyNamingCase('snake_And_Camel')).toBeNull();
  });

  it('handles non-letter starts and acronyms without crashing or misleading', () => {
    expect(classifyNamingCase('$jquery')).toBeNull(); // starts with non-letter
    expect(classifyNamingCase('2fast')).toBeNull();
    expect(classifyNamingCase('getURLPath')).toBe('camelCase');
    expect(classifyNamingCase('HTTPServer')).toBe('PascalCase');
    expect(classifyNamingCase('a')).toBeNull();
    expect(classifyNamingCase('A')).toBeNull();
  });
});

// A deliberately skewed TypeScript fixture: arrow + const + ternary + await + template + camelCase
// dominant, each well above the evidence floor.
function skewedTs(): string {
  const lines: string[] = [];
  for (let i = 0; i < 20; i++) {
    lines.push(
      `const handlerFn${i} = async () => {\n` +
      `  const localVal${i} = cond ? 1 : 2;\n` +
      `  const msg${i} = \`value \${localVal${i}}\`;\n` +
      `  await doThing${i}();\n` +
      `  return msg${i};\n` +
      `};`,
    );
  }
  return lines.join('\n');
}

describe('tally over the existing AST walk (via CallGraphBuilder.build)', () => {
  it('detects the dominant idiom for each counter with sample sizes', async () => {
    const builder = new CallGraphBuilder();
    const result = await builder.build([{ path: 'skew.ts', content: skewedTs(), language: 'TypeScript' }]);
    const raw = result.styleByFile?.get('skew.ts');
    expect(raw).toBeTruthy();
    expect(raw!.language).toBe('TypeScript');

    const profile = rollupLanguage([raw!], 'TypeScript');
    // functionForm: 20 arrow definitions dominate
    const ff = profile.idioms.functionForm!;
    expect('dominant' in ff && ff.dominant).toBe('arrow');
    expect('samples' in ff && ff.samples).toBeGreaterThanOrEqual(20);
    // binding: all const
    const b = profile.idioms.binding!;
    expect('dominant' in b && b.dominant).toBe('const');
    // conditionalForm: all ternary
    const c = profile.idioms.conditionalForm!;
    expect('dominant' in c && c.dominant).toBe('ternary');
    // asyncForm: all await
    const a = profile.idioms.asyncForm!;
    expect('dominant' in a && a.dominant).toBe('await');
    // stringForm: all template
    const s = profile.idioms.stringForm!;
    expect('dominant' in s && s.dominant).toBe('template');
    // functionNaming: handlerFn## is camelCase
    const n = profile.idioms.functionNaming!;
    expect('dominant' in n && n.dominant).toBe('camelCase');
  });
});

describe('evidence floor', () => {
  it('reports null below the fixed floor', () => {
    const raw: FileStyleRaw = {
      filePath: 'tiny.ts',
      language: 'TypeScript',
      counters: { binding: { const: 3, let: 1 } }, // 4 < floor
      functionsSampled: 2,
    };
    const profile = rollupLanguage([raw]);
    expect(profile.idioms.binding).toEqual({ signal: null, reason: 'below_floor' });
  });

  it('reports a ratio at/above the floor', () => {
    const raw: FileStyleRaw = {
      filePath: 'ok.ts',
      language: 'TypeScript',
      counters: { binding: { const: 18, let: 2 } },
      functionsSampled: 20,
    };
    const profile = rollupLanguage([raw]);
    const b = profile.idioms.binding!;
    expect('dominant' in b && b.dominant).toBe('const');
    expect('ratio' in b && b.ratio).toBe(0.9);
    expect('samples' in b && b.samples).toBe(20);
  });
});

describe('enforcement-awareness', () => {
  it('Go function-naming is enforced → null, not a 1.0 tautology, even with tallies present', () => {
    const raw: FileStyleRaw = {
      filePath: 'main.go',
      language: 'Go',
      counters: { binding: { short: 20, var: 4 }, functionNaming: { PascalCase: 30 } },
      functionsSampled: 30,
    };
    const profile = rollupLanguage([raw]);
    // binding is discretionary → measured
    const b = profile.idioms.binding!;
    expect('dominant' in b && b.dominant).toBe('short');
    // functionNaming is enforced by Go's visibility-by-case / gofmt → null signal
    expect(profile.idioms.functionNaming).toEqual({ signal: null, reason: 'enforced' });
  });
});

describe('region attribution + determinism', () => {
  const rawFiles: FileStyleRaw[] = [
    { filePath: 'a.ts', language: 'TypeScript', counters: { binding: { const: 18, let: 2 } }, functionsSampled: 20 },
    { filePath: 'b.ts', language: 'TypeScript', counters: { binding: { const: 10, let: 10 } }, functionsSampled: 20 },
  ];
  const nodes = [
    { filePath: 'a.ts', communityId: 'c2', communityLabel: 'Beta' },
    { filePath: 'a.ts', communityId: 'c2' },
    { filePath: 'a.ts', communityId: 'c1' },
    { filePath: 'b.ts', communityId: 'c1', communityLabel: 'Alpha' },
  ];

  it('attributes a file to the plurality community', () => {
    const { fileRegions, labels } = attributeFilesToRegions(nodes);
    expect(fileRegions['a.ts']).toBe('c2'); // 2 vs 1
    expect(fileRegions['b.ts']).toBe('c1');
    expect(labels['c2']).toBe('Beta');
  });

  it('builds a byte-identical fingerprint across two runs', () => {
    const f1 = buildStyleFingerprint(rawFiles, nodes);
    const f2 = buildStyleFingerprint(rawFiles, nodes);
    expect(JSON.stringify(f1)).toEqual(JSON.stringify(f2));
    // regions present and sorted
    expect(f1.regions.map(r => r.communityId)).toEqual(['c1', 'c2']);
  });

  it('is byte-identical regardless of input file/node ORDER (fileRegions keys sorted)', () => {
    // Determinism must not depend on enumeration order — file walks can vary, and the watcher
    // rebuilds fileRegions in a different order than a full analyze.
    const a = buildStyleFingerprint(rawFiles, nodes);
    const b = buildStyleFingerprint([...rawFiles].reverse(), [...nodes].reverse());
    expect(JSON.stringify(b)).toEqual(JSON.stringify(a));
    // fileRegions keys are emitted in sorted order.
    expect(Object.keys(b.fileRegions)).toEqual([...Object.keys(b.fileRegions)].sort());
  });
});

describe('single-file profile + compact summary', () => {
  it('rolls a single file up (floor still applies)', () => {
    const raw: FileStyleRaw = {
      filePath: 'x.ts',
      language: 'TypeScript',
      counters: { binding: { const: 30, let: 2 }, conditionalForm: { ternary: 2, if: 1 } },
      functionsSampled: 30,
    };
    const p = fileProfile(raw);
    expect('dominant' in p.idioms.binding! && p.idioms.binding!.dominant).toBe('const');
    expect(p.idioms.conditionalForm).toEqual({ signal: null, reason: 'below_floor' });
    const summary = compactIdiomSummary(p);
    expect(summary.some(s => s.startsWith('binding=const'))).toBe(true);
  });
});

describe('extractFileStyle (single-file tally, used by the watcher)', () => {
  it('Go: measures binding := vs var, enforces naming → not tallied', async () => {
    const style = await extractFileStyle({
      path: 'main.go',
      language: 'Go',
      content: 'package m\nfunc Foo() { x := 1; y := 2; var z int = 3 }',
    });
    expect(style).toBeTruthy();
    expect(style!.language).toBe('Go');
    expect(style!.counters.binding).toEqual({ short: 2, var: 1 });
  });

  it('Python: ternary (conditional_expression) and snake_case naming via the real extractor', async () => {
    const style = await extractFileStyle({
      path: 'a.py',
      language: 'Python',
      content: 'def get_user_name():\n    return 1 if c else 2\ndef do_work():\n    x = 9 if d else 0\n    return x',
    });
    expect(style).toBeTruthy();
    expect(style!.language).toBe('Python');
    expect(style!.counters.conditionalForm).toEqual({ ternary: 2 });
    expect(style!.counters.functionNaming).toEqual({ snake_case: 2 });
  });

  it('an unsupported language yields undefined (fail-soft)', async () => {
    const style = await extractFileStyle({ path: 'x.rs', language: 'Rust', content: 'fn main() {}' });
    expect(style).toBeUndefined();
  });
});

describe('compactIdiomSummary (used by orient regionStyle)', () => {
  const profile = {
    language: 'TypeScript',
    functionsSampled: 100,
    idioms: {
      binding: { dominant: 'const', ratio: 0.95, samples: 200, options: { const: 190, let: 10 } },
      asyncForm: { dominant: 'await', ratio: 0.99, samples: 100, options: { await: 99, then: 1 } },
      conditionalForm: { dominant: 'if', ratio: 0.6, samples: 50, options: { if: 30, ternary: 20 } },
      functionForm: { dominant: 'arrow', ratio: 0.7, samples: 80, options: { arrow: 56, declaration: 24 } },
      stringForm: { dominant: 'template', ratio: 0.5, samples: 40, options: { template: 20, concat: 20 } },
      functionNaming: { signal: null as null, reason: 'below_floor' as const },
    },
  };

  it('returns measured idioms only, sorted by ratio desc, capped at the limit, omitting nulls', () => {
    const out = compactIdiomSummary(profile, 3);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe('asyncForm=await (0.99)'); // highest ratio first
    expect(out[1]).toBe('binding=const (0.95)');
    expect(out[2]).toBe('functionForm=arrow (0.7)');
    expect(out.every(s => !s.includes('functionNaming'))).toBe(true); // null omitted
  });

  it('an all-null profile yields an empty summary (orient then omits regionStyle)', () => {
    const allNull = { language: 'Go', functionsSampled: 2, idioms: { binding: { signal: null as null, reason: 'below_floor' as const } } };
    expect(compactIdiomSummary(allNull)).toEqual([]);
  });
});

describe('attributeFilesToRegions tie-break', () => {
  it('an equal split between two communities resolves to the smallest community id (deterministic)', () => {
    const nodes = [
      { filePath: 'x.ts', communityId: 'cB' },
      { filePath: 'x.ts', communityId: 'cA' }, // 1 vs 1 — tie
    ];
    const { fileRegions } = attributeFilesToRegions(nodes);
    expect(fileRegions['x.ts']).toBe('cA'); // lexicographically smallest wins the tie
  });
});

describe('assembleFromRegions (incremental re-roll, used by the watcher)', () => {
  it('reuses a stored file→region map and prunes deleted files', () => {
    const files: FileStyleRaw[] = [
      { filePath: 'a.ts', language: 'TypeScript', counters: { binding: { const: 18, let: 2 } }, functionsSampled: 20 },
      { filePath: 'b.ts', language: 'TypeScript', counters: { binding: { const: 4, let: 16 } }, functionsSampled: 20 },
    ];
    const fileRegions = { 'a.ts': 'r1', 'b.ts': 'r1', 'gone.ts': 'r2' };
    const labels = { r1: 'Alpha', r2: 'Gone' };
    const fp = assembleFromRegions(files, fileRegions, labels);
    // r2 had only a now-absent file → pruned from both fileRegions and regions.
    expect(fp.fileRegions).toEqual({ 'a.ts': 'r1', 'b.ts': 'r1' });
    expect(fp.regions.map(r => r.communityId)).toEqual(['r1']);
    expect(fp.regions[0].label).toBe('Alpha');
  });
});

describe('registry source set', () => {
  it('declares the languages with a style fingerprint', () => {
    expect([...STYLE_FINGERPRINT_LANGUAGES].sort()).toEqual(['Go', 'JavaScript', 'Python', 'TypeScript']);
    expect(STYLE_EVIDENCE_FLOOR).toBe(12);
  });
});
