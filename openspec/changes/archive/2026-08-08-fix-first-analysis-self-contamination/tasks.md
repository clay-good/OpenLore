# Tasks — fix-first-analysis-self-contamination

## Implementation

- [x] Expose the managed-file set: install already writes fingerprints (`_openlore.managed`,
      managed-block markers) — add a small shared predicate `isEntirelyOpenLoreManaged(path,
      content)` in a dependency-light module both install and the analyzer import
- [x] Exclude entirely-managed files from cluster membership, language ranking
      (`analyze.ts:575` reads `repoMap.summary.languages`), and key-file/high-value selection;
      keep them in raw file inventories labeled as tooling
- [x] Fix `suggestDomainName` fallback (`dependency-graph.ts:630-633`): validate the derived
      name (leading alphanumeric), and label non-structural root-config clusters with a fixed
      honest name instead of first-file coincidence
- [x] Add the undomained disclosure to `repo-structure.json` for source files with call-graph
      nodes that land in no domain; render it in the analyze summary when non-empty
- [x] Regression tests: (a) install-then-analyze fixture — no `-`-prefixed domain, Python
      present in languages, managed files not high-value; (b) a real user `AGENTS.md` still
      counts; (c) lone-script disclosure

## Verification

- [x] Re-run the first-run e2e on the sandbox shape (2 TS files, 1 Python script, install
      first): summary shows Python, no `mcp` domain, no silent absence of `scripts/report.py`
