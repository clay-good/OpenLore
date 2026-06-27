# PR-review surface: put the deterministic briefing where humans already look

> Status: IMPLEMENTED (2026-06-23, PR #188). `openlore review` (src/cli/commands/review.ts), the bundled GitHub Action (.github/actions/openlore-review/), and the copy-paste workflow ship. Decision 4f3efb11; canonical cli spec requirements appended. Note: computeBlastRadius already folds change-scoped drift in, so review composes structural_diff + blast_radius (not a separate detectDrift).
>
> Status: PROPOSED (2026-06-22). New CLI surface (`openlore review`) + a bundled GitHub Action.
> Pure orchestration of three analyses that already ship: `structural_diff`
> (`src/core/services/mcp-handlers/structural-diff.ts`), `blast_radius`
> (`src/core/services/mcp-handlers/blast-radius.ts`), and spec/ADR/memory drift
> (`detectDrift`, `src/core/drift/index.ts`). No new structural computation, no LLM, no new MCP tool.

## Why

OpenLore's unique value is deterministic structural conclusions about a change. Today that value is
reachable in exactly one way: an agent decides to call an MCP tool. That is a narrow, opt-in,
invisible channel. The complementary truth is that **everyone opens pull requests**, and a PR is the
single highest-visibility checkpoint in the daily engineering loop — reviewed by humans, gated by CI,
seen by the whole team.

Posting a deterministic comment on every PR —

> **OpenLore structural review** — this change removed `gamma` (2 callers now dangling), changed
> `alpha`'s signature (5 callers are now stale), crosses 3 layers, touches the `validateDirectory`
> hub (58 callers). Run these 3 tests: `a.test.ts`, `b.test.ts`, `c.test.ts`. Decision `ADR-12`
> governs this code; the `auth` spec will go stale.

— takes OpenLore's distinctive output and drops it into a workflow that needs no agent, no MCP setup,
and no behavior change from the developer. This is plausibly OpenLore's best distribution channel:
the value shows up unprompted, in front of a human, exactly when it is actionable.

## What changes

1. **A deterministic markdown briefing.** A new renderer composes the three existing analyses for a
   `base..head` range into one Markdown document: the structural delta (added/removed/signature-changed
   symbols + stale callers), the blast radius (hubs, layers crossed, governing decisions, tests to
   run), and drift (specs/ADRs/anchored memories the change will make stale). The same conclusion-shaped
   content `blast_radius` already produces, rendered for a human reader.

2. **A CLI entry point: `openlore review`.** Mirrors the established `blast-radius` / `drift` command
   shape: `--base <ref>`, `--head <ref>`, `--format markdown|json` (default `markdown`), `--out <path>`.
   It runs the three analyses over the resolved diff and prints the briefing. This is the unit the CI
   surface and any other integration call.

3. **A bundled GitHub Action.** A reusable workflow / composite action (`.github/actions/openlore-review`)
   that, on `pull_request`, runs `openlore review --base <pr.base.sha> --head <pr.head.sha>` and posts
   the result as **one sticky PR comment** — created on first run, updated in place on every subsequent
   push (matched by a hidden `<!-- openlore-review -->` marker), never duplicated. The repo ships the
   action and a copy-paste `pull_request` workflow; adopting it is one file.

4. **Advisory by default; opt-in gating.** The Action posts the briefing and **exits 0** — it informs,
   it does not fail the check. A repo MAY opt into failing the job on a configured high-severity finding
   (e.g. a removed symbol with live callers, or an orphaned governing decision), reusing the same
   `.openlore/config.json` block-pattern convention `blast_radius` already defines. Default posture is
   inform, never gate — consistent with the lean/opt-in direction (`add-lean-default-tool-surface`).

5. **Degrades honestly.** Outside a git range, with no analysis index, or on a shallow CI checkout, the
   briefing states what it could not compute (e.g. "no index — run `openlore analyze`"; "shallow
   checkout — base unreachable") rather than failing silently or emitting a misleading empty briefing.

## What does NOT change

- **No new MCP tool.** The MCP surface is untouched; the lean default stays the same size. This is a
  CLI + CI surface over analyses that already exist.
- **No new structural computation, no LLM.** `openlore review` is pure orchestration of
  `structural_diff`, `computeBlastRadius`, and `detectDrift` — the same determinism guarantee those
  carry (north star `c6d1ad07`).
- **No always-on blocking gate.** Advisory by default; opt-in gating only, per configured pattern.
- **No new git plumbing.** Reuses `getChangedFiles` / `resolveBaseRef` / `validateGitRef`
  (`src/core/drift/git-diff.ts`).

## Research basis

This generalizes the project's own proven pattern — a deterministic check at a natural checkpoint (the
decisions pre-commit gate; the `blast_radius` advisory hook) — from the *pre-commit* moment to the
*pull-request* moment, which is where review actually happens and where the audience is human. The
"one sticky comment, updated in place" convention is the well-established idiom of CI review bots
(coverage, bundle-size, danger-style bots); OpenLore's differentiator is that the content is a
deterministic structural conclusion, not a heuristic lint.

## Application to OpenLore

- **Structural delta** reuses `handleStructuralDiff` (`structural-diff.ts:64`) — added/removed/
  signature-changed symbols, stale callers, rename candidates, soundness posture.
- **Blast radius** reuses `computeBlastRadius` (`blast-radius.ts:133`) — hubs, layers, governing
  decisions, tests to run, memory/spec drift, all already conclusion-shaped.
- **Drift** reuses `detectDrift` (`src/core/drift/index.ts:13`) — stale/gap/uncovered/ADR/memory
  issues with severities.
- **Git range** reuses `resolveBaseRef` (`git-diff.ts:183`, fallback chain requested → main → master
  → HEAD~1) and the `validateGitRef` argument-injection guard (`git-diff.ts:166`).
- **JSON/markdown emission** follows the `--json` stdout / human-stderr split already used by
  `blast-radius` and `drift`; the human renderers (`renderHeadline`, `renderHuman` in `blast-radius.ts`)
  are the precedent for a `renderMarkdown` sibling.
- **Sticky comment + config gating** reuse the `.openlore/config.json` block-pattern convention from
  `blastRadius.block` and the idempotent hook-management pattern (`--install-hook` / marker block).

## Out of scope

- **A hosted GitHub App** (centralized service, OAuth, webhooks). The first cut is a self-hosted CI
  Action running in the user's own runner with `GITHUB_TOKEN` — zero infra, zero data leaving the
  repo, consistent with local-first. A hosted App can come later as a thin layer over `openlore review`.
- **Posting on non-GitHub forges** (GitLab MR notes, Bitbucket). `openlore review` emits the briefing;
  forge-specific posting is a thin adapter. GitHub ships first because it is where the project lives.
- **Auto-fixing** flagged risks. The briefing informs; the human/agent acts.
- **Inline line-level comments.** First cut is one sticky summary comment; line anchoring is a later
  refinement.

## Design decisions (record before coding)

- **One sticky comment, not per-push comments.** Matched by a hidden HTML marker; updated in place.
  Avoids comment spam, the single most common reason review bots get muted.
- **`openlore review` is the seam, the Action is a thin wrapper.** All composition/rendering lives in
  the CLI so the value is reachable from any CI, any forge, or a local `openlore review` run — the
  Action only does checkout + invoke + post.
- **Advisory default, opt-in gating** via the existing `blastRadius.block` convention — no second
  config dialect.
- **Markdown is the default format**, JSON behind `--format json` for programmatic consumers.
