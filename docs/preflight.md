# `openlore preflight`

A non-zero-exit staleness gate for CI: have files relevant to this PR been edited in ways that would invalidate `orient()` answers? Run it on every pull request to catch out-of-date analysis graphs at the cheap boundary, instead of letting them silently degrade agent runtime.

## What it checks

OpenLore persists a SQLite call graph (`.openlore/analysis/call-graph.db`) plus a `fingerprint.json` recording when the graph was built. `preflight` compares the working tree against that snapshot and reports a structural staleness score.

| Check | Done by |
|---|---|
| Have source files changed since the graph was built? | `git diff` (preferred) or file mtime fallback |
| Are the changed files structurally important (hubs vs leaves)? | Lookup in `nodes` table |
| Is the cumulative score over the threshold? | Configurable via `--max-staleness` |

## What it does NOT check

`preflight` is **structural staleness only**. It does not check:

- **Spec drift** — when code outpaces the documentation in `openspec/`. That's the existing [`openlore drift`](../README.md) command's job. Run that separately.
- **Embedding/vector freshness** — the semantic search index is rebuilt by `openlore analyze --embed`, not addressed here.
- **Decision-log staleness** — pending decisions live in their own gate (see CLAUDE.md). `preflight` doesn't read them.

If you want a "block PR until everything is current" gate, chain `openlore preflight` and `openlore drift` in CI.

Preflight *detects* a stale index; to *bootstrap* a fresh one quickly (instead of cold-indexing on every run), import a committed graph bundle — see [shareable-bundle.md](shareable-bundle.md).

## Usage

```
openlore preflight [--fix] [--json] [--since <ref>] [--max-staleness <n>]
```

| Flag | Meaning |
|---|---|
| `--since <ref>` | Diff against this git ref (e.g. `origin/main`). CI-friendly: scopes to "what this PR changed." |
| `--max-staleness <n>` | Threshold above which the gate fails. Default `0` (any structural change to an in-graph file fails); `5` is a sensible "permissive" setting. |
| `--fix` | If stale, run `openlore analyze` then re-check. Exits 0 if the fix succeeds. |
| `--json` | Machine-readable output; see schema below. |

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Fresh — graph is current relative to the working tree. |
| `1` | Stale — staleness score exceeds threshold. |
| `2` | Error — no graph found, invalid `--since` ref, file-system failure, etc. |

## Sample output

```
OpenLore preflight
──────────────────
Graph built:   2026-04-12T10:11:08.000Z   commit 3a91f02
Working tree:  2026-04-12T15:24:31.000Z   commit 7d8e1b4
Changed files: 7 (3 hub, 4 leaf)
Staleness:     score 11 (threshold 0)
Status:        STALE — run `openlore analyze` or re-run with --fix

Changed:
  - src/core/services/llm-service.ts  (hub, fan-in 38, weight 6)
  - src/core/services/chat-agent.ts   (hub, fan-in 14, weight 5)
  - src/cli/commands/verify.ts        (fan-in 3, weight 2)
  - src/cli/commands/generate.ts      (weight 1)
  ...
```

Lines are sorted by weight (DESC) so the files most likely to invalidate `orient()` answers surface first. New/untracked files are shown with `(new/untracked, weight 0)` and never contribute to the score.

When there are no changed files at all (e.g. a docs-only PR after a fresh analyze), the Status line reads `FRESH — nothing to check` so it's obvious the gate passed because there was nothing to verify, not because everything was verified clean.

## How the staleness score is computed

```
per-file weight =
  1                                base
  + 2 if any node in the file is a hub (high fan-in node)
  + min(3, ceil(maxFanIn/5))       contribution scaled by how many
                                    other functions depend on this file

staleness_score = sum(per-file weight) across changed files that map
                  to nodes in the graph
```

- Files that **don't** appear in the graph (new/untracked files, build artifacts, docs) are **reported** but **do not** contribute to the score. We can't reason about them without re-analyzing.
- A hub change (something called from many places) is worth up to **6** weight units. A leaf change is worth **1**. A change to nothing-in-graph is **0**.
- The scoring is deliberately a heuristic — see [`src/cli/preflight/score.ts`](../src/cli/preflight/score.ts).

### Interpreting the score

| Score | Typical situation |
|---|---|
| `0` | Working tree changed only docs / build artifacts / new files. Re-analyzing would not change orient() answers. |
| `1–4` | One or two leaf-level changes. Often safe to defer the re-analyze. |
| `5–10` | Substantial leaf-level activity OR one hub touched. Re-analyze recommended. |
| `>10` | Multiple hubs touched or many connected files changed. Re-analyze required for orient() to remain trustworthy. |

## Wiring into CI

Drop-in templates live in [`examples/ci/`](../examples/ci/):

- [`openlore-preflight.yml`](../examples/ci/openlore-preflight.yml) — GitHub Actions
- [`openlore-preflight.gitlab.yml`](../examples/ci/openlore-preflight.gitlab.yml) — GitLab CI
- [`openlore-preflight.sh`](../examples/ci/openlore-preflight.sh) — generic shell snippet for any other system

All three run `openlore preflight --since <base-ref>` and exit non-zero on stale.

When the process detects `GITHUB_ACTIONS=true`, preflight additionally emits per-file [workflow-command annotations](https://docs.github.com/en/actions/using-workflows/workflow-commands-for-github-actions) — each stale file appears inline in the PR diff UI as a warning, and a top-level error annotation summarises the staleness score. No extra setup required; the GHA template above already runs in that environment.

## JSON schema (`--json`)

```jsonc
{
  // Required by the spec
  "status": "FRESH" | "STALE" | "ERROR",
  "graph_built_at": "2026-04-12T10:11:08.000Z" | null,
  "graph_commit": null,                              // TODO(spec-03-followup)
  "working_commit": "7d8e1b4" | null,
  "changed_files": ["src/foo.ts", "..."],
  "staleness_score": 11,
  "threshold": 0,

  // Additive extras (always emitted)
  "unknown_files": ["new-file.ts", "..."],           // weight-0 files (new/untracked, docs, etc.)
  "per_file": [                                      // sorted by weight DESC in human output;
    { "file": "src/foo.ts",                          // emitted in changed_files order here
      "weight": 6, "hub": true, "max_fan_in": 38, "unknown": false }
  ],
  "hub_count": 3,
  "leaf_count": 4,
  "mechanism": "git" | "mtime",                      // how the changed-files list was produced
  "warnings": []                                     // e.g. "no .git found — falling back to mtime"
}
```

`graph_commit` is currently always `null` — see `TODO(spec-03-followup)` in [`src/cli/preflight/index.ts`](../src/cli/preflight/index.ts). Once `openlore analyze` records the git HEAD at build time, this field becomes populated.

`per_file` lets CI scripts make per-file decisions without re-querying the graph (e.g. "only fail if a hub changed" → `jq '.per_file[] | select(.hub)'`).

## Edge cases

- **No `.git` directory:** falls back to mtime-based comparison; a warning appears in `warnings[]`.
- **Graph built against a commit no longer in the repo** (force-push / rebase): mtime fallback engages automatically.
- **`--since` ref does not exist:** exits 2 with a clear message.
- **Repo with no source files changed:** exits 0 with `nothing to check`.

## Performance

Designed to run in **under 5 seconds** on a warm SQLite for a repo of ~10k functions. The default path does not re-analyze; it only diffs and scores. `--fix` is the only path that re-runs the (currently full, not incremental) analyzer — see `TODO(spec-03-followup): incremental analyzer`.
