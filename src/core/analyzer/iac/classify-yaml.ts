/**
 * Content-based disambiguation for ambiguous IaC file extensions (spec-07).
 *
 * `.yaml`/`.yml`/`.json` are used by Kubernetes, CloudFormation, Helm, Ansible,
 * and plain config alike. `detectLanguage` can only see the extension, so it
 * routes these through `classifyYaml`, a small pure function that inspects path
 * + content. When unsure, return `null` (→ `unknown`): never force a
 * classification onto generic YAML (CI configs, docker-compose, app config).
 */

import type { IacLanguage } from './types.js';
import { isWorkflowPath, isActionMetadataPath } from './github-actions.js';

/*
 * A NOTE ON THE INDENT CLASS, which every probe below depends on.
 *
 * Indentation is written `[ \t]`, never `\s`. `\s` matches `\n`, so `(^|\n)\s*KEY`
 * rescans every remaining newline to end-of-file from each of O(n) line starts and then
 * gives them back one character at a time — quadratic, on a payload of pure newlines
 * that costs the attacker nothing and looks like whitespace in a diff. Five such probes
 * ran back to back over the whole file here, and they compounded: measured on the real
 * `classifyYaml`, a 50 KB `.yaml` file of newlines cost 55.6 s (the report's own run:
 * 94 s), and the 4 MB source cap is 80x that size again.
 *
 * Narrowing the class is a semantic no-op for these probes: a newline inside "the
 * indentation of this line" is a contradiction — it means a DIFFERENT line, which the
 * `(^|\n)` anchor already matches at. Whitespace in a VALUE position (after the `:`) is
 * different — YAML really does allow a scalar to begin on the next line — so those runs
 * keep `\s` and are length-bounded instead, which is linear without narrowing what
 * matches for any input a human would write.
 */

/**
 * Classify an ambiguous `.yaml`/`.yml`/`.json` file by its path + content.
 * Returns the IaC language, or `null` when the file is not recognizably IaC.
 *
 * Note: Helm chart membership that depends on an ancestor `Chart.yaml` is
 * resolved by the caller (it needs the file set); here we only catch the
 * unambiguous Helm signal of a `{{ … }}` template under a `templates/` dir.
 */
export function classifyYaml(path: string, content: string): IacLanguage | null {
  const posix = path.replace(/\\/g, '/');
  const lower = posix.toLowerCase();
  const fileName = posix.split('/').pop() ?? '';

  // Helm chart metadata files (unambiguous by name).
  if (fileName === 'Chart.yaml' || fileName === 'Chart.yml') return 'Helm';

  // GitHub Actions — workflow (in .github/workflows/ with on:+jobs:) or action metadata
  // (action.y?ml with a runs: block). Path is the strong signal; the content key
  // corroborates so a stray same-located file is not misclassified.
  if (isWorkflowPath(posix) && /(^|\n)on[ \t]*:/.test(content) && /(^|\n)jobs[ \t]*:/.test(content)) {
    return 'GitHub Actions';
  }
  if (isActionMetadataPath(posix) && /(^|\n)runs[ \t]*:/.test(content)) {
    return 'GitHub Actions';
  }

  // docker-compose — by conventional filename (docker-compose*.yml, compose*.yml),
  // corroborated by a top-level `services:` key so a stray same-named file is not
  // misclassified (add-docker-container-graph).
  if (/^(docker-compose|compose)(\.[^/]+)?\.ya?ml$/.test(fileName) && /(^|\n)services[ \t]*:/.test(content)) {
    return 'Docker Compose';
  }

  // Helm template: a Go-template expression inside a templates/ directory.
  const inTemplatesDir = /(^|\/)templates\//.test(posix);
  if (inTemplatesDir && /\{\{[-\s]/.test(content)) return 'Helm';

  // CloudFormation / SAM — explicit format markers.
  if (
    /(^|\n)[ \t]*AWSTemplateFormatVersion[ \t]*:/.test(content) ||
    /(^|\n)[ \t]*Transform[ \t]*:\s{0,80}['"]?AWS::Serverless/.test(content) ||
    isCloudFormationResources(content)
  ) {
    return 'CloudFormation';
  }

  // Kubernetes — apiVersion + kind at (near) the top level of a document.
  if (isKubernetesManifest(content)) return 'Kubernetes';

  // Ansible — playbook (top-level hosts/tasks/roles) or role-tree location.
  if (isAnsiblePath(lower) || isAnsiblePlaybook(content)) return 'Ansible';

  return null;
}

/** `Resources:` block whose entries carry `Type: AWS::…` (CFN without the header). */
function isCloudFormationResources(content: string): boolean {
  if (!/(^|\n)Resources[ \t]*:/.test(content)) return false;
  return /(^|\n)[ \t]+Type[ \t]*:\s{0,80}['"]?(AWS|Alexa|Custom)::/.test(content);
}

/** Any YAML document declaring both `apiVersion:` and `kind:`. */
function isKubernetesManifest(content: string): boolean {
  // Inspect each `---`-separated document; K8s objects pair apiVersion + kind.
  for (const doc of content.split(/^---\s*$/m)) {
    const hasApiVersion = /(^|\n)[ \t]*apiVersion[ \t]*:/.test(doc);
    const hasKind = /(^|\n)[ \t]*kind[ \t]*:/.test(doc);
    if (hasApiVersion && hasKind) return true;
  }
  return false;
}

/** Located under an Ansible role tree (`roles/<name>/{tasks,handlers,...}/`). */
function isAnsiblePath(lowerPath: string): boolean {
  return /(^|\/)roles\/[^/]+\/(tasks|handlers|defaults|vars|meta)\//.test(lowerPath);
}

/** Top-level playbook markers: a list of plays with hosts/tasks/roles. */
function isAnsiblePlaybook(content: string): boolean {
  // Playbooks are a top-level list; plays declare `hosts:` and usually
  // `tasks:`/`roles:`. Match a `- hosts:` item or a top-level tasks/handlers file.
  if (/(^|\n)[ \t]*-[ \t]+hosts[ \t]*:/.test(content)) return true;
  // A list whose play items carry a `hosts:` key (possibly after `- name:`).
  if (/(^|\n)[ \t]*-\s/.test(content) && /(^|\n)[ \t]+hosts[ \t]*:/.test(content)) return true;
  // tasks/handlers main.yml in a role: a top-level list whose items have `name:`
  // plus a module key — too weak alone, so require an Ansible-specific keyword.
  if (/(^|\n)[ \t]*-[ \t]+(name|block|include_tasks|import_tasks|ansible\.builtin)[ \t]*:/.test(content)) {
    return /(^|\n)[ \t]*(notify|register|when|loop|with_items|become|ansible\.builtin\.)[ \t]*:/.test(content)
      || /(^|\n)[ \t]*-[ \t]+(include_tasks|import_tasks|ansible\.builtin\.)/.test(content);
  }
  return false;
}
