/**
 * Spec 25 Phase D — agent-eval core (the basis for `openlore prove`).
 * Deterministic parts only; no real agent is ever invoked.
 */
import { describe, it, expect } from 'vitest';
import { parseAgentJson, summarize, median, type Metrics } from './measure.js';
import { deriveTasks, measureProveEligibility, scoreAnswer, type GraphFact } from './tasks.js';
import {
  computeScorecard, verdict, renderScorecard,
  serializeScorecard, renderScorecardMarkdown, scorecardBadgeUrl, money,
  type Scorecard, type ScorecardMeta,
} from './scorecard.js';
import { estimateCells, answerBearingFiles, DEFAULT_ESTIMATE_ASSUMPTIONS } from './estimate.js';

describe('parseAgentJson', () => {
  it('extracts fresh/cached/cost/turns from a claude -p json blob', () => {
    const raw = JSON.stringify({
      result: 'the answer is foo',
      total_cost_usd: 0.123,
      num_turns: 9,
      duration_ms: 4200,
      usage: { input_tokens: 1000, cache_creation_input_tokens: 500, cache_read_input_tokens: 8000, output_tokens: 300 },
    });
    const m = parseAgentJson(raw);
    expect(m.freshInputTokens).toBe(1500); // input + cache_creation
    expect(m.cacheReadTokens).toBe(8000);
    expect(m.costUsd).toBe(0.123);
    expect(m.numTurns).toBe(9);
    expect(m.answer).toBe('the answer is foo');
  });

  it('tolerates a missing usage block', () => {
    const m = parseAgentJson(JSON.stringify({ result: 'x' }));
    expect(m.freshInputTokens).toBe(0);
    expect(m.costUsd).toBe(0);
  });

  it('coerces non-numeric agent fields to 0 (no NaN/Infinity leak into the scorecard)', () => {
    const m = parseAgentJson(JSON.stringify({
      result: 'x', total_cost_usd: 'unknown', num_turns: null,
      usage: { input_tokens: 'oops', cache_read_input_tokens: 'NaN' },
    }));
    expect(m.costUsd).toBe(0);
    expect(m.numTurns).toBe(0);
    expect(m.freshInputTokens).toBe(0);
    expect(Number.isFinite(m.costUsd)).toBe(true);
  });
});

describe('money() rounding + finite-guard', () => {
  it('rounds to 4 decimals (sub-cent), stripping float noise', () => {
    expect(money(0.057999999999999996)).toBe(0.058);
    expect(money(0.0153)).toBe(0.0153);
  });
  it('coerces a non-finite value to 0 (never serializes as null)', () => {
    expect(money(NaN)).toBe(0);
    expect(money(Infinity)).toBe(0);
    expect(money(-Infinity)).toBe(0);
  });
});

describe('median + summarize', () => {
  it('median handles even and odd counts', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBe(0);
  });
  it('summarize medians the cells and computes correctRate', () => {
    const runs: Metrics[] = [
      { freshInputTokens: 100, cacheReadTokens: 0, outputTokens: 10, costUsd: 0.1, numTurns: 4, durationMs: 1000, answer: 'a', correct: true },
      { freshInputTokens: 200, cacheReadTokens: 0, outputTokens: 10, costUsd: 0.3, numTurns: 6, durationMs: 2000, answer: 'b', correct: false },
    ];
    const cell = summarize(runs);
    expect(cell.costUsd).toBeCloseTo(0.2);
    expect(cell.numTurns).toBe(5);
    expect(cell.correctRate).toBe(0.5);
    expect(cell.runs).toBe(2);
  });
});

describe('deriveTasks', () => {
  const facts: GraphFact[] = [
    { name: 'validateDirectory', filePath: 'src/utils.ts', callerNames: ['c1', 'c2', 'c3'], calleeNames: [], isEntryPoint: false },
    { name: 'leaf', filePath: 'b.ts', callerNames: ['c1'], calleeNames: [], isEntryPoint: false },
    { name: 'startMcpServer', filePath: 'src/mcp.ts', callerNames: [], calleeNames: ['validateDirectory', 'leaf'], isEntryPoint: true },
  ];

  it('derives a locate task oracled by the file path/stem (robust, unambiguous)', () => {
    const locate = deriveTasks(facts).find(t => t.id === 'locate')!;
    expect(locate.prompt).toContain('validateDirectory');
    expect(locate.mustIncludeAny).toContain('src/utils.ts');
    expect(locate.mustIncludeAny).toContain('utils'); // file stem
  });

  it('does NOT emit an ambiguous "most callers" task', () => {
    expect(deriveTasks(facts).find(t => t.id === 'hub')).toBeUndefined();
  });

  it('derives a caller task oracled by any real caller', () => {
    const caller = deriveTasks(facts).find(t => t.id === 'caller')!;
    expect(caller.mustIncludeAny).toEqual(['c1', 'c2', 'c3']);
  });

  it('derives a callee task from a distinctive high-fan-out function', () => {
    const callee = deriveTasks(facts).find(t => t.id === 'callee')!;
    expect(callee.prompt).toContain('startMcpServer');
    expect(callee.mustIncludeAny).toEqual(['validateDirectory', 'leaf']);
  });

  it('prefers a distinctively-named hub over a generic one for an unambiguous oracle', () => {
    const f: GraphFact[] = [
      { name: 'run', filePath: 'a.ts', callerNames: ['x', 'y', 'z', 'w'], calleeNames: [], isEntryPoint: false },
      { name: 'readOpenLoreConfig', filePath: 'src/config.ts', callerNames: ['x', 'y'], calleeNames: [], isEntryPoint: false },
    ];
    const locate = deriveTasks(f).find(t => t.id === 'locate')!;
    expect(locate.prompt).toContain('readOpenLoreConfig'); // distinctive, not the generic `run`
  });

  it('is deterministic (same facts → same tasks)', () => {
    expect(deriveTasks(facts)).toEqual(deriveTasks(facts));
  });

  it('returns [] for a graph too sparse to oracle', () => {
    expect(deriveTasks([{ name: 'x', filePath: 'x.ts', callerNames: [], calleeNames: [], isEntryPoint: false }])).toEqual([]);
  });
});

describe('measureProveEligibility', () => {
  it('reports the measured and required values for sparse and dense graphs', () => {
    const sparse: GraphFact[] = [
      { name: 'leaf', filePath: 'leaf.ts', callerNames: ['one'], calleeNames: [], isEntryPoint: false },
    ];
    expect(measureProveEligibility(sparse)).toEqual({
      eligibleFunctions: 0,
      requiredEligibleFunctions: 1,
      minCallers: 2,
      eligible: false,
    });

    const dense: GraphFact[] = [
      { name: 'sharedTarget', filePath: 'target.ts', callerNames: ['one', 'two'], calleeNames: [], isEntryPoint: false },
    ];
    expect(measureProveEligibility(dense).eligible).toBe(true);
  });
});

describe('scoreAnswer', () => {
  const task = { id: 'caller', prompt: '', mustIncludeAny: ['fooBar', 'bazQux'], probes: '' };
  it('is correct when the answer contains any oracle substring (case-insensitive)', () => {
    expect(scoreAnswer(task, 'I think FOOBAR calls it')).toBe(true);
    expect(scoreAnswer(task, 'probably bazqux')).toBe(true);
  });
  it('is incorrect when no oracle substring is present', () => {
    expect(scoreAnswer(task, 'no idea, maybe widget')).toBe(false);
  });
});

describe('scorecard verdict + render', () => {
  const cell = (cost: number, turns: number, correct: number) => ({
    costUsd: cost, freshInputTokens: 1000, cacheReadTokens: 0, numTurns: turns, durationMs: 1000, correctRate: correct, runs: 4,
  });

  it('"helps" when cost AND round-trips drop ≥5% at equal correctness', () => {
    const sc = computeScorecard(cell(0.20, 20, 1), cell(0.16, 14, 1));
    expect(sc.costDeltaPct).toBe(-20);
    expect(sc.turnsDeltaPct).toBe(-30);
    expect(sc.verdict).toBe('helps');
  });

  it('"doesn\'t help here" when WITH regresses on cost', () => {
    const sc = computeScorecard(cell(0.10, 10, 1), cell(0.15, 10, 1));
    expect(sc.verdict).toBe("doesn't help here");
  });

  it('never claims a win when correctness drops', () => {
    const sc = computeScorecard(cell(0.20, 20, 1), cell(0.10, 8, 0.5));
    expect(sc.verdict).toBe("doesn't help here");
  });

  it('"break-even" inside the ±5% band', () => {
    const sc = computeScorecard(cell(0.100, 10, 1), cell(0.102, 10, 1));
    expect(sc.verdict).toBe('break-even');
  });

  it('render marks a dry run as synthetic', () => {
    const sc = computeScorecard(cell(0.2, 20, 1), cell(0.16, 14, 1));
    expect(renderScorecard(sc, { tasks: 3, mock: true })).toContain('DRY RUN');
    expect(renderScorecard(sc, { tasks: 3, mock: false })).not.toContain('DRY RUN');
  });
});

describe('verdict (unit)', () => {
  const base = { costWithout: 0, costWith: 0, turnsWithout: 0, turnsWith: 0, correctWithout: 1, correctWith: 1, freshWithout: 0, freshWith: 0, samplesPerArm: 4 };
  it('helps only when both metrics improve', () => {
    expect(verdict({ ...base, costDeltaPct: -10, turnsDeltaPct: -10 })).toBe('helps');
    expect(verdict({ ...base, costDeltaPct: -10, turnsDeltaPct: 0 })).toBe('break-even');
  });
});

// ── add-prove-shareable-scorecard ───────────────────────────────────────────

const sc = (over: Partial<Scorecard> = {}): Scorecard => ({
  costWithout: 0.20, costWith: 0.16, costDeltaPct: -20,
  turnsWithout: 20, turnsWith: 14, turnsDeltaPct: -30,
  correctWithout: 1, correctWith: 1, freshWithout: 13000, freshWith: 4000,
  samplesPerArm: 4, verdict: 'helps', ...over,
});
const meta = (over: Partial<ScorecardMeta> = {}): ScorecardMeta => ({
  mode: 'measured', generatedAt: '2026-06-22T10:00:00.000Z', repoSha: 'abc1234', model: 'sonnet', tasks: 3, ...over,
});

describe('serializeScorecard (--json contract)', () => {
  it('has exactly the documented stable key set at version 1', () => {
    const out = serializeScorecard(sc(), meta());
    expect(Object.keys(out).sort()).toEqual(
      ['schemaVersion', 'mode', 'generatedAt', 'repo', 'model', 'samplesPerArm', 'tasks',
        'cost', 'roundTrips', 'freshTokens', 'correctness', 'verdict'].sort(),
    );
    expect(out.schemaVersion).toBe(1);
    expect(out.cost).toEqual({ without: 0.20, with: 0.16, deltaPct: -20 });
    expect(out.roundTrips).toEqual({ without: 20, with: 14, deltaPct: -30 });
    expect(out.repo).toEqual({ sha: 'abc1234' });
    expect(out.verdict).toBe('helps');
  });

  it('carries mode + null model for an estimate', () => {
    const out = serializeScorecard(sc(), meta({ mode: 'estimate', model: null }));
    expect(out.mode).toBe('estimate');
    expect(out.model).toBeNull();
  });

  it('round-trips through JSON unchanged', () => {
    const out = serializeScorecard(sc(), meta());
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
  });
});

describe('renderScorecardMarkdown', () => {
  it('renders the table, honest verdict, and a badge', () => {
    const md = renderScorecardMarkdown(sc(), meta());
    expect(md).toContain('| Round-trips | 20 | 14 | -30% |');
    expect(md).toContain('OpenLore helps on this repo');
    expect(md).toContain('img.shields.io/badge/');
    expect(md).not.toContain('Estimate — not a measured'); // measured run: no estimate banner
  });

  it('shows the estimate banner and never claims measurement for an estimate', () => {
    const md = renderScorecardMarkdown(sc(), meta({ mode: 'estimate', model: null }));
    expect(md).toContain('Estimate — not a measured agent run');
  });

  it('shows losses honestly (no cherry-picking)', () => {
    const loss = sc({ costDeltaPct: 43, turnsDeltaPct: 38, verdict: "doesn't help here" });
    const md = renderScorecardMarkdown(loss, meta());
    expect(md).toContain('+43%');
    expect(md).toContain("doesn't help on this repo");
  });

  it('sanitizes a hostile --model (backtick / newline) so the inline-code span cannot be broken', () => {
    const md = renderScorecardMarkdown(sc(), meta({ model: 'a`b\nc' }));
    const metaLine = md.split('\n').find(l => l.includes('model'))!;
    // backticks stripped/replaced and the newline collapsed → the model stays on
    // one line inside one code span (the line has the opening+closing pair only).
    expect(metaLine).not.toContain('a`b');
    expect(md.split('\n').filter(l => l.startsWith('_') || l.includes('· model')).length).toBe(1);
    expect(metaLine).toContain('model `');
  });
});

describe('scorecardBadgeUrl', () => {
  it('encodes the round-trips signal and the verdict color', () => {
    const url = scorecardBadgeUrl(sc(), meta());
    // shields.io escaping: " " → "_", every "-" → "--" (so "-30%" → "--30%").
    expect(url).toContain('round--trips_--30%');
    expect(url).toContain('2563eb'); // helps → blue
  });
  it('labels non-measured modes in the badge', () => {
    const url = scorecardBadgeUrl(sc({ verdict: 'break-even' }), meta({ mode: 'estimate' }));
    expect(url).toContain('OpenLore_(estimate)');
    expect(url).toContain('9ca3af'); // break-even → grey
  });
});

describe('renderScorecard estimate mode', () => {
  it('shows the estimate banner and suppresses the small-sample LLM caveat', () => {
    const out = renderScorecard(sc({ samplesPerArm: 1 }), { tasks: 3, mode: 'estimate' });
    expect(out).toContain('ESTIMATE');
    expect(out).not.toContain('sample is small');
  });
});

describe('estimate arm (deterministic, no agent)', () => {
  // A connected graph: distinctive hub with 3 callers in distinct files, and a
  // distinctive fan-out function calling into more files.
  const facts: GraphFact[] = [
    { name: 'validateDirectory', filePath: 'src/utils.ts', callerNames: ['handleOrient', 'handleImpact', 'handleDrift'], calleeNames: [], isEntryPoint: false },
    { name: 'handleOrient', filePath: 'src/orient.ts', callerNames: [], calleeNames: ['validateDirectory', 'readConfig'], isEntryPoint: true },
    { name: 'handleImpact', filePath: 'src/impact.ts', callerNames: [], calleeNames: [], isEntryPoint: true },
    { name: 'handleDrift', filePath: 'src/drift.ts', callerNames: [], calleeNames: [], isEntryPoint: true },
    { name: 'readConfig', filePath: 'src/config.ts', callerNames: ['handleOrient'], calleeNames: [], isEntryPoint: false },
  ];

  it('answerBearingFiles unions file-path oracles and name→file resolutions', () => {
    const tasks = deriveTasks(facts);
    const files = answerBearingFiles(facts, tasks);
    // locate oracle carries src/utils.ts; caller names resolve to their files.
    expect(files.has('src/utils.ts')).toBe(true);
    expect(files.has('src/orient.ts')).toBe(true);
    expect(files.size).toBeGreaterThan(1);
  });

  it('produces a WITH arm that is cheaper and fewer round-trips on a connected graph', () => {
    const tasks = deriveTasks(facts);
    const cells = estimateCells(facts, tasks)!;
    expect(cells).not.toBeNull();
    expect(cells.with.numTurns).toBeLessThan(cells.without.numTurns);
    expect(cells.with.costUsd).toBeLessThan(cells.without.costUsd);
    // The estimate holds correctness equal — the tax is effort, not accuracy.
    expect(cells.with.correctRate).toBe(1);
    expect(cells.without.correctRate).toBe(1);
  });

  it('is deterministic (same facts → same cells)', () => {
    const tasks = deriveTasks(facts);
    expect(estimateCells(facts, tasks)).toEqual(estimateCells(facts, tasks));
  });

  it('returns null when there are no tasks', () => {
    expect(estimateCells(facts, [])).toBeNull();
  });

  it('caps answer-bearing files so one mega-hub cannot skew the estimate', () => {
    const many: GraphFact[] = [
      { name: 'megaHubFunction', filePath: 'src/hub.ts', callerNames: Array.from({ length: 200 }, (_, i) => `caller${i}`), calleeNames: [], isEntryPoint: false },
      ...Array.from({ length: 200 }, (_, i) => ({ name: `caller${i}`, filePath: `src/c${i}.ts`, callerNames: [], calleeNames: ['megaHubFunction'], isEntryPoint: true })),
    ];
    const tasks = deriveTasks(many);
    const cells = estimateCells(many, tasks)!;
    // without-turns = nTasks + cappedFiles; capped at maxAnswerFiles + a few tasks.
    expect(cells.without.numTurns).toBeLessThanOrEqual(DEFAULT_ESTIMATE_ASSUMPTIONS.maxAnswerFiles + tasks.length);
  });
});
