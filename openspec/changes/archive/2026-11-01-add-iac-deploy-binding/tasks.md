# Tasks — add-iac-deploy-binding

- [x] Handler capture: Terraform `aws_lambda_function.handler` (HCL and JSON), CloudFormation/SAM `Handler` + `CodeUri` with `Globals.Function`; images skipped
- [x] Literal resolver (`<module>.<export>`, dotted Python modules, code location / repository root / template directory, source extensions, `index`); unresolved with reason (expression, intrinsic, build-output path, missing file, missing or duplicated function)
- [x] `deploys_symbol` edge kind (edge store accepts it); `find_dead_code` treats bound functions as entry points (`rootKinds.deployed`) and lists `unresolvedDeployBindings`; `analyze_impact` reaches the resource
- [x] Tests: Terraform and SAM bind; every unresolved reason; no similarity matching; end-to-end analyze on a fixture
- [x] Moved to `add-iac-deploy-binding-commands`: Dockerfile/Kubernetes commands, Serverless, build-output mapping, `orient` field, `iacCodeBinding`
