import { describe, it, expect } from 'vitest';
import { detectInstallMethod, upgradeCommandFor, type InstallEvidence } from './update.js';

describe('detectInstallMethod', () => {
  it('detects Homebrew installs (separator-agnostic)', () => {
    expect(detectInstallMethod('/opt/homebrew/Cellar/openlore/2.1.3/libexec/dist/cli/index.js')).toBe('homebrew');
    expect(detectInstallMethod('/usr/local/Cellar/openlore/2.1.3/dist/cli/update.js')).toBe('homebrew');
    expect(detectInstallMethod('/home/linuxbrew/.linuxbrew/Cellar/openlore/2.1.3/x.js')).toBe('homebrew');
  });

  it('detects npx (transient) installs', () => {
    expect(detectInstallMethod('/Users/x/.npm/_npx/abc123/node_modules/openlore/dist/cli/update.js')).toBe('npx');
  });

  it('detects global npm installs from the POSIX lib/node_modules prefix (no evidence needed)', () => {
    expect(detectInstallMethod('/usr/local/lib/node_modules/openlore/dist/cli/update.js')).toBe('npm-global');
    expect(detectInstallMethod('/Users/x/.nvm/versions/node/v22.5.0/lib/node_modules/openlore/dist/x.js')).toBe('npm-global');
  });

  it('detects a global install from a proven npm root -g (platform-independent)', () => {
    const evidence: InstallEvidence = { npmGlobalRoots: ['/usr/local/lib/node_modules'] };
    expect(
      detectInstallMethod('/usr/local/lib/node_modules/openlore/dist/x.js', evidence)
    ).toBe('npm-global');
  });

  it('classifies a Windows global install identically to POSIX (backslashes + npm root -g)', () => {
    const winPath = 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\openlore\\dist\\cli\\update.js';
    // Windows global has no `lib/` segment — only the npm root -g evidence proves it.
    expect(detectInstallMethod(winPath)).toBe('unknown');
    const evidence: InstallEvidence = {
      npmGlobalRoots: ['C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules'],
    };
    expect(detectInstallMethod(winPath, evidence)).toBe('npm-global');
  });

  it('detects a project-local install only from a declared-dependency evidence signal', () => {
    const posixLocal = '/home/me/proj/node_modules/openlore/dist/cli/update.js';
    // No evidence: a bare node_modules path is genuinely ambiguous → unknown, not a guess.
    expect(detectInstallMethod(posixLocal)).toBe('unknown');
    expect(detectInstallMethod(posixLocal, { declaredAsProjectDependency: true })).toBe('npm-local');

    const winLocal = 'C:\\proj\\node_modules\\openlore\\dist\\cli\\update.js';
    expect(detectInstallMethod(winLocal, { declaredAsProjectDependency: true })).toBe('npm-local');
  });

  it('returns unknown for unrecognized paths', () => {
    expect(detectInstallMethod('/some/random/checkout/dist/cli/update.js')).toBe('unknown');
  });

  it('discloses contradictory evidence as unknown (never a guessed mutating method)', () => {
    // A POSIX global prefix AND a declared-dependency signal cannot both be true.
    const evidence: InstallEvidence = { declaredAsProjectDependency: true };
    expect(
      detectInstallMethod('/usr/local/lib/node_modules/openlore/dist/x.js', evidence)
    ).toBe('unknown');
  });

  it('is case-insensitive', () => {
    expect(detectInstallMethod('/opt/HomeBrew/Cellar/openlore/x.js')).toBe('homebrew');
  });
});

describe('upgradeCommandFor', () => {
  it('maps each method to the correct upgrade command', () => {
    expect(upgradeCommandFor('homebrew')).toEqual({ cmd: 'brew', args: ['upgrade', 'openlore'] });
    expect(upgradeCommandFor('npm-global')).toEqual({ cmd: 'npm', args: ['install', '-g', 'openlore@latest'] });
    // Project-local upgrade is per-project — no `-g`. runUpdate only prints it.
    expect(upgradeCommandFor('npm-local')).toEqual({ cmd: 'npm', args: ['install', 'openlore@latest'] });
    expect(upgradeCommandFor('npx')).toBeNull();
    expect(upgradeCommandFor('unknown')).toBeNull();
  });

  it('never issues a global mutation for a project-local install', () => {
    const local = upgradeCommandFor('npm-local');
    expect(local?.args).not.toContain('-g');
  });

  it('resolves the exact Windows invocation printed by --dry-run', () => {
    expect(upgradeCommandFor('npm-global', 'win32', {
      nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
      pathValue: '',
      fileExists: () => true,
    })).toEqual({
      cmd: 'C:\\Program Files\\nodejs\\node.exe',
      args: ['C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js', 'install', '-g', 'openlore@latest'],
    });
  });
});
