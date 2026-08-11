# Domain Docs

How the engineering skills should consume this repo's domain documentation when
exploring the codebase.

Layout: **single-context**. One context for the whole repository (a single TypeScript
package), with one ADR corpus.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root — **does not exist yet.** Proceed silently; don't
  flag its absence and don't scaffold one upfront. `/grill-with-docs` creates it lazily,
  once terms actually get resolved.
- **ADRs: `openspec/decisions/adr-*.md`** — *not* `docs/adr/`. This repo's ADRs are
  written by OpenLore's own `record_decision` tool and numbered `adr-NNNN-<slug>.md`.
  Read the ones touching the area you're about to work in.

There is no `CONTEXT-MAP.md` and no per-context `src/<context>/docs/adr/` — a lookup
there is expected to find nothing.

## File structure

```
/
├── CONTEXT.md                 ← not present yet
├── openspec/
│   ├── decisions/             ← THE ADR corpus (adr-0001-….md …)
│   ├── specs/<domain>/spec.md ← the spec corpus, one directory per domain
│   └── changes/<change-id>/   ← in-flight change proposals
└── src/
```

## Specs are part of the domain record here

Beyond ADRs, `openspec/specs/<domain>/spec.md` carries the requirements and the
domain vocabulary in force. `openspec/specs/overview/spec.md` is the entry point (domain
table + technical stack). When a skill asks for "the project's domain language" and
`CONTEXT.md` is absent, read the overview spec plus the spec for the domain you're
touching, rather than inferring vocabulary from code identifiers.

Structural questions ("who calls this", "what's the blast radius", "which spec covers
this symbol") are answered by the OpenLore MCP tools described in the root `CLAUDE.md` —
prefer those over grepping.

## Use the established vocabulary

When your output names a domain concept (an issue title, a refactor proposal, a
hypothesis, a test name), use the term as the specs define it. Don't drift to synonyms.

If the concept isn't in the specs yet, that's a signal — either you're inventing language
the project doesn't use (reconsider), or there's a real gap (note it).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently
overriding:

> _Contradicts ADR-0023 (default MCP surface is the `substrate` preset) — but worth
> reopening because…_

An ADR here can also be **superseded**: check for a later decision before citing one.
`verify_claim` with the `decision-current` kind settles it against the decision store.
