# Spec link index — deterministic requirement→code mapping

OpenLore derives requirement→code links from **anchors you write in your specs**,
resolved against the current analysis graph. There is no LLM call, no embedding
lookup, and no name-similarity guess anywhere in this path: coverage is an
*observation*, not an inference.

This replaced the previous LLM-pipeline-owned `mapping.json`, whose links came
from a probabilistic matcher and whose absence made spec **Repair** unusable until
you had first paid for a full generation run.

## Writing an anchor

Put one implementation anchor under each requirement:

```markdown
### Requirement: Sessions Expire After Inactivity

The system SHALL invalidate a session after 30 minutes of inactivity.

- **Implementation**: `expireSession::src/auth/session.ts`
```

Accepted forms:

| Form | Meaning |
|------|---------|
| `symbolName::path/to/file.ts` | The house `name::path` convention used by the navigation tools |
| `path/to/file.ts#symbolName` | The familiar document-fragment form |
| `symbolName` | Exact symbol name, resolved graph-wide |
| `Class.method` | A dotted member identity — shaped exactly like `utils.py`, so it links only when the graph holds that exact name; otherwise it stays file-footprint evidence |
| `path/to/file.ts` | **File only** — domain-footprint evidence, never function coverage |

Anchors are read only from an `- **Implementation**:` line inside a requirement
block (and its indented continuation lines). Prose and scenario code spans are
never treated as anchors, so narrative can never invent coverage.

## Link states

| State | Meaning |
|-------|---------|
| `linked` | Every exact anchor resolved to exactly one symbol in the graph |
| `ambiguous` | An anchor matched several symbols — candidates are disclosed, **none is selected** |
| `stale` | An anchor names a symbol that no longer exists — same-name symbols elsewhere are disclosed as candidates, not auto-selected |
| `type-only` *(anchor state)* | The anchored name **exists but is a type**. Types are outside what coverage measures, so no coverage is claimed — but nothing is missing either, and the type's location is disclosed. A requirement anchored only to types is `unmapped`, never `stale` |
| `unmapped` | The requirement carries no exact symbol anchor at all |

A file-only anchor contributes to the domain footprint and to nothing else:
citing `src/auth/session.ts` does not make every function in that file covered.

## `mapping.json` is a cache, not a prerequisite

`openlore mapping refresh` persists the index to `.openlore/analysis/mapping.json`
with provenance binding the analysis generation **and** a digest of the parsed
specs. Any of these makes the cache unusable, and none of them is fatal:

- the file is absent
- it is a legacy (v1/v2) probabilistic artifact
- it is not valid JSON
- a spec was edited, or the analysis was rebuilt

In every case `audit` and `prepare_spec_repair` re-derive the index **in memory**
and report where the evidence came from:

```json
"mappingCoverage": { "state": "available", "source": "derived", "cacheReason": "mapping-not-generated" }
```

## Coverage availability is binary

`mappingCoverage.state` is `available` or `unavailable`. When it is `unavailable`,
every mapping-dependent metric is `null`:

```json
"summary": {
  "totalFunctions": 812,
  "coveredFunctions": null,
  "coveragePct": null,
  "uncoveredCount": null
}
```

**`null` means "not established". Numeric zero means an observed count of zero.**
Branch on `state` before doing arithmetic — this is a deliberate schema change,
because the previous behavior reported unusable evidence as `0`, which dashboards
and agents read as a real measurement.

Stable reasons: `mapping-not-generated`, `invalid-json`, `incompatible-provenance`,
`fingerprint-mismatch`, `scoped-artifact`, `analysis-unavailable`, `specs-unavailable`.

Coverage is unavailable only when an **input** is missing — no analysis, or no
specs. An unusable cache alone never costs availability.

## Commands

```bash
openlore mapping refresh                    # rebuild and persist the index
openlore mapping refresh --json             # full index as JSON
openlore mapping refresh --strict-ambiguity # exit nonzero if any anchor is ambiguous
openlore audit                              # coverage gaps from that index
```

`mapping refresh` exits 0 for any honest index — including one full of unmapped
requirements, which is a finding, not a failure. It exits nonzero only for an
unusable input, or under `--strict-ambiguity`.

## Migration from a v1/v2 artifact

Old `mapping.json` files are safe to delete. They are never converted: their links
came from LLM, semantic, and name-similarity matching that this schema refuses to
treat as coverage. They are reported as `incompatible-provenance` and rebuilt.

Legacy specs with only file-level `> Source files:` headers will report as
`unmapped` rather than covered. That is the honest answer — add per-requirement
anchors to establish real coverage. The bundled `openlore-generate` and
`openlore-repair` skills write them automatically for anything they author.
