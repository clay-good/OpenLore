# Tasks: Kotlin style fingerprint

## Implementation
- [x] Kotlin entry in `STYLE_LANG_SPECS` with the five idioms; `enforced` empty
- [x] Kotlin tally for function body form, `val`/`var`, expression or statement conditionals,
      templates or concatenation, naming case. It is its own function: Kotlin shares node-type
      names with the other grammars (`function_declaration`) but not their meaning. A conditional
      directly in a block is a statement; an `else if` continues its `if` and is counted once
- [x] Skip rules: bodiless functions, backtick names, test files, Gradle build scripts
- [x] Update the supported-language text in the unavailable result

## Conformance
- [x] One fixture per idiom with known counts
- [x] Below-floor fixture reports a null signal with reason `below_floor`
- [x] `language-support.test.ts`: Kotlin `styleFingerprint` fixture yields counters

## Verification
- [x] Reference corpus: fingerprint reported for repository, region, and file scope
- [ ] Full suite green (run once for the whole change set, in the pull request)

## Spec
- [x] `analyzer` delta: ADD KotlinStyleFingerprintIsMeasured
