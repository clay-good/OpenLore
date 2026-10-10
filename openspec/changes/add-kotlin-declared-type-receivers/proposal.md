# Resolve Kotlin method calls through declared types

> Status: PROPOSED (2026-10-10, issue #546). Part of `KOTLIN-TOTAL-SUPPORT-2026-10.md`. Depends on
> `fix-kotlin-package-binding-soundness`. Deterministic, no LLM, no new dependency.

## What you get

The most common Kotlin call shape, a call on an injected dependency, becomes a real edge. Today it
is an external leaf, so callers, blast radius, test selection, and dead-code results for a Kotlin
service layer are mostly empty.

## What is missing today

Kotlin type inference reads two shapes inside the caller's body: `val x: T` and `val x = T(...)`
(`type-inference-engine.ts:263-282`). Everything else is untyped. On the reference fixture:

| Source | Today | Why |
|---|---|---|
| `class UserService(private val repo: UserRepository)` then `repo.save(x)` | `external::repo.save` | constructor properties are outside the body slice |
| `fun use(svc: UserService) = svc.find("1")` | `external::svc.find` | parameters are not read |
| `this.repo.save(x)` | no edge or a wrong one | Kotlin is not in `RECEIVER_REGISTRY_LANGUAGES` |
| `UserService.audit(what)` (companion member) | bound only through the import map | Strategy 1b (`type_name`) covers Swift/C++/Java only (`call-graph.ts:5948`) |
| `val s = UserService.default(); s.create("x")` | works only because the type is written | declared return types are not read |

Result on the fixture: 38 of 39 symbols have no reaching test, and most service methods are
reported as entry points.

## What changes

One per-file fact set, **declared receiver types**, read from the parse tree:

| Fact | Kotlin source |
|---|---|
| Function parameter | `fun f(p: Parser)` |
| Constructor property | `class A(private val repo: Repo)`, `class A(val repo: Repo)` |
| Constructor parameter used in `init` or a property initializer | `class A(repo: Repo)` |
| Class property with a written type | `val repo: Repo`, `lateinit var repo: Repo`, `private val repo: Repo by lazy { … }` |
| Class property initialized by construction | `val repo = Repo()` |
| Local with a written type or construction | already supported |
| Declared return type of a project function | `fun create(): Repo`, used for `val r = create()` |

Rules:

- **Declared types only.** A type comes from an annotation the author wrote or from a constructor
  call. No flow analysis, no smart casts, no generics substitution, no lambda `it`.
- **Nullable and platform wrappers are peeled.** `Repo?` types the receiver as `Repo`.
- **Conflict means refusal.** A name declared with two different types in one scope gives no fact.
  A local shadows a property; a later reassignment of a `var` removes the fact after that point.
- **Implicit `this`.** `repo.save()` inside a class resolves `repo` as a class property when no
  local or parameter has that name.
- **Kotlin joins `receiverResolution`.** `this.repo.save()` binds through the same fact set and
  produces a `receiver_inferred` edge. A receiver that does not bind emits no edge and is disclosed
  as a boundary, as for TypeScript and Python.
- **`Type.member()`** on a project class, object, or companion binds by type name.
- An edge from these facts carries the existing `type_inference` or `receiver_inferred`
  confidence. No new confidence tier.

## Not in scope

- Smart casts, generics, `it`, scope-function receivers (`apply`/`with` bodies), delegation
  targets. They stay unbound and are counted in the unresolved-receiver disclosure.
- Types declared only in Java sources of a mixed project bind through the shared JVM index when
  the Java class is in the repository; library types stay external.

## Impact

- `type-inference-engine.ts`, `receiver-registry.ts` (Kotlin collector), `call-graph.ts`
  (Strategy 1b), `exception-flow.ts` (self-field classification now applies to Kotlin).
- Specs: `analyzer`, 1 ADDED requirement.
- Risk: precision. Every new edge needs a declared type; the PR reports edges gained on a real
  repository and a hand-checked sample of 50.
