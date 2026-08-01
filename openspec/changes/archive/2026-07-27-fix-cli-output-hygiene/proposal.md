# CLI output hygiene: color contract, config errors, honest summaries, one vocabulary

> Status: SHIPPED (2026-07-18). All six gaps fixed, each with a regression test. Notes on how it
> landed: (1) color now flows through a shared layer `src/utils/colors.ts` (chalk-backed,
> `--no-color`/non-TTY aware) — `decisions.ts` and the `--insecure` warning in `index.ts` moved off
> raw ANSI, and the already-gated `doctor.ts`/`features.ts` were converted too so the repo-wide
> guard (`src/cli/output-hygiene.test.ts`) needs only one exemption: the full-screen interactive
> `tui-approval.ts`. (2) An explicit `--config` that can't be read is fatal (`src/cli/config-guard.ts`,
> unit-tested); this scopes to fatal-on-missing — fully redirecting every `readOpenLoreConfig` call
> site to an arbitrary path stays out of scope. (3) `doctor`'s summary now names the checks that
> actually warned. (4) CLI hints translate MCP tool names to CLI commands via
> `src/cli/surface-vocabulary.ts` (`analyze_codebase` → `openlore analyze`). (5) `decisions --list`
> renders `verified` as `⧖` "awaiting review" with a legend, distinct from approved/synced.
> (6) Cosmetics: the LanceDB native-log knob is `LANCEDB_LOG` (NOT `RUST_LOG`, verified empirically) —
> defaulted to `error` before the first addon import at both call sites; export prints an absolute
> path instead of a `../../..` chain when the artifact lands outside the repo; `init` detects a
> pure-TS project (`tsconfig.json`, no `package.json`); `manifest emit` gains `--dry-run`.

## The gaps (all live-reproduced, v2.1.5)

| # | Defect | Evidence |
|---|---|---|
| 1 | `decisions --list` emits raw `\x1b[…m` literals, ignoring `--no-color` and non-TTY — pollutes pipes and CI logs | `decisions.ts:383-392`; `--no-color decisions --list \| cat -v` shows `^[[33m` |
| 2 | Global `--config <path>` with a nonexistent file is **silently ignored**; the run proceeds on defaults (e.g. without the user's enforcement policy) | `--config /nonexistent/config.json orient "x"` → exit 0, no warning |
| 3 | `doctor`'s summary line is hardcoded to one warning kind: an index-staleness warning is summarized as "optional features (LLM generate, embeddings) may be limited" | live `doctor` run |
| 4 | CLI error hints leak MCP vocabulary: `find-clones`/`error-propagation` unknown-symbol hint says "Run `analyze_codebase` first" — no such CLI command (should be `openlore analyze`) | live repro |
| 5 | `decisions --list` renders status `verified` — the state that **blocks the commit gate awaiting human review** — with a ✓ glyph, no legend; `●`/`✔`/`✓` near-indistinguishable | `decisions.ts:376-380`; all 14 store decisions currently verified yet reading as "done" |
| 6 | Cosmetics: raw Rust `lance` WARN lines leak into `analyze` output; `export bundle` prints a `../../../../..`-style destination; `init` reports "Project type: Unknown" on a pure-TS fixture; `manifest emit` writes `.well-known/openlore.json` into the repo with no `--dry-run` | live repros |

## What changes

1. Route `decisions --list` rendering through the logger/chalk path every other command uses;
   add a repo-wide guard test that greps `src/cli` for raw `\x1b[` literals.
2. `--config` pointing at a missing/unreadable file is a **fatal error** naming the path (a user
   who asks for a specific config never silently gets another one).
3. `doctor` derives its summary from the actual warnings it emitted (each check contributes its
   own summary fragment); no hardcoded closing line.
4. One vocabulary rule with a guard: CLI output refers to CLI commands, MCP output refers to MCP
   tools; the shared not-found hint templates take the surface as a parameter.
5. `decisions --list` gets distinct glyphs plus a one-line legend, with `verified` explicitly
   rendered as "awaiting review" (visually distinct from approved/synced).
6. Cosmetics: silence/scope the `lance` logger noise on the analyze path, print absolute (or
   repo-relative) export destinations, `init`'s project-type detection covers the plain-TS case,
   `manifest emit` gains `--dry-run` and prints what it writes.

## Why this is in scope

The `refine-happy-path-and-defaults` change made "legible surface" a shipped requirement; these
are the residuals a full-surface dogfood found. Each fix is small; the guards (ANSI-literal grep,
vocabulary parameter) keep them fixed.

## Impact

- `decisions.ts`, global config loading, `doctor`, shared hint templates, `analyze` logging,
  `export`/`init`/`manifest` touch-ups; regression tests per fix.
- Specs: `cli` — 1 ADDED requirement (OutputContractsAreUniform).
- Risk: none beyond output changes; `--config` fatal-on-missing is a deliberate behavior change,
  disclosed in CHANGELOG.
