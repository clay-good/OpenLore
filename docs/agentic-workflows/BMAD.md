# BMAD Integration

> One implementation of the [generic openlore agentic workflow pattern](./README.md).
> Assets: [`examples/bmad/`](../../examples/bmad/)

This guide explains how to connect [BMAD Method](https://docs.bmad-method.org) with openlore
to enable safe, spec-driven development on brownfield codebases.

## Why

BMAD is designed for structured, spec-first development. On brownfield codebases
(existing code without explicit architecture documentation), agents lack the structural
context needed to plan and implement safely.

The key principle: **structural reality must be known at architecture time, not at
implementation time.** openlore provides that context via MCP at every phase of the
BMAD workflow.

## Full Workflow

```
── ARCHITECTURE PHASE ──────────────────────────────────────────────────────────

  Brownfield Onboarding          ← bmad/tasks/onboarding.md (run once)
       │  openlore analyze + generate
       ▼
  Architect Agent                ← bmad/agents/architect.md
       │  get_architecture_overview
       │  get_refactor_report          → no-touch zones
       │  get_critical_hubs            → hub risk landscape
       │  generate_change_proposal     → per epic
       ▼
  architecture.md                ← structural reality + target + gap = debt backlog
       │
       ▼
  Technical Debt Stories         ← refactor stories created BEFORE feature stories

── PLANNING PHASE ──────────────────────────────────────────────────────────────

  PM Agent                       ← uses bmad/templates/story.md
       │  risk_context pre-filled from architect output
       ▼
  Sprint Candidate               ← stories with risk_context embedded
       │
       ▼
  Sprint Planning                ← bmad/tasks/sprint-planning.md
       │  generate_change_proposal    → per story
       │  get_critical_hubs           → conflict detection
       │  check_spec_drift            → coverage gaps
       ▼
  Sprint Plan                    ← risk matrix + story order + blocked list

── IMPLEMENTATION PHASE ────────────────────────────────────────────────────────

  Dev Agent                      ← bmad/tasks/implement-story.md
       │  reads risk_context from story (already known)
       │  orient + analyze_impact    → confirm + verify, not discover
       ▼
  Implementation + check_spec_drift
       │
       ▼
  openlore generate               ← update specs post-sprint
```

## Architecture (MCP layer)

```
BMAD Agents (Architect / PM / SM / Dev)
    │
    │  MCP calls
    ▼
openlore MCP Server
    │
    ├── analyze_codebase          → build/refresh call graph
    ├── get_architecture_overview → domain clusters, hubs, entry points
    ├── get_refactor_report       → no-touch zones, priority scores
    ├── get_critical_hubs         → fan-in bottlenecks
    ├── generate_change_proposal  → per epic/story → proposal.md
    ├── orient                    → story → functions + insertion points
    ├── analyze_impact            → blast radius + risk score
    ├── search_specs / get_spec   → existing requirements
    ├── check_spec_drift          → post-implementation verification
    └── ... 17 other tools
    │
    ▼
Codebase (brownfield) + openspec/ (specs)
```

## Setup

### Prerequisites

- Node.js 20+
- BMAD installed: `npx bmad-method install` (version 6+)
- openlore MCP server built and running

### 1. Install openlore MCP server

```bash
npm install -g openlore
```

Connect it in your IDE's MCP config (Claude Code, Cursor, Windsurf…):

```json
{
  "mcpServers": {
    "openlore": {
      "command": "openlore",
      "args": ["mcp", "--watch-auto"]
    }
  }
}
```

### 2. Install BMAD in your project (if not already done)

```bash
npx bmad-method install
```

This creates the `_bmad/` directory with agents, tasks, and config.

### 3. Copy openlore BMAD assets into your project

```bash
# Tasks and templates
cp -r /path/to/openlore/examples/bmad/tasks/    _bmad/openlore/tasks/
cp -r /path/to/openlore/examples/bmad/templates/ _bmad/openlore/templates/

# Architect sidecar (loaded automatically by the Architect agent)
mkdir -p _bmad/_memory/architect-sidecar
cp /path/to/openlore/examples/bmad/agents/architect.md \
   _bmad/_memory/architect-sidecar/openlore.md
```

### 4. Install the Architect agent customization

```bash
cp /path/to/openlore/examples/bmad/setup/architect.customize.yaml \
   _bmad/_config/customizations/architect.customize.yaml
```

This customization does two things:
- Sets `hasSidecar: true` on the Architect agent
- Adds a `Load COMPLETE file` directive pointing to `openlore.md`

### 5. Recompile BMAD agents

```bash
npx bmad-method install
```

The compiled Architect agent now automatically loads the openlore instructions
at session start. **No manual step needed in the conversation.**

### 6. Index your codebase (run once, then after major changes)

```bash
openlore analyze   # builds call graph + risk index (~2–5 min)
openlore generate  # generates OpenSpec specs from the analysis
```

### 7. Start your first architecture session

Open the BMAD Architect agent in your IDE. It will automatically:
1. Load the openlore sidecar instructions
2. Begin with Phase 0 — Structural Reality (MCP calls)
3. Produce `docs/architecture.md` with a "Structural Reality" section

---

**Optional: dev-brownfield fallback**

`agents/dev-brownfield.md` is a fallback for when the architecture phase was skipped
and stories have no `risk_context`. Install it the same way:

```bash
mkdir -p _bmad/_memory/dev-sidecar
cp /path/to/openlore/examples/bmad/agents/dev-brownfield.md \
   _bmad/_memory/dev-sidecar/openlore-fallback.md
```

Remove it once the Architect has annotated all stories.

---

## File Reference

### Agent Extensions

| File | Phase | Purpose |
|---|---|---|
| `bmad/agents/architect.md` | Architecture | Structural reality check before design; epic risk assessment |
| `bmad/agents/dev-brownfield.md` | Implementation *(optional)* | Fallback gate when stories have no `risk_context` |

### Tasks

| File | Phase | Who | Purpose |
|---|---|---|---|
| `bmad/tasks/onboarding.md` | **Architecture** | Architect | One-time structural baseline — run before first sprint |
| `bmad/tasks/sprint-planning.md` | **Planning** | SM / Architect | Per-sprint risk matrix, conflict detection, story ordering |
| `bmad/tasks/implement-story.md` | Implementation | Dev | Story implementation with pre-filled risk context |
| `bmad/tasks/refactor.md` | Implementation | Dev | Safe refactor when risk ≥ 70 blocks a story |

### Templates

| File | Purpose |
|---|---|
| `bmad/templates/story.md` | Story template with `risk_context` section (pre-filled by Architect) |

---

## Workflow

### Normal story (low-risk codebase area)

```
Story → orient → analyze_impact (risk < 40) → implement → check_spec_drift → done
```

### Story touching a risky function (risk 40–69)

```
Story → orient → analyze_impact (risk 40–69) → implement with care → check_spec_drift → done
```

### Story blocked by high-risk function (risk ≥ 70)

```
Story → orient → analyze_impact (risk ≥ 70)
                      │
                      ▼
              brownfield-refactor task
                      │
                      ▼
              riskScore < 70?
                      │
                      ▼
              return to story → implement → check_spec_drift → done
```

---

## Integration with OpenSpec

openlore generates OpenSpec specifications (`openspec/`) from brownfield code.
Once generated, BMAD's architecture agent and PM agent can read these specs to understand
the existing system before planning new stories.

Key spec files after onboarding:

```
openspec/
├── specs/
│   ├── overview/spec.md         ← system summary for PM / Architect agents
│   ├── architecture/spec.md     ← risk register + structural notes
│   └── {domain}/spec.md         ← per-domain requirements
```

The `search_specs` and `get_spec` MCP tools let dev agents query these specs
during story implementation without leaving their context window.

---

## openlore MCP Tools Used by BMAD Tasks

| Tool | Used in | Purpose |
|---|---|---|
| `analyze_codebase` | onboarding | Build/refresh call graph |
| `orient` | implement-story | Map story to functions in one call |
| `analyze_impact` | implement-story, refactor | Risk score + blast radius |
| `get_architecture_overview` | onboarding | Domain clusters + hubs |
| `get_refactor_report` | onboarding, refactor | High-priority refactor candidates |
| `get_duplicate_report` | onboarding, refactor | Clone groups |
| `suggest_insertion_points` | implement-story, refactor | Where to add code |
| `get_subgraph` | implement-story, refactor | Call neighbourhood (Mermaid) |
| `get_function_skeleton` | implement-story | Noise-stripped file view |
| `search_specs` | implement-story | Find relevant requirements |
| `get_spec` | implement-story | Read full domain spec |
| `check_spec_drift` | implement-story | Post-implementation verification |
| `get_low_risk_refactor_candidates` | refactor | Safe extraction targets |
| `get_mapping` | refactor | Dead code / naming alignment |

---

## Troubleshooting

### `orient` returns 0 results

Check the response shape first. An `emptyResult` field means the index is healthy but the task
tokens matched no repository symbol. Follow its bounded near-token receipt, then try the suggested
identifier-style `search_code` or `get_map` call.

If the response instead has `notReady: true`, the analysis cache is missing. Run:

```bash
openlore analyze
```

Or via MCP:
```xml
<use_mcp_tool>
  <server_name>openlore</server_name>
  <tool_name>analyze_codebase</tool_name>
  <arguments>{"directory": "$PROJECT_ROOT", "force": true}</arguments>
</use_mcp_tool>
```

### `search_specs` returns "index not found"

The semantic index is missing. Run:

```bash
openlore analyze --embed
```

### `check_spec_drift` shows many `uncovered` files

OpenSpec has not been generated yet. Run:

```bash
openlore generate
```

### Risk scores are unexpectedly high everywhere

This is a brownfield signal — the codebase has accumulated complexity. Start with the
`brownfield-onboarding` task to build a risk register and identify which areas are safe
to work in without first refactoring.
