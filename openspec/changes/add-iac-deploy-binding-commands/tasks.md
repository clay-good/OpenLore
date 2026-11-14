# Tasks — bind container commands to the script they run

The Serverless reader, build-output mapping, `orient` deploy field, and `iacCodeBinding` capability
shipped in another change (#662, archived as `add-serverless-and-build-output-binding`).

## 1. Decide the binding target

- [ ] 1.1 Decide what a script binds to (single unambiguous entry, or a new module-entry node) and
      record it with `openlore decisions record --files src/core/analyzer/iac/deploy-binding.ts`.
      Done when the decision is accepted and named in `proposal.md`.

## 2. Readers and binding

- [ ] 2.1 Dockerfile exec-form `CMD`/`ENTRYPOINT` fills `IacResource.deploys`
      (`src/core/analyzer/iac/docker.ts`). Test: `docker.test.ts`. Done when
      `CMD ["node", "dist/server.js"]` yields a `deploys` entry and a shell-form `CMD` yields an
      `unresolved` reason.
- [ ] 2.2 Kubernetes container literal `command`/`args` fills `IacResource.deploys`
      (`src/core/analyzer/iac/kubernetes.ts`). Test: `kubernetes.test.ts`. Done when a pod running
      `python app/main.py` yields a `deploys` entry.
- [ ] 2.3 Bind those entries through `iac/build-output.ts` and add Docker and Kubernetes to
      `IAC_CODE_BINDING_LANGUAGES` (`src/core/analyzer/iac/deploy-binding.ts`). Tests:
      `deploy-binding.test.ts`, `language-support.test.ts`. Done when the scenario
      "A container command binds to its script" passes and the capability row shows both.

## 3. Delivery and docs

- [ ] 3.1 Confirm the `orient` deploy briefing names the image or pod for an edited script
      (`src/core/services/mcp-handlers/deploy-briefing.ts`). Test: `deploy-briefing.test.ts`. Done
      when orienting on `src/server.ts` names the Dockerfile resource and its line.
- [ ] 3.2 Fix stale comments that cite this change for work that shipped in #662:
      `src/core/analyzer/iac/deploy-binding.ts` (lines 13 and 37) and
      `src/core/services/mcp-handlers/orient.ts` (line 1151). Done when they cite
      `add-serverless-and-build-output-binding` (or no change) and only new code cites this change.
- [ ] 3.3 Update `docs/iac.md` and `docs/language-support.md` for the two new ecosystems. Done when
      `src/doc-claim-sync.test.ts` passes.
