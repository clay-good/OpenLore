# Proposal

## Why

Two problems, one about trust and one about recall.

1. **Agents read keyword mode as "worse."** Every keyword `orient`/`search` answer carries
   *"Keyword (BM25) search … For semantic ranking, run `openlore embed --local`."* An agent repeated
   it as *"plain keyword matching instead of semantic search, so I also checked … with grep."* The
   note is aimed at a human, but the agent is the one that reads it. The `config` spec already says
   keyword mode is first-class and must not be framed as degraded.
2. **Semantic retrieval is opt-in.** The local embedder (PR #191) needs no key and no endpoint. Its
   package is already an `optionalDependency`, so a normal install has it. It still needs a manual
   `openlore embed --local`. Nothing in this repository measures whether it beats keyword plus
   vocabulary expansion on real agent queries, so turning it on by default is an untested
   assumption.

## What Changes

- **Now, independent of the rest:** agent-facing payloads (`orient`, `search_code`, `search_specs`,
  `suggest_insertion_points`, the inject block) drop the upgrade hint. They report `retrievalMode`
  only. The hint moves to `openlore status` and `openlore doctor`, where a human reads it.
- **Measure:** add a retrieval benchmark: fixed task queries with known target symbols, on this repo
  and on two dogfood corpora. It reports recall@5 and MRR for `keyword+vocabulary` and for
  `local-semantic`, and the index build time and disk cost.
- **Then, only if local semantic wins:** recall@5 must be up at least 5 points, with no regression
  on any corpus. In that case, auto-init and `install` build the keyword index first, serve it, and
  add local vectors in the background when the optional package is present. Answers switch to
  `local-semantic` once the vectors land. If the package or the model download is missing, keyword
  stays, with no error and no note. `embedding.provider: "none"` and `--no-embed` opt out.
- If the benchmark does not show a win, the default stays keyword, and the result is recorded in
  `docs/semantic-search.md`.

## Measured (2026-10-31)

`bench/retrieval/` (results: `bench/retrieval/results/2026-10-31.json`), queries asked through
`orient`:

| Corpus | Queries | recall@5 keyword+vocabulary → local-semantic | MRR | Build |
|---|---|---|---|---|
| OpenLore | 26 | 46.2% → 61.5% | 0.369 → 0.467 (0.442 after the speedup) | 31 s → 438 s (50 s after) |
| gridprims | 17 | 82.4% → 94.1% | 0.801 → 0.865 | 7 s → 57 s (10 s after) |
| roughlogic.com | 16 | 43.8% → 50.0% | 0.446 → 0.415 (0.414 after) | 19 s → 108 s (30 s after) |
| All | 59 | 55.9% → 67.8% (+11.9) | 0.514 → 0.567 | |

Recall@5 is up 11.9 points and up on every corpus, so the threshold is met and the background pass
ships. The gain is on paraphrase queries. On roughlogic.com, MRR fell and one exact-identifier query
left the top 5. The index is 5–16 MB larger.

## Capabilities

### Modified Capabilities

- `config`: adds `RetrievalUpgradeHintsAreForHumans`, `AnExplicitKeywordChoiceAlwaysWins` and
  `LocalSemanticIsBuiltInTheBackgroundWhenItMeasurablyHelps`.

## Impact

- Code: the `note` fields in `src/core/services/mcp-handlers/orient.ts` and `semantic.ts`;
  `status-report.ts`, `doctor.ts`; a new `bench/retrieval/` harness; the background vector pass in
  the repair builder.
- Cost if enabled: one model download (about 23 MB, cached under `~/.openlore/models`) and CPU
  time for embedding after each full build. It is measured by the benchmark before the decision.
