# Tasks: Kotlin style fingerprint

## Implementation
- [ ] Kotlin entry in `STYLE_LANG_SPECS` with the five idioms; `enforced` empty
- [ ] Walker branches for function body form, `val`/`var`, expression or statement conditionals,
      templates or concatenation, naming case
- [ ] Skip rules: bodiless functions, backtick names, test files, Gradle build scripts
- [ ] Update the supported-language text in the unavailable result

## Conformance
- [ ] One fixture per idiom with known counts
- [ ] Below-floor fixture reports a null signal with reason `below_floor`
- [ ] `language-support.test.ts`: Kotlin `styleFingerprint` fixture yields counters

## Verification
- [ ] Reference corpus: fingerprint reported for repository, region, and file scope
- [ ] Full suite green

## Spec
- [ ] `analyzer` delta: ADD KotlinStyleFingerprintIsMeasured
