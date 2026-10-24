# Tasks: Kotlin project identity

## Implementation
- [ ] Add `kotlin` to `ProjectType`, the display-name map, and the config schema
- [ ] Detection: Kotlin plugin evidence in Gradle, version catalog, Maven; source-count fallback
- [ ] `doctor`: information-level mismatch between configured and detected JVM language
- [ ] "Kotlin" for `.kt` and `.kts` from the canonical language map in every breakdown
- [ ] JVM framework detectors over Gradle, Maven, and version-catalog literals
- [ ] Position-aware skip rules for `build`, `out`, `bin`, `target`, `android`, `ios`
- [ ] Classify Gradle Kotlin build scripts as build configuration; exclude from domains
- [ ] Watch `.kts`; add `.kts` to `GRAPH_SOURCE_EXTS`

## Conformance
- [ ] Detection fixtures: Kotlin Gradle, Kotlin Maven, mixed with plugin, mixed without plugin,
      Java only
- [ ] Walker fixtures: package directory `com/acme/android` walked; Gradle `build/` output skipped;
      React Native `android/` skipped; skip receipt reasons
- [ ] Domain fixture: no domain derived from a Gradle build script
- [ ] Config fixture: existing `"projectType": "java"` config still loads

## Verification
- [ ] Reference corpus: type "Kotlin"; breakdown "Kotlin"; frameworks Spring Boot and Ktor
- [ ] Walker budget test stays within its counter budget
- [ ] Full suite green

## Spec
- [ ] `project` delta: ADD KotlinIsADetectedProjectType
- [ ] `analyzer` delta: ADD JvmSourcePackagesAreNotSkippedAsBuildOutput
