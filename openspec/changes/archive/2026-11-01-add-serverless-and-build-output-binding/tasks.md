# Tasks — add-serverless-and-build-output-binding

- [x] Serverless reader (`serverless.yml`/`.yaml`/`.json`), `functions.*.handler` binding, classification + dispatch + conformance fixture
- [x] Build-output mapping through `tsconfig` `outDir`/`rootDir` and a package `main`/`source` pair, passed into the builder
- [x] An unmapped `outDir` handler stays unresolved with the reason
- [x] Serverless `provider.environment` / `functions.*.environment` read by the env-declaration scan
- [x] `orient` additive field: the resource that runs a function in scope, and the sites that set the env vars it reads, budgeted
- [x] Language-support capability `iacCodeBinding`
- [x] Spec: `analyzer` ADD ServerlessFunctionsBindToTheirHandlers, ADD BuiltHandlersResolveThroughTheProjectsOwnMapping; `mcp-handlers` ADD OrientShowsTheInfrastructureAHandlerDependsOn
- [x] Docs: `docs/iac.md` (Serverless, built output), `docs/language-support.md` (the capability)
