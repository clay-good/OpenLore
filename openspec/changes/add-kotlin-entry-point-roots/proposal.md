# Recognize how Kotlin code is started by build files and frameworks

> Status: PROPOSED (2026-10-10, issue #546). Part of `KOTLIN-TOTAL-SUPPORT-2026-10.md`. Extends
> the shipped framework entry-point adapters. Deterministic, no LLM, no new dependency.

## What you get

`find_dead_code` and `report_coverage_gaps` stop calling Kotlin code dead when a build file, a
manifest, or a framework annotation is what starts it.

## What is missing today

Roots are tests, HTTP handlers, the names `main` / `Main` / `default`, names imported in the
dependency graph, and files wired by a config the adapters read (`reachability.ts:221-287`). The
adapters read `package.json`, `tsconfig`, test-runner configs, and GitHub Actions run steps only
(`entry-point-adapters.ts`). For a Kotlin repository this leaves:

- no root from Gradle (`application { mainClass.set("com.acme.MainKt") }`), `AndroidManifest.xml`,
  or Ktor configuration;
- no root from an annotation. A Spring `@Service`, a `@Scheduled` function, a Dagger `@Inject`
  constructor, and a Compose `@Preview` all have zero callers in source;
- no root for an `override` of a library type (`Activity.onCreate`, `Runnable.run`);
- Kotlin in `STATIC_LANGS`, so these candidates get the confident tier.

## What changes

**1. Config adapters** (evidence tier `config-wired`, each root carries a receipt naming the file
and key)

| Config | Read | Root |
|---|---|---|
| `build.gradle(.kts)` | `application { mainClass }`, `mainClassName`, `springBoot { mainClass }`, `tasks…JavaExec { mainClass }`, as string literals | the file whose JVM facade class is named (`MainKt` → the file `Main.kt` in that package, or a file with `@file:JvmName("Main")`); or the named class's `main` |
| `AndroidManifest.xml` | `android:name` of `application`, `activity`, `service`, `receiver`, `provider` | the named class and its members that override a library type |
| `application.conf` / `application.yaml` (Ktor) | `ktor.application.modules` | each named module function |
| `META-INF/services/*` | provider class names | the named class |
| GitHub Actions run steps | `gradle` / `./gradlew` / `java -jar` / `kotlin` runners | the roots of the wired Gradle project |

A relative name (`.MainActivity`) is resolved against the manifest `package` or the Gradle
`namespace` when it is a literal.

**2. Annotation roots** (evidence tier `framework-annotated`, import-gated)

| Framework | Gate | Rooted |
|---|---|---|
| Spring | `org.springframework` | constructor and public members of a class with `@Component`, `@Service`, `@Repository`, `@Controller`, `@RestController`, `@Configuration`, `@SpringBootApplication`, `@ConfigurationProperties`; functions with `@Bean`, `@Scheduled`, `@EventListener`, `@PostConstruct`, `@PreDestroy`, `@ExceptionHandler`, and message-listener annotations |
| Jakarta / javax inject, Dagger, Hilt | `javax.inject`, `jakarta.inject`, `dagger` | `@Inject` constructors and members; `@Provides` and `@Binds` functions; `@HiltViewModel`, `@AndroidEntryPoint`, `@HiltAndroidApp` classes |
| Koin, Kodein | `org.koin`, `org.kodein.di` | constructors referenced in a module declaration (`single { Repo() }` is already a call edge); no extra rule |
| Compose | `androidx.compose` | a `@Composable` function that also has `@Preview` |
| kotlinx.serialization | `kotlinx.serialization` | constructor and accessors of a `@Serializable` class |
| JUnit / kotlin.test lifecycle | test gates | `@BeforeEach`, `@AfterEach`, `@BeforeAll`, `@AfterAll`, `@BeforeTest`, `@AfterTest` functions |

**3. External overrides.** A member with the `override` modifier whose overridden declaration is
not found in the repository is callable by the library that declares it. It is not given a
confident unreachable verdict; its tier is `external-override`.

**4. Kotlin `main` forms.** A top-level `fun main()` with or without `args`, a `suspend fun main`,
and a `@JvmStatic fun main` in an object or companion are roots by declaration.

**Honesty rules**

- A root is evidence that something can start the code. It is never a claim that the code is
  tested.
- A config value that is not a literal is counted as `config-unresolved` and roots nothing.
- Annotation roots apply only behind their import gate; an unknown annotation roots nothing.

## Not in scope

- Reading Spring XML or `spring.factories`; Gradle convention plugins; version-catalog aliases.

## Impact

- `entry-point-adapters.ts` (Gradle, manifest, Ktor, services adapters; runners), the Kotlin
  extractor (annotation facts), `reachability.ts` (two tiers), `coverage-gaps.ts`.
- Specs: `analyzer`, 2 ADDED requirements.
- Risk: annotation roots hide real dead code inside a rooted class. The tier is reported, so a
  user can still list rooted-but-uncalled symbols.
