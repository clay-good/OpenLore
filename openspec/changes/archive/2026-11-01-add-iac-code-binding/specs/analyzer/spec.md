# analyzer spec delta

## ADDED Requirements

### Requirement: OpenTofuFilesAreTerraform

Language detection SHALL classify files ending in `.tofu` or `.tofu.json` as Terraform, so the
Terraform/HCL extractor projects them exactly as it projects `.tf` and `.tf.json` files.

#### Scenario: An OpenTofu file yields the same resources

- **GIVEN** a `main.tofu` file and a `main.tf` file with identical content in two otherwise identical
  repositories
- **WHEN** both repositories are analyzed
- **THEN** both graphs contain the same Terraform resource nodes and edges
