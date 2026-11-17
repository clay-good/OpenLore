# IaC deploy binding: which code a Lambda runs

> Status: SHIPPED (2026-11-01). Commands, Serverless, build-output mapping, the `orient` field, and
> the capability moved to `add-iac-deploy-binding-commands`.

## Why

Renaming a Lambda's handler function showed no infrastructure impact, and `find_dead_code` could
call a deployed entry point dead.

## What changes

| Part | What it does |
|------|--------------|
| `deploys_symbol` edge | Terraform `aws_lambda_function.handler` and CloudFormation/SAM `Handler` (+ `CodeUri`, `Globals.Function`) → the indexed function, matched literally |
| Dead code | a bound function is an entry point (`rootKinds.deployed`); unbindable handlers listed in `unresolvedDeployBindings` |
| Impact | `analyze_impact` from the function reaches the resource |
