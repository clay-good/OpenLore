# A smaller product: one copy of each skill, fewer docs, a lean package, a short README

> Priority: P1 · Not built
> Reaches the agent through: the skills that the plugin, `openlore setup` and Pi offer; `openlore --help`. No hook moment and no tool answer changes.
> Why it helps the agent: the agent is offered 11 current skills and no stale ones, and a person finds the few things that matter first.

## Problem

The product surface grew by addition. Measured on 2026-11-14 (main at 0dd75dbef):

- `skills/` holds 11 folder skills and 8 loose `.md` files. The loose files are older versions.
  `package.json` has `pi.skills: ["./skills"]`, so Pi offers the stale files to the agent as skills.
- `docs/mcp-tools.md:255-270` tells users to `curl` two of the stale files.
- `examples/` ships whole in the npm package: 95 files, 907 KB. 4 folders (577 KB) have no
  reference in `src/`, `scripts/`, `docs/`, `README.md` or `.github/`. 2 more folders (142 KB) are
  byte-identical copies of `skills/`. One folder holds absolute paths from a developer machine.
- `docs/` has 4 duplicate pairs, 1 finished roadmap, 4 internal design notes, and 1 page
  (`contracts.md`) that the docs index does not list.
- `openlore --help` lists 60 commands. 5 are called by harness hooks, not by people. 5 commands
  have no group and show as "Other". Two comments say "~49 commands".
- `README.md` is 250 lines in 13 sections.

## What changes

Every item in `skills/`, `docs/`, `scripts/`, `examples/`, `stubs/` and the CLI command list gets
one outcome: SHIP IN PLUGIN, KEEP, MERGE, or DELETE. The full table is in `design.md`.

- **Skills.** The 8 loose files go. The 11 folder skills stay for `openlore setup` (10) and Pi (11).
  The plugin ships 5 folders, one per loop job: `openlore-orient`, `openlore-implement-story`,
  `openlore-write-tests`, `openlore-debug`, and `openlore-review-changes`. The spec pair
  (`openlore-generate`, `openlore-repair`) stays out of the plugin: it calls
  `prepare_spec_generation`/`prepare_spec_repair`, which are OpenSpec-format and not in the `plugin`
  preset. A test fails when a loose file appears beside the folders.
- **Skill copies.** `examples/opencode-skills/` and `examples/mistral-vibe/skills/` are each
  replaced by a 3-line `README.md` that points to `skills/`. The guard test changes in the same task.
- **Examples.** `drift-demo`, `drift-test`, `openspec-analysis` and `openspec-cli` are deleted.
  `package.json` `files` lists the remaining example folders by name and excludes test files.
  The unpacked package loses about 775 KB.
- **Docs.** 3 merges, 6 deleted files, 3 index additions, 1 stale install block fixed. Every
  inbound link is fixed in the same task. A new test checks every relative link.
- **CLI help.** `hook`, `statusline`, `check-edit`, `panic-check` and `panic-level` are hidden from
  `openlore --help`. They still run. `status`, `mapping` and `handoff` get a group. The stale
  "~49" comments lose their number.
- **README.** 7 sections, 120 lines or fewer. The moved content keeps its guards.

## What does not change

- No command, tool, preset, skill folder, config key or field is removed or renamed.
- `openlore setup` installs the same 10 skills from the same paths.
- Pi keeps `pi.skills: ["./skills"]` and still loads all 11 folder skills.
- The default MCP tools are not decided here. `reframe-governance-as-agent-evidence` defines the
  `plugin` preset of 11 pull tools. The README section only reads that list.
- Skill content and the slim digest are not decided here. `adopt-agent-context-interop` owns them.
- No file under `scripts/` is deleted. Only `scripts/postinstall.mjs` ships, as today.
- Advisory, local only, no LLM. Nothing here needs OpenSpec or the `openspec` CLI.

## Limits we disclose

- "Unreferenced" means no match in the tracked files of this repository. A user script that reads
  `node_modules/openlore/examples/opencode-skills/<name>/SKILL.md` breaks. The same bytes are at
  `skills/<name>/SKILL.md`; the changelog and the stub `README.md` say so.
- A link from an outside site to a deleted doc on GitHub will fail. We fix only links in this
  repository and on the npm page (the README).
- Skills that `openlore setup` copied into a repository earlier are not touched or updated.
- The link test checks that the target file exists. It does not check `#anchor` fragments or
  `http` links (no network calls).
- Whether `stubs/` must ship in the package is not assessed. It stays.

## Depends on / order

- **PR #727 (`ship-claude-code-plugin`) merges first.** Until then nothing from this change lands
  in `plugin/`, `README.md`, `docs/`, `scripts/` or `src/`. The plugin session owns those paths.
- `ship-claude-code-plugin` also owns the double-hook problem (`openlore install` plus the plugin
  runs every hook twice). This change does not plan that work.
- `adopt-agent-context-interop` shortens the same 5 skills; this change decides which skills exist
  where.
- `reframe-governance-as-agent-evidence` must be decided before the README task (group 5).
- PR order, safest first: 1 loose skills → 2 docs → 3 examples and package → 4 CLI help →
  5 README → 6 plugin skill list.
