# Disclose reflective and container dispatch in Kotlin

> Status: PROPOSED (2026-10-10, issue #546). Part of `KOTLIN-TOTAL-SUPPORT-2026-10.md`.
> Deterministic, no LLM, no new dependency.

## What you get

A "no callers" or "dead code" answer for Kotlin says when reflection or a dependency-injection
container could be the caller.

## What is missing today

`DYNAMIC_BOUNDARY_LANG_SPECS` has no Kotlin entry (`dynamic-boundary.ts:407-540`), so no site is
looked for. Kotlin is also in `STATIC_LANGS` (`reachability.ts:80-82`), which gives its dead-code
candidates the higher-confidence tier. The two together make Kotlin the language most likely to get
an over-confident "dead" verdict. The reference fixture calls
`Class.forName(name).kotlin.members.first { … }.call()`; no site is recorded.

## What changes

A Kotlin entry on the existing site vocabulary. No new site kind.

| Site kind | Kotlin form | Gate |
|---|---|---|
| `dynamic-import` | `Class.forName(…)`, `loadClass(…)`, `ServiceLoader.load(…)` | none (`Class.forName`), `java.util.ServiceLoader` import |
| `reflective-invoke` | `getMethod` / `getDeclaredMethod`, `.invoke(…)` on a reflected method, `newInstance()` | `java.lang.reflect` import, or a receiver chain that contains `.java` on a class literal |
| `reflective-invoke` | `.call(…)`, `.callBy(…)`, `createInstance()`, and member lookups (`members`, `memberFunctions`, `declaredFunctions`, `functions`, `constructors`, `primaryConstructor`) | `kotlin.reflect` import, or a receiver chain that starts at a class literal (`X::class`) |
| `container-resolution` | `getBean(…)` | `org.springframework` import |
| `container-resolution` | `get()`, `inject()`, `by inject()`, `koinInject()`, `getKoin()` | `org.koin` import |
| `container-resolution` | `instance()`, `by instance()`, `direct.instance()` | `org.kodein.di` import |
| `code-eval` | `ScriptEngine.eval(…)`, Kotlin scripting host `eval(…)` | `javax.script` or `kotlin.script` import |
| `metaprogrammed-definition` | `Proxy.newProxyInstance(…)` | `java.lang.reflect` import |

- The literal selector (`"run"` in `getMethod("run")`, the bean name in `getBean("x")`) is recorded
  where the argument is a string literal, as for Java.
- `importStyle` is `jvm`; the import node type is the Kotlin import header.
- An ordinary call on a function value (`f()`, `f.invoke()`) is not a site. `invoke` is a site only
  behind the reflection gate.
- Kotlin stays in `STATIC_LANGS`. A candidate near a site is qualified by the existing rule.

**`literalReflection` stays unbacked for Kotlin, by design.** The Kotlin idiom for a dispatch
table is a map of callable references (`mapOf("a" to ::create)`). Each reference is already an
ordinary edge after `add-kotlin-callable-node-shapes`, so there is nothing left to synthesize. The
capability note states this.

## Not in scope

- Compile-time injection (Dagger, Hilt, kapt, KSP). The constructor call is in generated code, not
  in reflection at a call site. `add-kotlin-entry-point-roots` handles it by annotation.

## Impact

- `dynamic-boundary.ts` (Kotlin entry; receiver-chain gate), `language-support.ts` (note text).
- Specs: `analyzer`, 1 ADDED requirement.
- Risk: `.call(` and `get()` are common names. The import or class-literal gate is the control; a
  false-site fixture exists for each.
