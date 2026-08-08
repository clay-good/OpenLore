# Served content is untrusted: the read-only surface protects the store, not the agent

> Status: BUILT (2026-08-08). Verified by 361 passing test files (6,883 tests passed, 2 skipped),
> lint, typecheck, build, strict OpenSpec validation, and scoped drift verification for the
> `mcp-security` and `architecture` domains. OpenLore's read-only tools serve recorded memories,
> decision text, spec prose, commit messages, and branch and pull-request titles straight
> into a coding agent's context as authoritative grounding — which is the entire point, and which
> makes that content an instruction channel nobody has named. The sibling
> `harden-llm-prompt-injection-boundary` closes this for the *LLM* paths. The *serving* path,
> where no model of OpenLore's is involved and the consuming agent is someone else's, is still
> unaddressed. Prior art: engines that record content as untrusted input, place the trust boundary
> at human review, and flag injection-shaped content for a reviewer without ever rewriting it.

## The gap

The read-only guarantee is real and it protects the wrong party. Nothing an agent does can mutate
the corpus. That says nothing about protecting the agent from the corpus.

- **The substrate's job is to be believed.** `recall` returns anchored memories with a freshness
  verdict; `get_spec` returns requirements; `orient` injects a briefing at task start; `blast_radius`
  and `map_in_flight_conflicts` splice in branch names, pull-request titles, and commit subjects.
  Every one of those is presented to the consuming agent as settled fact — that is the product. It
  is also a text channel from whoever wrote the content to whoever is reading it.
- **Several inputs are not covered by human review at all.** A memory written by `remember` enters
  the store without a pull request. `map_in_flight_conflicts` harvests titles from *other people's*
  open branches and pull requests. An imported `.olbundle` carries symbol names and metadata from a
  machine the user does not control — `harden-bundle-import-trust` guards the bundle's *structure*,
  not the fact that its strings land in an agent's context. Source-derived strings such as comments
  and identifiers come from whatever repository was cloned.
- **The threat is specific and mundane.** Text engineered to read as an instruction — an imperative
  override, an impersonated system or tool message, or prose arguing the agent away from a recorded
  decision — is served faithfully and deterministically, because serving recorded content faithfully
  is exactly the contract. Determinism guarantees the same bytes every time; it does not guarantee
  those bytes are benign.
- **`SECURITY.md` and the specs are silent on it.** `mcp-security` covers DNS rebinding and
  untrusted descriptors — transport and network. `add-secret-redaction-boundary` covers secrets
  leaving. Content arriving as instructions has no home, so the product implicitly claims a
  protection it does not provide.

## What changes

This is a doctrine change with one small mechanism. It deliberately does **not** add a sanitizer.

1. **Name the trust model.** Content OpenLore serves is **untrusted input**. It becomes
   authoritative for an agent because a human reviewed and merged it — the trust boundary is human
   review, not the read-only surface. Content that has not passed human review (a locally written
   memory, another actor's branch title, an imported bundle's strings, a cloned repository's
   comments) is disclosed as unreviewed and SHALL NOT be presented as carrying the corpus's
   authority. This is recorded in the specs and in `SECURITY.md`, so what the read-only guarantee
   does and does not cover is stated rather than assumed.

2. **A provenance tier on served content, not a trust score.** Each served content field carries
   which class it came from: `reviewed-corpus`, `local-unreviewed`, `foreign-actor`, `imported`,
   or `source-derived`. This is a factual statement of origin, computed from where the bytes were
   read. It is explicitly **not** a trustworthiness number — a lexical score dressed as a verdict is
   wrong in both directions and gets consumed as authority anyway.

3. **An injection-shape flag in `openlore doctor`, advisory and non-mutating.** A deterministic
   lexical check over corpus content flags imperative overrides, system/agent/tool impersonation,
   and decision-steering language as a reviewable finding — surfaced to the human who is already
   the trust boundary, before merge. It is an aid to a reviewer, never a gate and never a
   guarantee, and its lexical nature (it will miss novel phrasings and occasionally false-positive)
   is stated wherever it is reported.

4. **The serving path SHALL NOT rewrite content.** No sanitizing, stripping, escaping, or
   neutralizing of recorded content on the way out. Rewriting served content silently changes
   recorded knowledge, breaks the byte-stable read-only contract, and requires exactly the semantic
   judgment doctrine keeps out of the substrate. Content is served as recorded, with its provenance
   stated.

5. **A structural containment boundary where one is cheap.** Where OpenLore composes served content
   into a text block an agent consumes as a unit — `orient --inject`, the Pi extension's
   `before_agent_start` block, the review comment — the content SHALL be enclosed with a delimiter
   that content cannot forge, and the block SHALL state that the enclosed text is data. This is
   structure, not sanitization: it changes framing, never bytes.

## Why this is in scope

`mcp-security` owns the hardening of the surfaces the substrate exposes. It currently owns the
network half. Decision `c6d1ad07` positions OpenLore as the grounding layer agents build on — which
makes "what is the trust status of what we hand the agent" a first-order property of the product,
not an operational footnote. The mechanism is small because the honest answer is procedural: name
the boundary, state the provenance, help the reviewer, and refuse to pretend a server-side filter
solves it.

## Impact

- **Files:** provenance tagging where content is assembled for serving
  (`src/core/services/mcp-handlers/memory.ts`, `orient.ts`, `interference-map.ts`,
  `spec-store.ts`), an injection-shape check in `src/cli/commands/doctor.ts`, unforgeable
  delimiters in `src/cli/commands/orient-inject-render.ts` and the Pi injection block, and a
  `SECURITY.md` section.
- **Specs:** `mcp-security` — 2 ADDED requirements (untrusted served content, provenance tiers,
  no-rewrite rule, and advisory injection-shape review); `architecture` — 1 ADDED requirement (the
  trust boundary is human review, and what the read-only guarantee does not cover).
- **Tool surface:** unchanged. No new tool; provenance is an additive field, the flag is a `doctor`
  finding.
- **Risk:** low mechanically. The real risk is a reader mistaking the `doctor` flag for a
  guarantee and reviewing less carefully — which is why the flag states its lexical limits wherever
  it appears, and why the specs say plainly that human review is the boundary.
- **Sibling boundaries:** `harden-llm-prompt-injection-boundary` owns the LLM prompt paths
  (extraction, drift, generation) and their tool-enabled providers — this owns the non-LLM serving
  path to a third-party agent. `add-secret-redaction-boundary` owns secrets going *out*.
  `harden-bundle-import-trust` owns a bundle's structural validity; this owns its strings' status
  once served. `add-store-origin-provenance` owns where a store came from; this owns what the
  content's origin means to the reader.
