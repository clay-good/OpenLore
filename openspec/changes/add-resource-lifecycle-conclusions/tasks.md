# Tasks — add resource lifecycle conclusions

## Implementation
- [ ] Closed per-language acquire/release pairing table (TS/JS, Python, Go) as one constant module
- [ ] Recognize auto-release scope forms as release-on-all-paths: `with`, `defer`, `using` /
      `await using`, `try/finally`
- [ ] Traverse the persisted CFG from each acquisition site to every exit; classify each path
      `released-on-all-paths | unreleased-on-path | undecidable`
- [ ] Rule: a resource returned from the function or stored outside it is `undecidable`
      (ownership transfer), never `unreleased-on-path`
- [ ] Join escaping exception paths to `analyze_error_propagation`'s evaluator (exported, not
      forked) to name the exception type on the leaking path
- [ ] Callers + reaching tests for functions with a proven leak path, from shipped traversals
- [ ] `boundaries`: unmatched pairings, alias/unresolved releases, truncation, staleness;
      unsupported language returns explicit `unsupported`
- [ ] Never emit a "released"/"safe" claim for a resource; document the asymmetry in the payload
- [ ] `analyze_resource_lifecycle` handler + CLI; register family + conclusion class; register
      one advisory finding code; cross-reference `analyze_error_propagation`

## Verification
- [ ] Early-return leak: acquire → conditional return → close is `unreleased-on-path` with the
      return line and exit
- [ ] `try/finally`, Python `with`, Go `defer`, and `using` fixtures are all quiet
      (`released-on-all-paths`), including when a throw occurs inside the scope
- [ ] Exception-path join names the exception type from the error-propagation evaluator
- [ ] Ownership transfer: a function returning the open handle is `undecidable`, not a leak
- [ ] Release through an unresolvable alias is `undecidable` and disclosed, not a leak
- [ ] Unsupported language returns `unsupported`, not an empty result
- [ ] No payload asserts a resource is safely released
- [ ] Advisory by default; blocks only under explicit enforcement policy
- [ ] Conclusion-shape assertion + tool-contract test pass

## Spec
- [ ] `mcp-handlers` delta: ADD ResourceLifecycleVerdictsAreProvenLeakPathsOnly
