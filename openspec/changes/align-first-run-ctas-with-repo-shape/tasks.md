# Tasks — align-first-run-ctas-with-repo-shape

## Implementation

- [ ] Install epilogue: compute prove's precondition (functions with fan-in ≥ 2) from the
      just-built graph before printing the "Does it pay off?" pointer; omit or replace with
      the measured-value statement. Single-source the threshold with prove (import, don't
      duplicate)
- [ ] `prove --estimate` refusal: include measured count + required threshold; drop the bare
      "Try a larger repo" in favor of applicable alternatives
- [ ] Spec-index skip message: thread an "install/init created this openspec dir this run (or
      it is empty and unmodified since creation)" signal to the message site; informational
      phrasing + generate's LLM-provider precondition
- [ ] Uninstall summary: append kept-paths disclosure (`.openlore/`) + removal one-liner
- [ ] Tests: epilogue gating both ways (sparse vs. dense fixture); prove refusal receipt;
      fresh-install message phrasing; uninstall summary

## Verification

- [ ] Sandbox e2e: install on the 5-function repo prints no failing CTA; `prove --estimate`
      names its numbers; uninstall names `.openlore/`
