# Harden review rendering and the bundled Action: head-controlled text is hostile, and stale analysis must say so

> Status: BUILT (2026-08-15). `openlore review` interpolated symbol names
> and file basenames from the PR head into Markdown code spans unescaped — a hostile filename can
> break out of its span and inject arbitrary Markdown into a comment posted with the repo's
> token. The example workflow's pull_request_target note claims a safety property the Action does
> not have, and a failed/stale analyze is presented as authoritative. Escape everything
> interpolated, rewrite the trust guidance, disclose staleness.

## The gap

- **Markdown injection via identifiers.** `renderMarkdown` wraps head-controlled values in
  backtick spans at `review.ts:230, 236, 240, 243, 263` (removed/signature-changed/added/renamed
  symbols and hub names, plus file basenames); `clip()` (`review.ts:169-171`) only truncates —
  nothing escapes. The values originate from the diffed head source (`structural-diff.ts:85`
  builds refs straight from parsed `FunctionNode.name`/`filePath`; changed files enumerated at
  `:107-125`). A fork file or symbol containing a backtick can close the code span and inject
  arbitrary Markdown — fake briefing sections, `@mentions`, or a second `<!-- openlore-review -->`
  sticky marker (which the self-heal dedup then acts on) — into a comment posted with the base
  repo's write token.
- **Misleading pull_request_target guidance.** The example workflow
  (`.github/workflows/openlore-review.yml.example:16-21`) says switching to `pull_request_target`
  is "only safe because this Action runs deterministic local analysis, not untrusted head code."
  That is not the property that matters: reviewing the PR requires checking out the head, after
  which `npx openlore analyze` (`action.yml:41-44`) parses attacker-controlled content whose
  names flow into the write-token comment (compounding the injection above) — and the Action runs
  `npx --yes openlore@latest` by default (`openlore-version` defaults to `latest`,
  `action.yml:24-27` inputs block) with that elevated token in scope.
- **Failed or stale analysis presented as authoritative.** The Action's analyze step swallows
  failure — `|| echo "analyze failed — ..."` exits 0 (`action.yml:44`) — and `composeReview`
  discloses only a base-ref fallback and blast-radius-unavailable (`review.ts:133-139`). When an
  analysis index exists but is stale (or the CI analyze just failed and a cached index remains),
  the blast radius renders with no caveat: a conclusion without its receipt.

## What changes

1. **A code-span-safe encoder for every interpolated identifier.** One small escaping function
   applied at all render sites (`review.ts:230, 236, 240, 243, 263` and the drift/decision
   message lines): neutralize backticks (extend the span's backtick fence or strip), escape
   HTML-significant characters, and strip the sticky-marker substring `<!-- openlore-review -->`
   from any interpolated value. Deterministic string work; tests use hostile filenames
   (backticks, `@user`, a second marker, HTML tags).
2. **Honest trust guidance.** Rewrite `openlore-review.yml.example:16-21`: warn explicitly
   against `pull_request_target` combined with a head checkout; recommend the two-workflow
   `workflow_run` pattern (untrusted analyze in a read-only `pull_request` job, comment posting
   in a trusted job that only reads the artifact); and recommend pinning `openlore-version`
   whenever a write token is in scope, noting the `latest` default (`action.yml:24-27`).
3. **Staleness and failure are disclosed.** The analyze step records a failure marker
   (step output/env) instead of only echoing, and the review step surfaces it as a briefing
   caveat. `composeReview` renders the shared blast-radius confidence boundary when graph-relevant
   source has diverged from the index build commit, including that commit's SHA. This deliberately
   reuses OpenLore's existing freshness semantics: a docs-only commit does not make the graph
   stale, while dirty or committed source divergence does. The existing caveat channel is
   extended; no new briefing shape is introduced.
4. **A gate attempts to publish its evidence before failing.** The CLI reserves exit code 3 for an intentional
   `blastRadius.block` policy result. The Action treats only that receipt as a gate, attempts to
   post or update the briefing, and then propagates the failure; a comment API failure remains
   advisory but does not suppress the configured policy. Arbitrary execution errors cannot be
   mislabeled as policy findings merely because a partial output file exists.

Retained as-is (already solid, not re-fixed): the comment-size double-clamp
(`review.ts:315-318` head-truncation preserving the marker + the Action-side guard,
`action.yml:80-86`), sticky-marker find-update-dedup self-heal and advisory-only posting that
never fails the check (`action.yml:87-114`), and `validateGitRef` + execFile array-args in the
structural diff.

## Why this is in scope

The review surface is where OpenLore's deterministic conclusions meet an adversarial input (a
fork's head) and an elevated credential (the repo's comment token). Unescaped head-controlled
text in a write-token comment is an injection, and a stale blast radius with no caveat violates
the receipts rule. All fixes are deterministic and local: an escaper, a docs rewrite, and
rendering the semantic freshness result the blast-radius confidence boundary already computes.

## Impact

- Files: `src/cli/commands/review.ts` (escape at render sites; stale-index caveat in
  `composeReview`), `.github/actions/openlore-review/action.yml` (failure marker from the analyze
  step), `.github/workflows/openlore-review.yml.example` (trust guidance rewrite); hostile-input
  and staleness tests.
- Specs: `cli` — 2 ADDED (ReviewMarkdownEscapesHeadControlledText,
  ReviewDisclosesStaleOrFailedAnalysis; complements the existing
  ReviewDegradesHonestlyWhenItCannotCompute, which covers missing-index/unreachable-base and
  stays as-is); `mcp-security` — 1 ADDED (ReviewActionWriteTokenTrustBoundary).
- Tool surface: unchanged (no MCP tool touched, no payload-budget impact; `structural_diff`'s
  own output is not re-encoded — only the Markdown renderer escapes).
- Risk: low. Escaping only changes rendering of pathological names; the new caveats are additive
  lines in an existing section; exit code 3 was previously unused; and the workflow example is
  documentation.
