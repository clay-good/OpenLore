# Phantom references

Agents invent APIs and packages: an import of a module that was never written, a named import the
target does not export, a package no manifest declares. The invented package name is also an attack
surface, because a name a model keeps suggesting can be registered by someone else and then
installed. Every one of these is decidable from the repository alone, so `verify_change` reports
them for the references a diff **adds**. No network request is made on any path.

| Finding | The reference |
|---------|---------------|
| `unresolved-internal-import` | a reference to a module this repository does not have: a relative import that resolves to no file, a Go path under the module's own path naming no package directory, or a Python import whose top-level package is in this repository but has no such module |
| `unresolved-internal-symbol` | a named import the target module does not export |
| `undeclared-dependency` | a bare specifier that no manifest in scope declares and that is not the standard library |
| `unpinned-dependency` | imported, declared in a manifest the diff changed, but absent from the lockfile beside it |

All four are advisory. `verify_change` classifies them with
[`enforcement.policy`](configuration.md), so `blocking` sets `gated: true` and `off` drops them;
`openlore enforce` does not collect them. `blast_radius` carries the same references as facts in
`phantomReferences.unresolved` — it holds no policy, so it reports what was found and leaves the
classification to `verify_change`. That block is present whenever the check ran, with
`filesChecked` and `referencesChecked`, so `count: 0` reads as "checked, all resolved" rather than
"not checked"; it is absent only when the check could not run, and then a caveat says why.

The [`before-edit` hook](install.md#agent-loop-hooks) runs the same check **before** a `Write`,
`Edit`, or `MultiEdit` lands: it applies the pending change to the file's current text in memory
and states each reference the edit would add that does not resolve. Nothing is written, and an edit
whose old text is absent or not unique is skipped, as the edit tool would refuse it. A missing
relative module is a warning there ("does not exist yet"): it may be the agent's next write. These
facts have their own keys, so a denied edit does not silence the after-write fact of a later one.

## What counts as added

The references in the file now, minus the references the base revision had, compared by specifier
and bound names — so moving or re-indenting an import does not read as adding one. Every import of
a file the diff adds is added. A name imported under an alias is checked under the name the target
must export (`import { real as local }` checks `real`).

A re-export reads a module exactly as an import does, so `export { x } from './y'` and
`export * from './y'` are references too, across as many lines as the statement spans — a
hallucinated barrel is one of the shapes this catches.

Only what is code counts. Before any scan, the file's comments, strings, template literals,
docstrings and regex literals are blanked while every offset is preserved, so an `import` written
inside a test fixture, a code sample, or a docstring is not a reference at all. Module specifiers
survive the mask, because a specifier is the one string the statement needs.

## How each answer is reached

| Question | Evidence |
|----------|----------|
| Is the target a real module? | The import is resolved against the working tree, so a file the same diff creates resolves. A bundler query or fragment (`./a?raw`) is dropped first, and `.d.ts` counts. Candidate paths offered on a miss come from the index, when the caller has one. |
| Does the target export the name? | The target's **current** content is parsed, never the index, so an export the same diff adds resolves. A barrel is followed to the module that really exports the name. |
| Is the package declared? | Every manifest between the file and the repository root: `package.json` (including `optionalDependencies`), `pyproject.toml` (PEP 621 dependencies and extras, PEP 735 dependency groups, Poetry sections), `requirements*.txt`, `go.mod`, `Cargo.toml`. Internal, so never reported: a name declared by any workspace member a `workspaces` glob names (including a sibling package), a Go import under a declared module path (resolved against the directory of the `go.mod` that declares it), and a Python import of the distribution this repository itself builds, including under a `src/` layout. |
| Is it pinned? | Every lockfile beside the changed manifest: `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`, `poetry.lock`, `uv.lock`, `pdm.lock`, `Pipfile.lock`, `Cargo.lock`, `go.sum`. Any one of them pinning the package settles it, so a stale lockfile beside a live one reports nothing. Python names compare by PEP 503 normalization, Cargo names across `-` and `_`, Go by module prefix. |

Nothing is reported for a standard-library module or a declared dependency, whatever the repository
happens to contain: both are decided before the local-package question, so a local directory named
`json` or `requests` changes no answer.

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

Two limits worth knowing:

- **Untracked files are not in the diff**, so a reference in a brand-new file that has never been
  staged is not checked. `git add` it, and it is.
- **A package reached only through npm hoisting is reported.** If `packages/web` imports a package
  that only `packages/core` declares, that is `undeclared-dependency`: it installs today and breaks
  on a clean per-package install. Declare it where it is used, or set the code to `off`.
