# Tasks — add-contract-payload-check

- [x] `readCallBody`: bounded, string/template/comment-aware scan of a call's body (fetch `body`, axios post/put/patch)
- [x] `certify_service_contract` `payload`: call sites, conforming, not assessed (listed); findings for missing required properties or no body
- [x] `contract-payload-missing-required` registered (advisory)
- [x] Tests: literal, JSON.stringify, shorthand, quoted, nested; spread, computed, variable not literal; absent; certify end to end
- [x] Spec: `mcp-handlers` ADD LiteralPayloadsAreCheckedAgainstRequiredProperties
