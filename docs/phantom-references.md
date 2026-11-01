# Phantom references

Agents invent APIs and packages: an import of a module that was never written, a named import the
target does not export, a package no manifest declares. The invented package name is also an attack
surface, because a name a model keeps suggesting can be registered by someone else and then
installed. Every one of these is decidable from the repository alone, so `verify_change` reports
them for the references a diff **adds**. No network request is made on any path.

| Finding | The reference |
|---------|---------------|
| `unresolved-internal-import` | a relative import whose target is not a file in this repository (or, in Go, a path under the module's own path that names no package directory) |
| `unresolved-internal-symbol` | a named import the target module does not export |
| `undeclared-dependency` | a bare specifier that no manifest in scope declares and that is not the standard library |
| `unpinned-dependency` | declared in a manifest the diff changed, but absent from the lockfile beside it |

All four are advisory. `verify_change` classifies them with
[`enforcement.policy`](configuration.md), so `blocking` sets `gated: true` and `off` drops them;
`openlore enforce` does not collect them. `blast_radius` carries the same references as facts in
`phantomReferences.unresolved` — it holds no policy, so it reports what was found and leaves the
classification to `verify_change`.

## What counts as added

The references in the file now, minus the references the base revision had, compared by specifier
and bound names — so moving or re-indenting an import does not read as adding one. Every import of
a file the diff adds is added. A name imported under an alias is checked under the name the target
must export (`import { real as local }` checks `real`).

A re-export reads a module exactly as an import does, so `export { x } from './y'` and
`export * from './y'` are references too — a hallucinated barrel is one of the shapes this catches.

## How each answer is reached

| Question | Evidence |
|----------|----------|
| Is the target a real module? | The import is resolved against the working tree, so a file the same diff creates resolves. A bundler query or fragment (`./a?raw`) is dropped first, and `.d.ts` counts. Candidate paths offered on a miss come from the index, when the caller has one. |
| Does the target export the name? | The target's **current** content is parsed, never the index, so an export the same diff adds resolves. A barrel is followed to the module that really exports the name. |
| Is the package declared? | Every manifest between the file and the repository root: `package.json` (including `optionalDependencies`), `pyproject.toml`, `requirements*.txt`, `go.mod`, `Cargo.toml`. Internal, so never reported: a name declared by any workspace member a `workspaces` glob names (including a sibling package), and a Go import under the declared module path. |
| Is it pinned? | Every lockfile beside the changed manifest: `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`, `poetry.lock`, `uv.lock`, `pdm.lock`, `Pipfile.lock`, `Cargo.lock`, `go.sum`. Any one of them pinning the package settles it, so a stale lockfile beside a live one reports nothing. Python names compare by PEP 503 normalization, Cargo names across `-` and `_`, Go by module prefix. |

Standard-library modules are a closed per-language rule: Node's own `builtinModules` list plus the
`node:` scheme; the CPython standard-library module names; and, for Go, the language's own rule that
a module path's first element contains a dot (so `fmt` and `net/http` are standard library, and
`github.com/x/y` is not).

## What is disclosed instead of reported

A reference this check cannot judge is listed as not assessed, never counted as resolving:

- a file whose language it cannot read imports for: it reads TypeScript, JavaScript, Python and Go,
  and discloses every other language — Java, Kotlin, C# and PHP have import support elsewhere in
  OpenLore, and Ruby and Rust have none in the [language matrix](language-support.md);
- a path alias — `@/x`, `~/x`, `#subpath`, or a `tsconfig`/`jsconfig` `paths` pattern — because the
  resolver does not read alias configuration;
- a target that re-exports from somewhere unfollowable (`export * from 'some-package'`), since the
  name asked for could legitimately come from there;
- a target whose exports this reader cannot enumerate: CommonJS (`module.exports`, `exports.foo`),
  TypeScript `export =`, `export declare`, `export namespace`, or a destructured export;
- in Python, a name that is a submodule of the imported package rather than a symbol of it, which
  resolves as the module it is;
- an ecosystem with no manifest in scope, or a manifest that could not be read or parsed (a
  manifest that exists but is unreadable is never taken to declare nothing);
- a dynamic import with a computed specifier;
- a lockfile that is absent or did not parse (which proves nothing about pinning).

`verify_change` reports how many references it checked, so an empty finding list can be read
correctly.

## Not built

No package-registry or network lookup: a name being *declared* is not proof that it is safe, which
is supply-chain tooling's job. No version-range or vulnerability checks. No type checking of member
signatures. Member accesses on a namespace import (`utils.formatDate()`) are not yet extracted; only imports,
named imports, and re-exports are.
