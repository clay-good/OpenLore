@openspec/specs/overview/spec.md

# openlore MCP tools

Each tool's description says when to use it. The full list, grouped by capability family, is in
[`docs/mcp-tools.md`](docs/mcp-tools.md). For reading a file, grepping, or listing files, use native tools.

> **The default MCP surface is the `substrate` preset (change `refine-happy-path-and-defaults`):** a bare
> `openlore mcp` / `openlore install` wires the 15-tool `substrate` preset — the navigation core, spec-workflow composites, and governance reads
> (`prepare_spec_generation` + `prepare_spec_repair` + `recall` + `verify_claim` + `blast_radius`) — not all 84 tools. It cleared the
> DefaultSurfaceRevealsAllFaces benchmark (no task-completion or selection regression across two models /
> both tiers; decision c79ec7ca / ADR-0023, superseding ADR-0022). Narrower/wider is opt-in: the lean
> navigate-only `navigation` preset (10 tools, the one-flag escape), `--minimal` (governance core),
> `--preset memory` / `verify` / `federation` / `coordination`, or the full surface via `--preset full`
> (`--all-tools`). The `record_decision` MCP tool is **not** in the default; on any preset, record a
> decision for the commit gate with `openlore decisions record --title "…" --rationale "…"`, or
> install with `--preset full` (or `--minimal`) to expose the MCP tool.

> **OpenLore is one substrate with two faces (change `unify-navigation-and-governance-substrate`).**
> Navigation (read the graph) and governance/memory (anchor facts, weigh changes) share one graph, one
> anchored-fact store, one freshness lease (`architecture` `UnifiedStructuralSubstrate`). Every tool
> declares exactly one of six **closed capability families** — `navigate` · `change` · `remember` ·
> `verify` · `coordinate` · `federate` — in `TOOL_CAPABILITY_FAMILY` (`tool-contract.ts`), emitted in
> each tool's MCP `annotations.family` so the full surface is discoverable by family, not as a flat
> list. Adjacent tools in one family are NOT merged when each returns a distinct conclusion; each names
> its near-sibling instead (`NoRedundantConclusions`). `tool-contract.test.ts` fails CI if a new tool
> forgets a family, or an adjacent tool fails to cross-reference its sibling. The active out-of-box
> default is `substrate` (navigation core + governance reads) — flipped from `navigation` on benchmark evidence (ADR-0023,
> superseding ADR-0022); `--preset navigation` remains the lean navigate-only escape.

> **Memory tools (`remember`/`recall`) are opt-in:** they ship in the `memory` preset
> (`openlore mcp --preset memory`), not the default or `minimal` surface, per the
> `mcp-quality` minimize-tool-surface rule.

> **Authoring a new MCP tool?** Classify it `conclusion` or `explicit-topology` in
> `src/core/services/mcp-handlers/tool-contract.ts` — `tool-contract.test.ts` fails until you do.
> Conclusion tools must return the computed answer, not a graph for the agent to traverse.

> **Adding a field that says your answer is incomplete?** (a refusal verdict, a cap, a fallback, a
> degradation, a discarded input.) Classify it in `confidence-boundary.ts`: register it in
> `DISCLOSURE_CHANNELS` with its own firing predicate, or record it in
> `NON_DISCLOSURE_RESPONSE_FIELDS` with the reason it is not a completeness signal.
> `completeness-invariant.test.ts` fails until you do. `confidenceBoundary.complete` is DERIVED from
> that registry at the dispatch boundary and must never be asserted by a handler — `complete: true`
> beside a disclosed gap tells the agent not to look further, turning a disclosed gap into a silent
> one. A live disclosure that exists only in prose (`note`, `caveats`) is invisible to the sweep:
> declare it with `assembleBoundary({ disclosures })`, and never pass a standing methodology caveat,
> which would pin `complete` to false forever (change: never-claim-complete-beside-a-refusal).

> **Authoring a new governance finding?** Register its stable `code` (with a source-declared default
> class + description) in `FINDING_CODE_REGISTRY` in `src/core/services/mcp-handlers/enforcement-policy.ts`,
> and emit it in the unified `GovernanceFinding` shape (`{ code, severity, source, subject, message }`).
> A registered code is one an operator's `enforcement.policy` can name and `openlore enforce` can govern;
> the source owns the finding's intrinsic `severity`, the policy owns its enforcement class. Findings stay
> advisory by default — blocking is always opt-in (change: add-finding-enforcement-policy).
## Agent skills

### Issue tracker

Issues live as GitHub issues on this repository, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Stock GitHub labels only — `needs-info`→`question`, `ready-for-human`→`help wanted`, `wontfix`→`wontfix`; `needs-triage` and `ready-for-agent` are stated in a comment. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context; no `CONTEXT.md` yet, and ADRs live in `openspec/decisions/`, not `docs/adr/`. See `docs/agents/domain.md`.

# Chat reply standard

Use this standard for your chat replies: **ASD-STE100 Simplified Technical English** (**STE**). Also consider ELI18 and TLDR. Apart from that: silence is gold

<!-- BEGIN OPENLORE (managed — edits inside this block will be overwritten) -->
<!-- openlore-fingerprint: 10ce2067b8190104 -->
Where OpenLore hooks are wired, they push evidence about code you touch, and stay silent when they have nothing new.
For code you have not read in this session, the `orient` tool (or `openlore orient "<task>"`) returns its functions, callers, and specs in one lookup.
Record a significant design choice: `openlore decisions record --title "<decision>" --rationale "<why>"`.
In an indexed repository, the full digest is `.openlore/analysis/CODEBASE.md` by default; read it when a task needs it.
A tool reply may start with a freshness note (the Epistemic Lease); it is informational.
Wired MCP surface: `substrate`; `openlore install --preset <name>` changes it.
<!-- END OPENLORE -->
