import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import ignoreModule from 'ignore';
import { safeJoin } from '../../utils/path-confinement.js';
import { FilePolicyResolver, repositoryPath } from './policy.js';
const ignore =
  (ignoreModule as typeof ignoreModule & { default?: typeof ignoreModule }).default ?? ignoreModule;
/** Cached metadata only. No recursive survey and no work proportional to source bytes per event. */
export class ConfigurationWatchPolicy {
  private readonly cache = new Map<string, ReturnType<typeof ignore>>();
  private readonly legacy: ReturnType<typeof ignore>;
  constructor(
    private readonly root: string,
    readonly resolver: FilePolicyResolver,
    exclusions: string[] = []
  ) {
    this.legacy = ignore().add(exclusions);
  }
  invalidate(): void {
    this.cache.clear();
  }
  private scope(dir: string): ReturnType<typeof ignore> {
    const cached = this.cache.get(dir);
    if (cached) return cached;
    const matcher = ignore();
    for (const name of dir ? ['.gitignore'] : ['.gitignore', '.openlore-ignore']) {
      let fd: number | undefined;
      try {
        const path = safeJoin(this.root, join(dir, name));
        fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const info = fstatSync(fd);
        if (!info.isFile() || info.size > 64 * 1024)
          throw new Error('Ignore evidence exceeds watch-policy budget');
        matcher.add(readFileSync(fd, 'utf8'));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ELOOP') throw error;
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    }
    if (this.cache.size >= 50_000) throw new Error('Watch-policy directory budget exceeded');
    this.cache.set(dir, matcher);
    return matcher;
  }
  admitted(path: string, directory = false): boolean {
    const rel = repositoryPath(path);
    if (!rel || rel === '.') return true;
    const key = rel + (directory && !rel.endsWith('/') ? '/' : '');
    if (this.legacy.ignores(key) || !this.resolver.admitted(rel, 'watch', true, directory))
      return false;
    const parts = dirname(rel)
      .split('/')
      .filter((p) => p && p !== '.');
    let base = '';
    for (let i = 0; i <= parts.length; i++) {
      if (this.scope(base).ignores(base ? key.slice(base.length + 1) : key)) return false;
      if (i < parts.length) base = base ? base + '/' + parts[i] : parts[i];
    }
    return true;
  }
}
