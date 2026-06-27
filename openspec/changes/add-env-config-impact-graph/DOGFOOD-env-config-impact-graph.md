# Dogfood — add-env-config-impact-graph (`analyze_env_impact`)

Date: 2026-06-26. Branch `feat/env-config-impact-graph`. Run on the OpenLore repo itself
(`node dist/cli/index.js env-impact …`) after `openlore analyze --no-embed` (7680 functions).

## A. Real env vars, real blast radius

### `ANTHROPIC_API_KEY` — per-site fallback is correct

```
9 read sites (8 required, 0 module-level) · 2 affected functions · 10 files · 0 tests
  src/core/services/chat-agent.ts:115  resolveProviderConfig   [has-fallback]
  src/core/services/llm-service.ts:1891 createLLMService        [required]
  …
blast radius (upstream callers): configureServer, runChatAgent
```

Verified against source:
- `chat-agent.ts:115` → `const anthropicKey = process.env.ANTHROPIC_API_KEY ?? '';` → **has-fallback** ✓
- `llm-service.ts:1891` → `const apiKey = process.env.ANTHROPIC_API_KEY;` → **required** ✓

The per-site classification is the value-add over the file-global flag the inventory carries: the same
var is a hard break at one site and soft at another, and the tool says so per site.

### `EMBED_MODEL` — a genuine "what breaks if I remove this" answer

```
3 read sites (2 required, 1 module-level) · 57 affected functions · 31 files · 3 tests
  src/cli/commands/embed.ts:84  (module-level)  [required]
  src/core/analyzer/embedding-service.ts:90  fromEnv  [required]
blast radius: resolveEmbedder → handleOrient / handleSearchCode / handleAnalyzeImpact / … (d2)
```

The backward walk correctly traces a config read through `resolveEmbedder` out to every MCP handler
that ranks semantically — exactly the blast radius a developer needs before touching the var.

### `DEBUG` — module-level reads dominate, disclosed

```
12 read sites (12 required, 7 module-level) · 95 affected functions · 37 files · 10 tests
```

7 of 12 reads are module-level (`const DEBUG = process.env.DEBUG` at file top). The summary surfaces
the count and a boundary explains the import-time blast radius is wider than the call-graph callers
listed. Honest, not silently dropped.

## B. Honesty paths

- `OPENLORE_LIVE_LLM` → **not-found** with a candidate list. It is read only in test files, which the
  env inventory excludes, so it is genuinely not in the production inventory — the tool says so with
  candidates rather than returning an empty "nothing reads it".
- `DATABASE_URL` → its only non-test read is a module-level read in an `examples/` fixture; the src/
  occurrences are all in `.test.ts` files (excluded by the inventory). The tool reports the one real
  read + the module-level boundary, not a false "6 reads".

## C. As-built notes

- **Scope is the inventory's non-test files.** The handler re-scans only the files the env inventory
  associates with a var; the inventory already excludes test files, so a var read *only* in tests is
  reported not-found (disclosed) rather than with test-only read sites. This is the intended,
  consistent scope (matches `get_env_vars`).
- **Read-site → function mapping is line-based** (`FunctionNode.startLine/endLine` containment,
  smallest span), which sidesteps the byte-vs-UTF-16-offset mismatch a regex `.index` would introduce
  on files with multibyte characters before a read. A read with no enclosing function is module-level.
- **Not-found candidate fallback:** a single-letter typo (`DATABSE_URL`) matches no substring, so the
  handler falls back to listing the inventory — the real var is always surfaced, never a dead end.

## D. Verification

- `npm run build` clean.
- `vitest run src examples`: 274 files, 5393 passed, 2 skipped.
- New tests: `env-extractor.test.ts` (read-site extractor, all 5 languages + determinism),
  `env-impact.test.ts` (resolve / not-found / module-level / missing-name / out-of-scope boundary).
- Guards updated: full-surface payload budget 82_000 → 84_000; documented tool count 71 → 72 across
  guarded docs (the `~N KB / ~Nk tokens` band check stays green).
