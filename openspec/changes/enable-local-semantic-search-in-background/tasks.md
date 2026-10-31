# Tasks

## 1. Hints for humans (ships alone)

- [ ] 1.1 Remove the embed hint from the agent-facing `note` fields in `orient.ts` and `semantic.ts`, and from the inject block. Verify with the existing payload tests, updated.
- [ ] 1.2 Show the hint in `openlore status` and `openlore doctor` only.

## 2. Measure

- [ ] 2.1 Add `bench/retrieval/` with fixed queries and known targets for this repo and two dogfood corpora. Report recall@5, MRR, build time and disk use for both modes.
- [ ] 2.2 Record the result in `docs/semantic-search.md` and in this change.

## 3. Enable (only if 2.1 clears the threshold)

- [ ] 3.1 Add the background vector pass after the keyword publish, in the repair builder and auto-init.
- [ ] 3.2 Report `local-semantic` only when vectors for the current generation exist; fall back silently when the package or model is missing.
- [ ] 3.3 Verify with `npm run test:unit`, `npm run test:equivalence`, and a dogfood with the package removed.
