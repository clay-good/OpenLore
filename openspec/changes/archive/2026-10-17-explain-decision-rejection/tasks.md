## 1. Terminal dispositions

- [x] 1.1 Add an additive disposition (`promoted` | `merged-into` | `rejected` | `pending`) with a source-declared reason-code registry to the decision record types; read a record without one as `legacy-unknown`.
- [x] 1.2 Emit a disposition for every input draft in `consolidator.ts`, including drafts the LLM pass does not return, and persist it through the CAS store.
- [x] 1.3 Property test: for any draft set, the number of persisted dispositions equals the number of input drafts — no silent drop.
- [x] 1.4 Tests for each reason code, including `merged-into` naming the surviving id.

## 2. Readable verdicts

- [x] 2.1 Return the draft id, draft status, and the exact verdict-reading command from `record_decision`.
- [x] 2.2 Return the existing disposition and reason when a re-recorded draft matches a decided one (content plus anchors), instead of creating a second draft.
- [x] 2.3 Add the disposition and reason to `openlore decisions` status output, with an explicit pending state and a concrete next action on rejection.
- [x] 2.4 Update the `record_decision` tool description to state the draft-then-consolidation contract without implying finality.

## 3. Author statement preservation

- [x] 3.1 Retain the agent-recorded title and rationale as `authorStatement` when consolidation re-derives content.
- [x] 3.2 Disclose `contentOrigin` and `verificationEvidence` in the decision read paths (`recall`, `openlore decisions`, MCP responses).
- [x] 3.3 Tests: a promoted-with-rewrite decision exposes both the served content and the untouched author statement.

## 4. Verification

- [x] 4.1 Run the tests reaching the consolidator, decision store, decision handlers, and the CLI command.
- [x] 4.2 Exercise the full loop on a scratch repository: record, consolidate, read verdict for a promoted draft and a rejected one.
