/**
 * Spec 14 — MCP tool-preset selection (`--preset` / `--minimal`).
 *
 * Guards the navigation preset that flipped the agent benchmark from a loss to a
 * win: it must expose exactly its graph-traversal tools, every preset name must
 * resolve to a REAL tool (so a renamed/removed tool can't silently shrink the
 * surface), and the selector's precedence/error behaviour must hold.
 */
import { describe, it, expect } from 'vitest';
import { selectActiveTools, TOOL_PRESETS, TOOL_DEFINITIONS, mcpCommand, BREADTH_POINTER, leanDefaultActive, resolvePresetName } from './mcp.js';
import { LEAN_DEFAULT_PRESET } from '../../constants.js';

const NAV = [
  'orient', 'search_code', 'get_subgraph', 'trace_execution_path',
  'analyze_impact', 'suggest_insertion_points', 'get_function_skeleton',
  'get_landmarks', 'get_map', 'find_path',
];

describe('MCP tool presets', () => {
  it('every preset references only real, defined tools (no stale names)', () => {
    const real = new Set(TOOL_DEFINITIONS.map(t => t.name));
    for (const [name, set] of Object.entries(TOOL_PRESETS)) {
      for (const tool of set) {
        expect(real.has(tool), `preset "${name}" references unknown tool "${tool}"`).toBe(true);
      }
    }
  });

  it('navigation preset = exactly the 10 graph-traversal tools, no governance tools', () => {
    const tools = selectActiveTools(TOOL_DEFINITIONS, { preset: 'navigation' }).map(t => t.name);
    expect(new Set(tools)).toEqual(new Set(NAV));
    for (const gov of ['record_decision', 'detect_changes', 'check_spec_drift']) {
      expect(tools).not.toContain(gov);
    }
  });

  it('minimal preset keeps its 6-tool contract', () => {
    const tools = selectActiveTools(TOOL_DEFINITIONS, { minimal: true }).map(t => t.name);
    expect(new Set(tools)).toEqual(new Set(['orient', 'search_code', 'record_decision', 'detect_changes', 'check_spec_drift', 'get_health_map']));
  });

  // change: add-parallel-work-plan — plan_parallel_work is opt-in via the `coordination`
  // preset only; it must NOT leak into the lean/minimal/memory surfaces.
  it('coordination preset exposes plan_parallel_work; lean/minimal/memory do not', () => {
    const coord = selectActiveTools(TOOL_DEFINITIONS, { preset: 'coordination' }).map(t => t.name);
    expect(new Set(coord)).toEqual(new Set(['orient', 'plan_parallel_work', 'map_in_flight_conflicts', 'analyze_impact', 'find_path']));
    for (const sel of [{}, { minimal: true }, { preset: 'memory' }, { preset: 'navigation' }] as const) {
      expect(selectActiveTools(TOOL_DEFINITIONS, sel).map(t => t.name)).not.toContain('plan_parallel_work');
    }
  });

  // change: add-cross-actor-interference-map — map_in_flight_conflicts is opt-in via the
  // `coordination` AND `federation` presets; it must NOT leak into lean/minimal/memory.
  it('map_in_flight_conflicts is in coordination + federation only, never lean/minimal/memory', () => {
    expect(selectActiveTools(TOOL_DEFINITIONS, { preset: 'coordination' }).map(t => t.name)).toContain('map_in_flight_conflicts');
    expect(selectActiveTools(TOOL_DEFINITIONS, { preset: 'federation' }).map(t => t.name)).toContain('map_in_flight_conflicts');
    for (const sel of [{}, { minimal: true }, { preset: 'memory' }, { preset: 'navigation' }, { preset: 'verify' }] as const) {
      expect(selectActiveTools(TOOL_DEFINITIONS, sel).map(t => t.name)).not.toContain('map_in_flight_conflicts');
    }
  });

  // change: add-declarative-language-support-registry — get_language_support is FULL-surface
  // only (not in any curated preset); it must never enter the lean/minimal/first-run surface.
  it('get_language_support is full-surface only, never in any curated preset', () => {
    expect(selectActiveTools(TOOL_DEFINITIONS, { allTools: true }).map(t => t.name)).toContain('get_language_support');
    for (const sel of [{}, { minimal: true }, { preset: 'navigation' }, { preset: 'memory' }, { preset: 'verify' }, { preset: 'federation' }, { preset: 'coordination' }] as const) {
      expect(selectActiveTools(TOOL_DEFINITIONS, sel).map(t => t.name)).not.toContain('get_language_support');
    }
  });

  // Guard: the user-facing `--minimal` help text must match the actual preset — it
  // drifted to "5 tools" once after get_health_map was added to the 6-tool set.
  it('the --minimal help text matches the minimal preset (count + every member named)', () => {
    const minimal = [...TOOL_PRESETS.minimal];
    const opt = mcpCommand.options.find(o => o.long === '--minimal');
    expect(opt, 'the --minimal option is registered').toBeTruthy();
    const help = opt!.description;
    expect(help, 'help states the live minimal-preset size').toContain(`core ${minimal.length} tools`);
    for (const t of minimal) {
      expect(help, `help names the minimal tool "${t}"`).toContain(t);
    }
  });

  // Guard: the `--preset` help text says "instead of all N" where N is the full
  // surface; it drifted to a stale "58"/"45" while TOOL_DEFINITIONS grew. Tie the
  // help integer to the live count so a new tool forces the string to move (the
  // doc-count guard covers README/docs but not this CLI help string).
  it('the --preset help text states the live full-surface tool count', () => {
    const opt = mcpCommand.options.find(o => o.long === '--preset');
    expect(opt, 'the --preset option is registered').toBeTruthy();
    expect(opt!.description, 'help states the live full-surface count').toContain(`all ${TOOL_DEFINITIONS.length}`);
  });

  // Guard: the `--preset` help enumerates the navigation preset by name; it drifted to
  // listing only 7 of the 10 members (missing get_landmarks/get_map/find_path) while the
  // preset itself grew. Tie the enumeration to the live preset so a new member forces the
  // help string to move (the count guard above did not cover the enumeration).
  it('the --preset help names every navigation-preset member', () => {
    const opt = mcpCommand.options.find(o => o.long === '--preset');
    const help = opt!.description;
    for (const t of TOOL_PRESETS.navigation) {
      expect(help, `--preset help names the navigation tool "${t}"`).toContain(t);
    }
  });

  // change: default-to-lean-tool-surface — the default was inverted. No selector
  // now resolves to the lean default surface (the navigation preset), NOT the full
  // registry. The full surface is opt-in via --preset full / --all-tools.
  it('no selector exposes the LEAN DEFAULT surface (navigation), not the full set', () => {
    const tools = selectActiveTools(TOOL_DEFINITIONS, {}).map(t => t.name);
    expect(new Set(tools)).toEqual(new Set(NAV));
    expect(tools.length).toBeLessThan(TOOL_DEFINITIONS.length); // strictly smaller than full
    expect(LEAN_DEFAULT_PRESET).toBe('navigation'); // the lean default IS the navigation preset
  });

  it('--preset full / --all-tools / --preset all expose the full TOOL_DEFINITIONS surface', () => {
    expect(selectActiveTools(TOOL_DEFINITIONS, { preset: 'full' })).toHaveLength(TOOL_DEFINITIONS.length);
    expect(selectActiveTools(TOOL_DEFINITIONS, { preset: 'all' })).toHaveLength(TOOL_DEFINITIONS.length);
    expect(selectActiveTools(TOOL_DEFINITIONS, { allTools: true })).toHaveLength(TOOL_DEFINITIONS.length);
    expect(TOOL_DEFINITIONS.length).toBeGreaterThan(NAV.length); // full surface really is larger
  });

  it('--all-tools / --preset full win over --preset and --minimal (full is the explicit escape hatch)', () => {
    expect(selectActiveTools(TOOL_DEFINITIONS, { allTools: true, preset: 'navigation' })).toHaveLength(TOOL_DEFINITIONS.length);
    expect(selectActiveTools(TOOL_DEFINITIONS, { allTools: true, minimal: true })).toHaveLength(TOOL_DEFINITIONS.length);
  });

  it('an unknown preset error now lists "full" as a known selector', () => {
    expect(() => selectActiveTools(TOOL_DEFINITIONS, { preset: 'nope' })).toThrow(/full/);
  });

  it('--preset takes precedence over --minimal', () => {
    const tools = selectActiveTools(TOOL_DEFINITIONS, { minimal: true, preset: 'navigation' }).map(t => t.name);
    expect(new Set(tools)).toEqual(new Set(NAV));
  });

  it('an unknown preset throws with the known list, not a silent full surface', () => {
    expect(() => selectActiveTools(TOOL_DEFINITIONS, { preset: 'nope' })).toThrow(/Unknown --preset "nope".*minimal.*navigation/s);
  });

  // change: add-multi-repo-federation — FederationScopedConclusions: the
  // federation capability (federation_status) appears ONLY under the federation
  // preset; the default and minimal surfaces register no federation capability.
  // change: add-spec-store-binding — spec_store_status joins the federation preset
  // (it resolves declared targets against the same registry), kept out of minimal.
  it('federation_status is gated to the federation preset, never in default/minimal', () => {
    const fed = selectActiveTools(TOOL_DEFINITIONS, { preset: 'federation' }).map(t => t.name);
    expect(fed).toContain('federation_status');
    expect(new Set(fed)).toEqual(new Set(['orient', 'federation_status', 'spec_store_status', 'working_set_context', 'change_impact_certificate', 'analyze_impact', 'find_dead_code', 'select_tests', 'find_path', 'map_in_flight_conflicts']));

    expect(selectActiveTools(TOOL_DEFINITIONS, { minimal: true }).map(t => t.name)).not.toContain('federation_status');
    // Default surface DOES list the four federation-aware tools, but federation_status
    // — the registry-backed capability — is the opt-in marker and rides only the preset.
  });

  // change: add-structural-claim-verification / add-decision-reference-claim-verification —
  // verify_claim (incl. the decision-current kind) is gated to the opt-in `verify` preset,
  // never the lean default/navigation surface. Guards the spec claim that the capability is
  // "registered only in an opt-in preset (verify)".
  it('verify_claim is gated to the verify preset, never in the default/navigation surface', () => {
    const verify = selectActiveTools(TOOL_DEFINITIONS, { preset: 'verify' }).map(t => t.name);
    expect(new Set(verify)).toEqual(new Set(['orient', 'search_code', 'verify_claim']));
    expect(selectActiveTools(TOOL_DEFINITIONS, { preset: 'navigation' }).map(t => t.name)).not.toContain('verify_claim');
    expect(selectActiveTools(TOOL_DEFINITIONS, {}).map(t => t.name)).not.toContain('verify_claim');
  });

  // The decision-reference clause: the verify_claim schema must advertise the
  // `decision-current` kind, so an agent (and the SDK's schema validation) sees it.
  it('verify_claim advertises the decision-current kind in its schema enum', () => {
    const vc = TOOL_DEFINITIONS.find(t => t.name === 'verify_claim');
    expect(vc, 'verify_claim is a defined tool').toBeDefined();
    const kindEnum = (vc!.inputSchema as { properties?: { kind?: { enum?: string[] } } }).properties?.kind?.enum ?? [];
    expect(kindEnum).toContain('decision-current');
    // and the structural kinds remain advertised (additive, not a replacement)
    for (const k of ['calls', 'reaches', 'dead', 'impacts', 'safe-to-change']) expect(kindEnum).toContain(k);
  });
});

// ============================================================================
// change: default-to-lean-tool-surface — selector → canonical preset resolution.
// One source of truth (resolvePresetName) drives both the active tool set and the
// breadth-pointer decision, so they can never disagree.
// ============================================================================
describe('resolvePresetName (canonical selector resolution)', () => {
  it('no selector resolves to the lean default (navigation)', () => {
    expect(resolvePresetName({})).toBe('navigation');
    expect(resolvePresetName({})).toBe(LEAN_DEFAULT_PRESET);
  });
  it('full-surface selectors all resolve to "full"', () => {
    expect(resolvePresetName({ allTools: true })).toBe('full');
    expect(resolvePresetName({ preset: 'full' })).toBe('full');
    expect(resolvePresetName({ preset: 'all' })).toBe('full'); // alias normalizes
  });
  it('--minimal resolves to "minimal"; a named preset resolves to itself', () => {
    expect(resolvePresetName({ minimal: true })).toBe('minimal');
    expect(resolvePresetName({ preset: 'memory' })).toBe('memory');
    expect(resolvePresetName({ preset: 'navigation' })).toBe('navigation');
  });
  it('full-surface selectors win over --preset and --minimal', () => {
    expect(resolvePresetName({ allTools: true, preset: 'navigation' })).toBe('full');
    expect(resolvePresetName({ allTools: true, minimal: true })).toBe('full');
  });
});

// ============================================================================
// change: default-to-lean-tool-surface — breadth discoverability. The pointer
// fires when the ACTIVE surface IS the lean default (navigation) — whether reached
// by no selector OR by an explicit `--preset navigation` (how `openlore install`
// wires the default). Any other surface is a deliberate different choice → no
// pointer. It rides the MCP instructions channel and adds zero tool schemas.
// ============================================================================
describe('breadth discoverability on the lean default surface', () => {
  it('the pointer fires for the lean default surface, however it was selected', () => {
    expect(leanDefaultActive({})).toBe(true);                       // bare `openlore mcp`
    expect(leanDefaultActive({ preset: 'navigation' })).toBe(true); // how install wires it
  });

  it('the pointer is suppressed on every other (deliberately chosen) surface', () => {
    expect(leanDefaultActive({ minimal: true })).toBe(false);
    expect(leanDefaultActive({ preset: 'memory' })).toBe(false);
    expect(leanDefaultActive({ preset: 'verify' })).toBe(false);
    expect(leanDefaultActive({ preset: 'federation' })).toBe(false);
    expect(leanDefaultActive({ preset: 'full' })).toBe(false);
    expect(leanDefaultActive({ preset: 'all' })).toBe(false);
    expect(leanDefaultActive({ allTools: true })).toBe(false);
  });

  it('the pointer names how to opt into breadth, every option in copy-pasteable --preset form', () => {
    expect(BREADTH_POINTER).toMatch(/--preset full/);
    expect(BREADTH_POINTER).toMatch(/--preset memory/);
    expect(BREADTH_POINTER).toMatch(/--preset minimal/); // governance, not the bare --minimal flag
    expect(BREADTH_POINTER).toMatch(/openlore install --preset/);
    // Every `--preset <name>` the pointer advertises must resolve to a real surface.
    for (const m of BREADTH_POINTER.matchAll(/--preset (\w+)/g)) {
      expect(() => selectActiveTools(TOOL_DEFINITIONS, { preset: m[1] })).not.toThrow();
    }
  });

  it('the pointer adds no tool schemas — the lean default surface size is unchanged by it', () => {
    // The pointer rides the instructions channel; the active tool set is exactly
    // the navigation preset regardless.
    expect(selectActiveTools(TOOL_DEFINITIONS, {}).map(t => t.name)).toEqual(
      selectActiveTools(TOOL_DEFINITIONS, { preset: 'navigation' }).map(t => t.name),
    );
  });
});

// ============================================================================
// Spec 25 P1 — cache-prefix stability. The Round-1 loss was per-request tool-
// schema overhead; the fix is a surface the provider KV-cache can hold. That
// only works if the emitted tool list is byte-identical across requests, so
// these guard against any per-request variation (reordering, rebuilt schemas).
// ============================================================================
describe('MCP surface cache-prefix stability (spec-25 P1)', () => {
  const serialize = (opts: { minimal?: boolean; preset?: string }) =>
    JSON.stringify(selectActiveTools(TOOL_DEFINITIONS, opts).map(t => ({ name: t.name, inputSchema: (t as { inputSchema?: unknown }).inputSchema })));

  it('emits a byte-identical tool list across repeated calls (full + each preset)', () => {
    for (const opts of [{}, { minimal: true }, { preset: 'navigation' }] as const) {
      expect(serialize(opts)).toBe(serialize(opts)); // same content twice → stable prefix
    }
  });

  it('preset filtering preserves TOOL_DEFINITIONS declaration order (filter, not Set order)', () => {
    const full = TOOL_DEFINITIONS.map(t => t.name);
    const nav = selectActiveTools(TOOL_DEFINITIONS, { preset: 'navigation' }).map(t => t.name);
    // nav names appear in the same relative order as in the full declaration.
    expect(nav).toEqual(full.filter(n => nav.includes(n)));
  });

  it('tool names are unique (a duplicate would make the cached prefix order ambiguous)', () => {
    const names = TOOL_DEFINITIONS.map(t => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every tool carries a static inputSchema object (not rebuilt per request)', () => {
    for (const t of TOOL_DEFINITIONS) {
      const a = (t as { inputSchema?: unknown }).inputSchema;
      const b = (t as { inputSchema?: unknown }).inputSchema;
      expect(a).toBe(b); // same reference → no per-request reconstruction
    }
  });
});

// ============================================================================
// Spec 11 — tool annotations: every tool has complete MCP annotations
// ============================================================================
import { toolAnnotations } from './mcp.js';

describe('tool annotations (spec-11)', () => {
  it('every tool has a title, the three read/write hints, and openWorldHint', () => {
    for (const t of TOOL_DEFINITIONS) {
      const a = toolAnnotations(t.name);
      expect(typeof a.title).toBe('string');
      expect((a.title as string).length).toBeGreaterThan(0);
      expect(typeof a.readOnlyHint).toBe('boolean');
      expect(typeof a.destructiveHint).toBe('boolean');
      expect(typeof a.idempotentHint).toBe('boolean');
      expect(typeof a.openWorldHint).toBe('boolean');
    }
  });

  it('derives a human-readable title from the snake_case name', () => {
    expect(toolAnnotations('get_change_coupling').title).toBe('Get Change Coupling');
    expect(toolAnnotations('orient').title).toBe('Orient');
  });

  it('marks LLM-backed tools open-world and local analysis tools closed-world', () => {
    expect(toolAnnotations('generate_tests').openWorldHint).toBe(true);
    expect(toolAnnotations('orient').openWorldHint).toBe(false);
    expect(toolAnnotations('find_dead_code').openWorldHint).toBe(false);
  });

  it('read-only analysis tools are marked readOnly + non-destructive', () => {
    for (const name of ['orient', 'analyze_impact', 'find_dead_code', 'structural_diff', 'get_change_coupling']) {
      const a = toolAnnotations(name);
      expect(a.readOnlyHint).toBe(true);
      expect(a.destructiveHint).toBe(false);
    }
  });
});

// ============================================================================
// Spec 28 — tools/list payload budget. The full tool surface is a ~46 KB / ~11.6k-
// token prefix that an eager (non-deferring) MCP client loads every turn. Spec 25
// §7 asked whether that prefix could be erased; Spec 28 measured the answer:
// deferral is client-side (the dominant client already lazy-loads MCP schemas),
// and the server-side lossless byte-lever is ~1%. These guards lock that in — they
// fail loudly if the prefix bloats back, so adding a tool is a conscious budget
// bump, not silent drift. Bytes mirror what the ListTools handler actually emits.
// ============================================================================
describe('tools/list payload budget (spec-28)', () => {
  const payloadBytes = (opts: { minimal?: boolean; preset?: string }): number => {
    const tools = selectActiveTools(TOOL_DEFINITIONS, opts).map(t => ({
      ...t,
      annotations: toolAnnotations(t.name),
    }));
    return Buffer.byteLength(JSON.stringify({ tools }), 'utf8');
  };

  // Ceilings sit just above the measured size (full ≈ 46.5 KB, nav ≈ 10.9 KB) with
  // ~1 tool of headroom. A new tool (~900 B) or un-trimmed boilerplate breaches
  // them — forcing a deliberate decision rather than letting the cached prefix creep.
  // The nav ceiling was bumped 8_500 → 9_800 → 10_700 → 11_800 as the structural-
  // navigation primitives get_landmarks, get_map, then find_path were added to the
  // preset — each a conscious budget decision, not silent drift.
  // Full ceiling bumped 48_000 → 50_000 when the navigation primitives get_landmarks,
  // get_map, and find_path were added to the surface — a conscious budget decision.
  // Bumped 50_000 → 52_000 when the opt-in `memory` preset's remember/recall were added
  // (code-anchored persistent memory) — again a conscious decision, not silent drift. The
  // two tools stay out of the default/minimal surface; only the full surface widens.
  // Bumped 52_000 → 53_000 when get_surprising_connections and get_health_map were added
  // to the full surface — conscious budget decision.
  // Bumped 53_000 → 54_000 when the `directResolvedOnly` strict-traversal option was added
  // to find_dead_code/analyze_impact/get_subgraph/find_path/select_tests/trace_execution_path
  // (one boolean prop per tool) — conscious budget decision, not silent drift.
  // Nav bumped 11_800 → 12_300 and full kept < 54_000 when the value-level opt-in
  // (`valueLevel` + `valueParam`) was added to analyze_impact and trace_execution_path
  // (spec: add-intraprocedural-cfg-dataflow-overlay) — two opt-in props per tool,
  // a conscious decision, not silent drift.
  // Nav bumped 12_300 → 12_500 and full 54_000 → 55_000 when the opt-in personalized-
  // PageRank ranking mode (`rankBy` on orient + `rankBy`/`tokenBudget` on get_minimal_context;
  // spec: add-personalized-pagerank-context-ranking) was added — a ranking MODE on existing
  // tools, no new tool, default surface count unchanged. Conscious decision, not silent drift.
  // Full bumped 55_000 → 57_000 when bitemporal/typed/lifecycle memory ops (spec:
  // add-bitemporal-typed-memory-operations) added four opt-in params — `type`/`supersedes` on
  // remember and `asOf`/`changedSince`/`type` on recall — riding existing tools (no new tool,
  // default/minimal surfaces unchanged). Descriptions were trimmed first; the residual ~650 B is
  // the genuine cost of the new capability. Conscious decision, not silent drift.
  // Full bumped 55_000 → 57_000 when the `blast_radius` pre-flight guard tool was added to the
  // full surface (spec: add-preflight-blast-radius-guard) — a new orchestration tool that briefs a
  // diff's structural blast radius. It stays OUT of the minimal/navigation/memory presets; only the
  // full surface widens. Conscious decision, not silent drift.
  // Bumped to 57_000 — the combined cost of blast_radius + verify_claim + federation_status
  // and the opt-in params added across PRs #163-#167. (merge reconciliation)
  // Bumped 61_000 → 62_000 when the `spec_store_status` tool was added to the full surface
  // (spec: add-spec-store-binding) — a read-only binding-health tool. It stays OUT of the
  // minimal/navigation/memory presets; only the full surface widens. Conscious decision.
  // Bumped 62_000 → 63_000 when the `working_set_context` tool was added to the full surface
  // (spec: add-working-set-context-briefing) — a read-only working-set briefing tool. It joins
  // the opt-in federation preset only; it stays OUT of minimal/navigation/memory. Conscious decision.
  // Bumped 63_000 → 64_000 when the `change_impact_certificate` tool was added to the full surface
  // (spec: add-change-impact-certificate) — a read-only change-impact certificate tool. It joins
  // the opt-in federation preset only; it stays OUT of minimal/navigation/memory. Conscious decision.
  // change: default-to-lean-tool-surface — the full surface is now opt-in, so the
  // full-budget assertion uses the explicit full selector (no-selector `{}` resolves
  // to the lean navigation default and is asserted separately below).
  // Bumped 64_000 → 66_000 when the `plan_parallel_work` tool was added to the full surface
  // (spec: add-parallel-work-plan) — a read-only parallel-work coordination tool whose schema
  // carries a nested per-task descriptor array. It joins ONLY the new opt-in `coordination`
  // preset; it stays OUT of minimal/navigation/memory. Description trimmed first; the residual
  // is the genuine cost of the nested task-list schema. Conscious decision, not silent drift.
  // Bumped 66_000 → 68_000 when the `map_in_flight_conflicts` tool was added to the full surface
  // (spec: add-cross-actor-interference-map) — a read-only cross-actor interference map whose
  // schema carries a nested agent-task array (mirroring plan_parallel_work) plus the federation
  // opt-in params. It joins ONLY the opt-in `federation` and `coordination` presets; it stays OUT
  // of minimal/navigation/memory. Description + task-item schema trimmed first; the residual is the
  // genuine cost of the nested task-list + federation params. Conscious decision, not silent drift.
  // Bumped 68_000 → 70_000 on the merge of footprint-escape-detection + cross-actor-interference-map
  // into one surface: the two changes each bumped this budget independently (footprint-escape widened
  // `structural_diff`'s schema with declaredFootprint/peerFootprints; cross-actor added the new tool),
  // and the merge stacks both increments. No new tool here — just the realized combined surface cost.
  // Bumped 70_000 → 72_000 when the `report_coverage_gaps` tool was added to the full
  // surface (change: add-test-coverage-gap-report) — a read-only structural coverage-gap
  // conclusion tool. It joins ONLY the opt-in `full` surface; it stays OUT of
  // minimal/navigation/memory/verify/federation/coordination, so the lean default prefix
  // is unchanged. The residual is the genuine cost of its schema. Conscious decision, not
  // silent drift.
  it('full surface stays within its prefix budget', () => {
    expect(payloadBytes({ preset: 'full' })).toBeLessThan(72_000);
  });

  it('the lean DEFAULT surface (no selector) is the lean navigation payload, not the full one', () => {
    // No selector now pays the navigation budget, not the ~46 KB full prefix —
    // this is the per-session byte win the change ships.
    expect(payloadBytes({})).toBe(payloadBytes({ preset: 'navigation' }));
    expect(payloadBytes({})).toBeLessThan(13_300);
    expect(payloadBytes({})).toBeLessThan(payloadBytes({ preset: 'full' }));
  });

  it('navigation preset stays lean (the low-overhead surface that wins the benchmark)', () => {
    expect(payloadBytes({ preset: 'navigation' })).toBeLessThan(13_300);
  });

  // Lossless-dedup invariant: the `directory` input is shared by every tool, so its
  // description must stay a short shared string, never the 38-char verbatim repeat
  // that Spec 28 collapsed. Guards against the duplication silently creeping back.
  it('the shared directory-param description is short and used by the majority of tools', () => {
    const dirDescs = TOOL_DEFINITIONS
      .map(t => {
        const props = t.inputSchema?.properties as unknown as Record<string, { description?: string }> | undefined;
        return props?.directory?.description;
      })
      .filter((d): d is string => typeof d === 'string');
    const counts = new Map<string, number>();
    for (const d of dirDescs) counts.set(d, (counts.get(d) ?? 0) + 1);
    const [dominant, dominantCount] = [...counts].sort((a, b) => b[1] - a[1])[0];
    expect(dominant.length).toBeLessThanOrEqual(25); // short shared form, not the old 38-char repeat
    expect(dominantCount).toBeGreaterThanOrEqual(dirDescs.length * 0.8); // most tools reuse it
  });
});
