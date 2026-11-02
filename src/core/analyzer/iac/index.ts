/**
 * IaC graph builder (spec-07).
 *
 * Dispatches files by language to the per-ecosystem parsers, merges their
 * normalized resource graphs, and projects the result onto the existing
 * FunctionNode/CallEdge/ClassNode primitives. Kept thin on purpose: all
 * parsing lives in the sibling ecosystem modules, mirroring src/core/scip/.
 */

import { extractTerraform } from './terraform.js';
import { extractKubernetes } from './kubernetes.js';
import { extractHelm } from './helm.js';
import { extractCloudFormation } from './cloudformation.js';
import { extractAnsible } from './ansible.js';
import { extractPulumi } from './pulumi.js';
import { extractCdk } from './cdk.js';
import { extractDocker } from './docker.js';
import { extractGitHubActions } from './github-actions.js';
import { extractBicep } from './bicep.js';
import { extractServerless } from './serverless.js';
import { projectIacGraph, type ProjectedIac } from './project.js';
import { mergeIacGraphs, emptyIacGraph, type IacGraph } from './types.js';

export { isIacLanguage, IAC_LANGUAGES } from './types.js';
export { classifyYaml } from './classify-yaml.js';
export { isDockerfilePath } from './docker.js';
export { isServerlessPath, looksLikeServerless } from './serverless.js';
export { isWorkflowPath, isActionMetadataPath } from './github-actions.js';
export type { ProjectedIac } from './project.js';

interface InFile { path: string; content: string; language: string }

/** Build the normalized IaC graph from a mixed file set (no projection). */
export function buildIacGraph(files: InFile[], failures?: string[]): IacGraph {
  const byLang = (lang: string) => files.filter((f) => f.language === lang);
  /**
   * Run one ecosystem's extractor in isolation.
   *
   * A throw used to take the WHOLE projection with it — one YAML file with heavy anchor reuse
   * trips the `yaml` library's own alias-count guard, and the entire infrastructure graph
   * disappeared with no disclosure anywhere. `classifyYaml` is a heuristic (no parse), so a file
   * it tags Kubernetes may be anything. One failing ecosystem must not cost the other ten, and
   * what failed must be named.
   */
  const safely = (ecosystem: string, run: () => IacGraph): IacGraph => {
    try {
      return run();
    } catch (error) {
      failures?.push(`${ecosystem}: ${error instanceof Error ? error.message : String(error)}`);
      return emptyIacGraph();
    }
  };
  const generalPurpose = files.filter(
    (f) => f.language === 'TypeScript' || f.language === 'JavaScript' || f.language === 'Python' || f.language === 'Go',
  );
  const graphs: IacGraph[] = [
    safely('Terraform', () => extractTerraform(byLang('Terraform'))),
    safely('Kubernetes', () => extractKubernetes(byLang('Kubernetes'))),
    safely('Helm', () => extractHelm(byLang('Helm'))),
    safely('CloudFormation', () => extractCloudFormation(byLang('CloudFormation'))),
    safely('Ansible', () => extractAnsible(byLang('Ansible'))),
    // Pulumi, CDK, and CDKTF ride on existing general-purpose languages, not an IaC tag.
    safely('Pulumi', () => extractPulumi(generalPurpose)),
    safely('CDK', () => extractCdk(generalPurpose)),
    // Dockerfiles + compose are cross-referential, so one extractor sees both.
    safely('Docker', () => extractDocker(files.filter((f) => f.language === 'Dockerfile' || f.language === 'Docker Compose'))),
    // Workflows + composite/reusable actions are cross-referential, so one extractor sees both.
    safely('GitHub Actions', () => extractGitHubActions(byLang('GitHub Actions'))),
    // Bicep is its own DSL, tagged by the `.bicep` extension.
    safely('Bicep', () => extractBicep(byLang('Bicep'))),
    // Serverless service manifests, tagged by file name + content (change: add-iac-deploy-binding-commands).
    safely('Serverless', () => extractServerless(byLang('Serverless'))),
  ];
  return mergeIacGraphs(graphs);
}

/** Build and project the IaC graph onto existing graph primitives. */
export function buildProjectedIac(files: InFile[]): ProjectedIac {
  return projectIacGraph(buildIacGraph(files));
}
