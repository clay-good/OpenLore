# Align first-run CTAs with the repo's shape: never advertise a command that will fail on this repo

> Status: PROPOSED (2026-07-27, first-run e2e). The install epilogue tells every new user:
> *"Does it pay off?: Run `openlore prove --estimate`…"*. On the repo install had just indexed,
> that command exits with `[error] Could not derive orientation tasks — the call graph is too
> sparse (need functions with ≥2 callers). Try a larger repo.` The user's first suggested action
> fails on the tool's own advice, one minute into the product. Two sibling messages have the same
> shape: a warning about an empty `openspec/specs` directory that **install itself just
> created**, and an uninstall that silently keeps `.openlore/`.

## The gap

All reproduced on a clean 5-function repo with `node dist/cli/index.js`:

- **The prove CTA is unconditional; the command's precondition is not.** Install prints the
  `prove --estimate` pointer in its epilogue for every repo. `prove` requires functions with ≥ 2
  callers to derive orientation tasks. Install has the just-built graph in hand when it prints
  the epilogue — it can know the CTA will fail, and prints it anyway. The failure message names
  neither the measured value nor the threshold ("too sparse" — how sparse? need how many?), and
  "Try a larger repo" is a dead end for a user evaluating on the repo they have.
- **A first-run warning points at self-created emptiness.** Analyze warns: `⚠ Spec index
  skipped: Spec directory …/openspec/specs exists but contains no spec.md files — run 'openlore
  generate'…`. On a fresh install that directory exists *because install created it seconds
  earlier*. A normal, expected state (no specs yet) is presented as an anomaly the user caused,
  with a CTA (`generate`) that then requires an LLM key or agent-CLI provider — a second
  precondition the message doesn't mention.
- **Uninstall doesn't say what it keeps.** `install --uninstall` cleanly restores every wired
  file (verified: CLAUDE.md byte-identical, hooks stripped, user permissions preserved) but
  leaves `.openlore/` — index, decisions, memories — with no mention. A user "removing OpenLore"
  is not told their repo still contains its data directory or how to remove it.

This is deliberately a small, cohesive change: the first-run message surface only. It does not
touch prove's estimator, the spec pipeline, or uninstall's (correct) choice to preserve data.

## What changes

- **CTAs are gated on their own preconditions.** The install epilogue checks the just-built
  graph before advertising `prove --estimate`; when the precondition fails, it either omits the
  pointer or states why it doesn't apply here ("repo too small for a measured projection: N
  functions have ≥2 callers, M needed").
- **Prove's precondition failure carries a receipt.** When `prove --estimate` refuses, it names
  the measured value and the threshold, and suggests the applicable alternative (run it on a
  larger repo, or skip — nothing is wrong).
- **Fresh-install emptiness is phrased as the normal state.** When the empty `openspec/specs`
  was created by this install/init (install knows), the spec-index message becomes an
  informational "no specs yet — optional: `openlore generate` (needs an LLM provider; see
  `openlore features`)", not a warning.
- **Uninstall discloses what it keeps.** The uninstall summary ends with the kept paths
  (`.openlore/` — index, decisions, memories) and the one-liner to remove them.

## Impact

- Affected specs: `cli`
- Affected code: `src/cli/install/index.ts` (epilogue gating, uninstall summary),
  `src/cli/commands/prove.ts` (receipted refusal), the analyze/index spec-index skip message
