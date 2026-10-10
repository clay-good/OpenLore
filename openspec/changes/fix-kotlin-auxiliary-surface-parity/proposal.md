# Close the small places that handle Java and forget Kotlin, and keep them closed

> Status: PROPOSED (2026-10-10, issue #546). Part of `KOTLIN-TOTAL-SUPPORT-2026-10.md`.
> Deterministic, no LLM, no new dependency.

## What you get

Kotlin behaves like its JVM sibling in the supporting code paths, and a test stops the next
language list from leaving it out.

## What is wrong today

Each of these is a hand-written language or extension list that includes Java and not Kotlin:

| Place | Effect on Kotlin |
|---|---|
| `cli/commands/decisions.ts:162` `SOURCE_EXTS` | the decisions commit gate does not treat a `.kt` change as a source change |
| `analyzer/bounded-file-scan.ts:118-122` `SCANNED_SOURCE_EXTENSIONS` | oversized Kotlin files are not disclosed by the inventory scans |
| `analyzer/ast-chunker.ts:45-106` | Kotlin is chunked on blank lines, not on declarations, for search |
| `analyzer/code-shaper.ts:30-52` | log statements are not stripped (`println`, `logger.info { }`, `Log.d`) |
| `analyzer/extraction-worker.ts:45-55` `PROBES` | no worker-pool grammar probe |
| `analyzer/call-graph.ts:648-658` `getKotlinParser` | the grammar `import` in this second loader is unguarded (Java uses `loadCoreGrammarSoft`); it serves the inheritance and event passes |
| `analyzer/import-resolver-bridge.ts:831-842` | legacy JVM import helper matches `<Name>.java` only |
| `cli/commands/mcp.ts:952`, `:986` | the `language` filter descriptions of `search_code` and `suggest_insertion_points` omit Kotlin |
| `docs/mcp-tools.md:281`, `cli/commands/mcp.ts:1441` | claim "junit (Java/Kotlin)" while the output is Java |

The same pattern produced most of the larger gaps in this change set.

## What changes

**1. Fix each row.** Kotlin is added, or the helper is routed through the canonical language map so
no hand list remains. The optional-grammar import fails soft with the existing one-warning receipt.

**2. A parity guard.** A structural test scans `src/` (tests excluded) for language-name and
extension collections. Any collection that contains Java or `.java` must also contain Kotlin or
`.kt`, or be named in an exemption table in the test with a one-line reason. The exemption table is
the reviewable list of deliberate Java-only behavior (for example, the Java declaration scanner).

**3. Chunking.** Kotlin joins AST chunking with declaration-level chunks (class, object, function,
property with accessor).

**4. Log stripping.** Kotlin patterns are added to the shaper: `println`, `print`, SLF4J and
kotlin-logging calls (`logger.info { }`, `log.debug(...)`), and Android `Log.*` and `Timber.*`
calls.

## Not in scope

- The same guard for other language pairs (C# / Java, Scala / Java). The guard is written so a pair
  can be added by one table row.

## Impact

- The files in the table, plus one new guard test beside `doc-claim-sync.test.ts`.
- Specs: `analyzer`, 1 ADDED requirement.
- Risk: the guard will fail on first run for sites this audit missed. That is its purpose; each is
  fixed or exempted in the same PR.
