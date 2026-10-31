# Phantom-reference findings: imports, symbols, and packages that do not exist

> Status: PROPOSED (2026-10-31, `CONTRACT-GRAPH-AND-AGENT-LOOP-2026-10.md`). Registered advisory
> findings in `verify_change` (including its speculative `patch` input). No new tool.

## The gap

Agents invent APIs and packages. At least 5.2% of packages suggested by commercial models and 21.7%
by open models do not exist, and 58% of those recur across runs — which is what makes
"slopsquatting" (registering the invented name) an attack (https://arxiv.org/abs/2406.10279). Prompt
wording alone drives invented libraries in up to 84% of tasks (https://arxiv.org/abs/2509.22202), and
static checks catch a large share of them (https://arxiv.org/abs/2604.07755). The common shapes:

- an import of an internal module path or named export that is not in the repo;
- a call to a member that the imported internal module does not export;
- an import of an external package that no manifest declares, or that the lockfile does not pin.

OpenLore already resolves imports (`import-parser.ts`, `import-resolver-bridge.ts`), knows every
indexed export, reads direct dependencies from npm/pip/cargo/go manifests
(`external-packages.ts`), and reads workspace declarations (`workspace-shards.ts`). It does not
report a reference that resolves to nothing, and it reads no lockfile.

## What changes

For references the diff **adds** (never the whole repo):

| Code | Shape |
|---|---|
| `unresolved-internal-import` | a relative or workspace-alias import whose target file is not in the corpus |
| `unresolved-internal-symbol` | a named import, or a member access on an imported internal module, that the target does not export |
| `undeclared-dependency` | a bare external specifier that no manifest in scope declares (`package.json` deps incl. workspaces, `pyproject.toml`/`requirements*.txt`, `go.mod`, `Cargo.toml`) |
| `unpinned-dependency` | declared in a manifest the diff also changed, but absent from the lockfile beside it (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `poetry.lock`/`uv.lock`, `go.sum`, `Cargo.lock`) |

Standard-library modules and language builtins are a closed per-language allow list. Each finding
carries the file, line, and specifier, and — for internal misses — up to 3 exact-prefix candidates
from the index (the `find_clones` not-found discipline), never a similarity guess.

Through `verify_change`'s `patch` input, this runs **before** the file is written, so a PreToolUse
or PostToolBatch hook can tell the agent "`@acme/utils/formatDate` is not exported by
`packages/utils`" while the edit is still a proposal.

## Honesty contract

- A language without import support in the language-support matrix yields `not-assessed`, never
  "all references resolve".
- Path aliases are resolved only through the project's own `tsconfig` `paths` / bundler config the
  import resolver already reads; an alias it cannot resolve is a disclosed boundary, not an
  `unresolved-internal-import`.
- Dynamic imports with non-literal specifiers are disclosed, not checked.

## Not built

Any package-registry or network lookup (the check is local; a name being *declared* does not prove it
is safe — that is supply-chain tooling's job); version-range or vulnerability checks (see
`add-dependency-impact-analysis`, `add-vuln-reachability-triage`); type checking of member signatures
(see `add-lsp-evidence-tier`).

## Impact

- Files: extend `external-packages.ts` (manifests) and reuse `workspace-shards.ts` (workspaces);
  lockfile readers (new, small, per ecosystem); stdlib allow lists; added-reference
  extraction over the diff, resolution against the index, finding registration, `verify_change`
  projection.
- Specs: `mcp-handlers` — 1 ADDED.
- Tool surface: none added.
