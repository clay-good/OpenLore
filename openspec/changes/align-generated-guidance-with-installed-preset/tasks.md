## 1. Preset-aware generation

- [x] 1.1 Thread the effective preset resolved in `src/cli/install/index.ts` into `ai-config-generator.ts` and the guidance templates.
- [x] 1.2 Gate every tool-naming workflow in the generated guidance on preset membership, resolved against the real preset registry (single source, no duplicated tool list).
- [x] 1.3 Emit the exact enabling command for a workflow whose tool is outside the wired preset, or omit the workflow; never prescribe an uncallable tool.
- [x] 1.4 State the assumed preset in the generated block and in the install summary.

## 2. Conditional orient guidance

- [x] 2.1 Rewrite the orientation instruction in `templates/agent-instructions.md` and `ai-config-generator.ts` as a condition (first touch of a module in this session, or cross-module task) with its stated reason.
- [x] 2.2 Remove the absolute "before reading source files" phrasing from every generated artifact that carries it.

## 3. Coherence contract

- [x] 3.1 Add a conformance test, alongside `default-preset-single-source.test.ts`, that extracts tool names from the generated guidance and fails when one is absent from the wired preset.
- [x] 3.2 Test regeneration on preset change, idempotence on an unchanged preset, and preservation of unmanaged content.

## 4. Verification

- [x] 4.1 Run the tests reaching the install command, the guidance generator, and the preset registry.
- [x] 4.2 Install a scratch repository under the default preset and under `--preset full`; confirm the guidance differs exactly in the tool-dependent workflows.
