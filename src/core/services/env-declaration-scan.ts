/**
 * Find the infrastructure files of a repository and the env-var declaration sites in them
 * (change: add-iac-code-binding). Computed at query time from the working tree — no persisted
 * artifact, no edit to the analyze walk — and classified exactly as `analyze` classifies IaC files.
 *
 * The scan is bounded (file count and size) and says what it did not read: Helm templates (not
 * rendered), files past a cap, and files it could not read.
 */

import { readFileConfined } from '../../utils/path-confinement.js';
import { execFileGit } from '../../utils/git-exec.js';
import { gitPathArgs } from '../../utils/git-args.js';
import { detectLanguage } from '../analyzer/language-detection.js';
import { classifyYaml, isDockerfilePath } from '../analyzer/iac/index.js';
import { extractEnvDeclarations, type EnvDeclaration, type OpaqueEnvSource } from '../analyzer/iac/env-declarations.js';

const MAX_FILES = 3000;
const MAX_BYTES = 1024 * 1024;
const SKIP_DIR = /(?:^|\/)(?:node_modules|vendor|dist|build|\.git|\.openlore)\//;
/** JSON files that are never infrastructure. */
const NOT_IAC_JSON = /(?:^|\/)(?:package(?:-lock)?|tsconfig[^/]*|composer|\.?eslintrc[^/]*)\.json$/i;

export interface EnvDeclarationIndex {
  declarations: EnvDeclaration[];
  opaque: OpaqueEnvSource[];
  /** Infrastructure files read. */
  filesScanned: number;
  /** What the scan did not cover, in plain sentences. */
  boundaries: string[];
}

/** Candidate paths: Dockerfiles, Terraform/OpenTofu, and YAML/JSON that may be IaC. */
function isCandidate(path: string): boolean {
  if (SKIP_DIR.test(path) || NOT_IAC_JSON.test(path)) return false;
  return isDockerfilePath(path) || detectLanguage(path) === 'Terraform' || /\.(?:ya?ml|json)$/i.test(path);
}

export async function scanEnvDeclarations(root: string): Promise<EnvDeclarationIndex> {
  const boundaries: string[] = [];
  let paths: string[];
  try {
    const { stdout } = await execFileGit('git', gitPathArgs('ls-files', '-z', '--cached', '--others', '--exclude-standard'), { cwd: root, maxBuffer: 64 * 1024 * 1024 });
    paths = [...new Set(String(stdout).split('\0').filter(p => p && isCandidate(p)))].sort();
  } catch {
    return { declarations: [], opaque: [], filesScanned: 0, boundaries: ['Infrastructure files were not scanned: files are listed through git and this is not a git work tree.'] };
  }
  if (paths.length > MAX_FILES) boundaries.push(`Infrastructure files were read from the first ${MAX_FILES} of ${paths.length} candidate files.`);

  // Helm chart directories: their templates need rendering, which is out of scope.
  const chartDirs = paths.filter(p => /(?:^|\/)Chart\.ya?ml$/.test(p)).map(p => p.replace(/\/?Chart\.ya?ml$/, ''));
  const underChart = (p: string) => chartDirs.some(d => d === '' || p.startsWith(`${d}/`));

  const declarations: EnvDeclaration[] = [];
  const opaque: OpaqueEnvSource[] = [];
  let filesScanned = 0;
  let unread = 0;
  let helm = 0;
  for (const path of paths.slice(0, MAX_FILES)) {
    let content: string;
    try {
      content = await readFileConfined(root, path, MAX_BYTES);
    } catch {
      unread++;
      continue;
    }
    let language = detectLanguage(path);
    if (language === 'unknown') {
      if (isDockerfilePath(path)) language = 'Dockerfile';
      else if (underChart(path)) { helm++; continue; }
      else language = classifyYaml(path, content) ?? 'unknown';
    }
    if (!['Dockerfile', 'Terraform', 'Kubernetes', 'Docker Compose', 'CloudFormation', 'GitHub Actions'].includes(language)) continue;
    filesScanned++;
    const scan = extractEnvDeclarations({ path, content, language });
    declarations.push(...scan.declarations);
    opaque.push(...scan.opaque);
  }
  if (unread) boundaries.push(`${unread} candidate infrastructure file(s) could not be read (over 1 MB, a link out of the repository, or an I/O error).`);
  if (helm) boundaries.push(`${helm} file(s) in Helm charts were not read: templates set variables only once rendered.`);
  const byLoc = (a: { file: string; line: number }, b: { file: string; line: number }) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line);
  return { declarations: declarations.sort(byLoc), opaque: opaque.sort(byLoc), filesScanned, boundaries };
}
