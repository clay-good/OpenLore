/**
 * One-hop env-helper binding (change: follow-env-name-through-helper).
 *
 * The failing-first case is real: GoogleCloudPlatform/microservices-demo passes every
 * service address through `mustMapEnv(&target, "NAME")`, so `analyze_env_impact` reported
 * ONE Python read site for `PRODUCT_CATALOG_SERVICE_ADDR` while two Go services read it,
 * and said nothing about the gap.
 *
 * Every test below is either a BINDING that must be provable from literal text, or a
 * REFUSAL that must be counted in `unfollowed` instead of guessed.
 */

import { describe, it, expect } from 'vitest';
import { scanEnvHelperBindings, MAX_CALL_SITES_PER_WRAPPER } from './env-helper-binding.js';
import { extractEnvReadSites } from './env-extractor.js';

// ── The real Go case, verbatim in shape ──────────────────────────────────────
const GO_REAL = `package main

import (
	"fmt"
	"os"
)

func main() {
	svc := new(frontendServer)
	mustMapEnv(&svc.productCatalogSvcAddr, "PRODUCT_CATALOG_SERVICE_ADDR")
	mustMapEnv(&svc.currencySvcAddr, "CURRENCY_SERVICE_ADDR")
}

func mustMapEnv(target *string, envKey string) {
	v := os.Getenv(envKey)
	if v == "" {
		panic(fmt.Sprintf("environment variable %q not set", envKey))
	}
	*target = v
}
`;

describe('scanEnvHelperBindings — the Go helper case that started this', () => {
  it('binds both call sites to the literal they name, at the CALL SITE file and line', () => {
    const scan = scanEnvHelperBindings(GO_REAL, 'src/frontend/main.go', '.go');
    expect(scan.bindings).toEqual([
      {
        name: 'PRODUCT_CATALOG_SERVICE_ADDR',
        file: 'src/frontend/main.go',
        line: 10,
        required: false,
        via: { helper: 'mustMapEnv', file: 'src/frontend/main.go', line: 15 },
      },
      {
        name: 'CURRENCY_SERVICE_ADDR',
        file: 'src/frontend/main.go',
        line: 11,
        required: false,
        via: { helper: 'mustMapEnv', file: 'src/frontend/main.go', line: 15 },
      },
    ]);
  });

  it('does NOT report the helper\'s own os.Getenv(envKey) as a read of a named variable', () => {
    const sites = extractEnvReadSites(GO_REAL, 'src/frontend/main.go', '.go');
    // Line 15 is `v := os.Getenv(envKey)`: no site may claim it names a variable.
    expect(sites.some(s => s.line === 15)).toBe(false);
    expect(sites.map(s => [s.name, s.line])).toEqual([
      ['PRODUCT_CATALOG_SERVICE_ADDR', 10],
      ['CURRENCY_SERVICE_ADDR', 11],
    ]);
    // The mechanism is disclosed on every bound site, never presented as a direct read.
    for (const s of sites) expect(s.via).toEqual({ helper: 'mustMapEnv', file: 'src/frontend/main.go', line: 15 });
  });

  it('once bound, nothing is left unfollowed for that read', () => {
    expect(scanEnvHelperBindings(GO_REAL, 'main.go', '.go').unfollowed).toEqual([]);
  });
});

// ── The other three languages ────────────────────────────────────────────────
describe('scanEnvHelperBindings — Python, TS/JS and Ruby equivalents', () => {
  it('binds a Python helper whose parameter flows into os.environ.get', () => {
    const src = [
      'import os',
      '',
      'def must_map_env(env_key):',
      '    v = os.environ.get(env_key)',
      '    if not v:',
      '        raise SystemExit(env_key)',
      '    return v',
      '',
      'CATALOG = must_map_env("PRODUCT_CATALOG_SERVICE_ADDR")',
    ].join('\n') + '\n';
    const scan = scanEnvHelperBindings(src, 'server.py', '.py');
    expect(scan.bindings).toEqual([{
      name: 'PRODUCT_CATALOG_SERVICE_ADDR',
      file: 'server.py',
      line: 9,
      required: true,
      via: { helper: 'must_map_env', file: 'server.py', line: 4 },
    }]);
  });

  it('binds a Python strict subscript helper and keeps the hard-break verdict', () => {
    const src = 'import os\n\ndef need(key):\n    return os.environ[key]\n\nX = need("SECRET_KEY")\n';
    expect(scanEnvHelperBindings(src, 'a.py', '.py').bindings[0]).toMatchObject({ name: 'SECRET_KEY', line: 6, required: true });
  });

  it('takes the soft verdict from a Python helper that passes a default', () => {
    const src = 'import os\n\ndef opt(key):\n    return os.environ.get(key, "d")\n\nX = opt("TZ")\n';
    expect(scanEnvHelperBindings(src, 'a.py', '.py').bindings[0]).toMatchObject({ name: 'TZ', required: false });
  });

  it('binds a TS helper reading process.env[param], through both declaration forms', () => {
    const src = [
      'export function readEnv(key: string) {',
      '  return process.env[key];',
      '}',
      'const readEnv2 = (key) => {',
      '  return process.env[key];',
      '};',
      'const a = readEnv("DATABASE_URL");',
      'const b = readEnv2("REDIS_URL");',
    ].join('\n') + '\n';
    const scan = scanEnvHelperBindings(src, 'src/config.ts', '.ts');
    expect(scan.bindings.map(b => [b.name, b.line, b.required, b.via.helper])).toEqual([
      ['DATABASE_URL', 7, true, 'readEnv'],
      ['REDIS_URL', 8, true, 'readEnv2'],
    ]);
  });

  it('carries a TS site-local ?? fallback through to the bound site', () => {
    const src = 'function readEnv(key) {\n  return process.env[key] ?? "d";\n}\nconst a = readEnv("PORT");\n';
    expect(scanEnvHelperBindings(src, 'a.js', '.js').bindings[0]).toMatchObject({ name: 'PORT', required: false });
  });

  it('binds a Ruby helper reading ENV[param]', () => {
    const src = [
      'def must_map_env(env_key)',
      '  v = ENV[env_key]',
      '  raise env_key if v.nil?',
      '  v',
      'end',
      '',
      'ADDR = must_map_env("CART_SERVICE_ADDR")',
    ].join('\n') + '\n';
    expect(scanEnvHelperBindings(src, 'app.rb', '.rb').bindings).toEqual([{
      name: 'CART_SERVICE_ADDR',
      file: 'app.rb',
      line: 7,
      required: false,
      via: { helper: 'must_map_env', file: 'app.rb', line: 2 },
    }]);
  });

  it('keeps a Ruby ENV.fetch helper with no default a hard break', () => {
    const src = 'def need(k)\n  ENV.fetch(k)\nend\n\nX = need("API_KEY")\n';
    expect(scanEnvHelperBindings(src, 'a.rb', '.rb').bindings[0]).toMatchObject({ name: 'API_KEY', required: true });
  });

  it('returns nothing at all for a language the extractor does not scan', () => {
    const src = 'fn need(k: &str) -> String { std::env::var(k).unwrap() }\nlet x = need("PORT");\n';
    expect(scanEnvHelperBindings(src, 'a.rs', '.rs')).toEqual({ bindings: [], unfollowed: [], callSiteCapHit: false });
  });
});

// ── Refusals: one per condition, each COUNTED rather than guessed ─────────────
describe('scanEnvHelperBindings — refusals are counted, never guessed', () => {
  const refuses = (src: string, rel: string, ext: string, reason: RegExp): void => {
    const scan = scanEnvHelperBindings(src, rel, ext);
    expect(scan.bindings).toEqual([]);
    expect(scan.unfollowed.length).toBeGreaterThan(0);
    expect(scan.unfollowed.map(u => u.reason).join(' | ')).toMatch(reason);
  };

  it('refuses a non-literal argument at the call site', () => {
    refuses(
      'package main\nfunc main() {\n\tk := "PORT"\n\tneed(k)\n}\nfunc need(key string) {\n\t_ = os.Getenv(key)\n}\n',
      'main.go', '.go', /no call site .* passes a plain string literal/,
    );
  });

  it('refuses a concatenated key inside the helper', () => {
    refuses(
      'package main\nfunc main() {\n\tneed("PORT")\n}\nfunc need(key string) {\n\t_ = os.Getenv("APP_" + key)\n}\n',
      'main.go', '.go', /computed expression, not a bare parameter/,
    );
  });

  it('refuses a reassignment between the parameter and the read', () => {
    refuses(
      'package main\nfunc main() {\n\tneed("PORT")\n}\nfunc need(key string) {\n\tkey = "OTHER"\n\t_ = os.Getenv(key)\n}\n',
      'main.go', '.go', /reassigned, shadowed, or rebound/,
    );
  });

  it('refuses a two-hop wrapper: only the direct hop is ever followed', () => {
    const src = [
      'package main',
      'func main() {',
      '\touter("PORT")',       // names the variable, but two hops from the read
      '}',
      'func outer(key string) {',
      '\tinner(key)',          // non-literal argument → not followed
      '}',
      'func inner(key string) {',
      '\t_ = os.Getenv(key)',
      '}',
    ].join('\n') + '\n';
    refuses(src, 'main.go', '.go', /no call site of `inner` .* plain string literal/);
  });

  it('refuses a shadowed parameter (an inner closure parameter of the same name)', () => {
    const src = [
      'package main',
      'func main() {',
      '\tneed("PORT")',
      '}',
      'func need(key string) {',
      '\tf := func(key string) string { return os.Getenv(key) }',
      '\t_ = f("OTHER")',
      '}',
    ].join('\n') + '\n';
    refuses(src, 'main.go', '.go', /reassigned, shadowed, or rebound/);
  });

  it('refuses a template-literal argument in TS', () => {
    refuses(
      'function need(key) { return process.env[key]; }\nconst a = need(`DATABASE_${suffix}`);\n',
      'a.ts', '.ts', /plain string literal/,
    );
  });

  it('refuses a METHOD call: obj.need("X") is not provably this free function', () => {
    const src = 'function need(key) { return process.env[key]; }\nconst a = cfg.need("DATABASE_URL");\n';
    refuses(src, 'a.ts', '.ts', /plain string literal/);
  });

  it('refuses a parameter with a default, whose position a caller may omit', () => {
    refuses(
      'function need(key = "PORT", other) { return process.env[key]; }\nconst a = need("DATABASE_URL");\n',
      'a.ts', '.ts', /parameter list that cannot be matched/,
    );
  });

  it('refuses when two parameters both feed an environment read', () => {
    const src = [
      'package main',
      'func main() {',
      '\tneed("A_VAR", "B_VAR")',
      '}',
      'func need(a string, b string) {',
      '\t_ = os.Getenv(a)',
      '\t_ = os.Getenv(b)',
      '}',
    ].join('\n') + '\n';
    refuses(src, 'main.go', '.go', /more than one parameter/);
  });

  it('refuses a key that is a local value, not a parameter', () => {
    refuses(
      'package main\nfunc need(other string) {\n\tkey := compute()\n\t_ = os.Getenv(key)\n}\nfunc main() { need("X_VAR") }\n',
      'main.go', '.go', /local value, not a parameter/,
    );
  });

  it('refuses a read outside any top-level free function', () => {
    refuses(
      'package main\nvar k = pick()\nvar v = os.Getenv(k)\n',
      'main.go', '.go', /not inside a top-level free function/,
    );
  });

  it('refuses a commented-out call site, and never invents a read from dead text', () => {
    const src = [
      'package main',
      'func main() {',
      '\t// mustMapEnv(&x, "GHOST_VAR")',
      '}',
      'func mustMapEnv(target *string, envKey string) {',
      '\t_ = os.Getenv(envKey)',
      '}',
    ].join('\n') + '\n';
    const scan = scanEnvHelperBindings(src, 'main.go', '.go');
    expect(scan.bindings).toEqual([]);
    expect(scan.unfollowed.length).toBe(1);
  });

  it('never binds a same-named helper in another file: binding is same-file only', () => {
    // The helper lives in one file; the literal call site in another. Each file is
    // scanned alone, so neither can see the other — the read stays unfollowed.
    const helper = 'package main\nfunc mustMapEnv(target *string, envKey string) {\n\t_ = os.Getenv(envKey)\n}\n';
    const caller = 'package main\nfunc main() {\n\tmustMapEnv(&x, "PRODUCT_CATALOG_SERVICE_ADDR")\n}\n';
    expect(scanEnvHelperBindings(helper, 'a.go', '.go').bindings).toEqual([]);
    expect(scanEnvHelperBindings(helper, 'a.go', '.go').unfollowed).toHaveLength(1);
    expect(scanEnvHelperBindings(caller, 'b.go', '.go').bindings).toEqual([]);
  });
});

// ── Bounds and hostile input ─────────────────────────────────────────────────
describe('scanEnvHelperBindings — bounds and hostile input', () => {
  it('caps the call sites followed per helper and discloses the cap', () => {
    const calls = Array.from({ length: 5000 }, (_, i) => `\tneed("VAR_${i}")`).join('\n');
    const src = `package main\nfunc main() {\n${calls}\n}\nfunc need(key string) {\n\t_ = os.Getenv(key)\n}\n`;
    const scan = scanEnvHelperBindings(src, 'main.go', '.go');
    expect(scan.callSiteCapHit).toBe(true);
    expect(scan.bindings.length).toBeLessThanOrEqual(MAX_CALL_SITES_PER_WRAPPER);
    expect(scan.bindings.length).toBeGreaterThan(0);
  });

  it('is linear in the call-site fan-out', () => {
    const build = (n: number): string => {
      const calls = Array.from({ length: n }, (_, i) => `\tneed("VAR_${i}")`).join('\n');
      return `package main\nfunc main() {\n${calls}\n}\nfunc need(key string) {\n\t_ = os.Getenv(key)\n}\n`;
    };
    const small = build(2000);
    const large = build(20000);
    const time = (src: string): number => {
      const t0 = performance.now();
      scanEnvHelperBindings(src, 'main.go', '.go');
      return performance.now() - t0;
    };
    time(small); // warm
    const ts = Math.max(time(small), 0.5);
    const tl = time(large);
    // 10x the input must not cost anywhere near 100x the time (quadratic). The floor
    // keeps the ratio meaningful on a fast machine without asserting wall-clock speed.
    expect(tl / ts).toBeLessThan(40);
  });

  it('survives a 128 KB string literal as the argument without binding it', () => {
    const huge = 'A'.repeat(128 * 1024);
    const src = `package main\nfunc main() {\n\tneed("${huge}")\n}\nfunc need(key string) {\n\t_ = os.Getenv(key)\n}\n`;
    const t0 = performance.now();
    const scan = scanEnvHelperBindings(src, 'main.go', '.go');
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(scan.bindings).toEqual([]);
    expect(scan.unfollowed).toHaveLength(1);
  });

  it('terminates on a self-recursive helper (one hop, never a fixpoint)', () => {
    const src = [
      'package main',
      'func need(key string) {',
      '\t_ = os.Getenv(key)',
      '\tneed("RECURSE_VAR")',
      '}',
    ].join('\n') + '\n';
    const scan = scanEnvHelperBindings(src, 'main.go', '.go');
    // The recursive call passes a literal, so it is a provable one-hop read site.
    expect(scan.bindings.map(b => b.name)).toEqual(['RECURSE_VAR']);
  });

  it('terminates on mutual recursion between two helpers', () => {
    const src = [
      'package main',
      'func a(key string) {',
      '\t_ = os.Getenv(key)',
      '\tb(key)',
      '}',
      'func b(key string) {',
      '\t_ = os.Getenv(key)',
      '\ta(key)',
      '}',
    ].join('\n') + '\n';
    const t0 = performance.now();
    const scan = scanEnvHelperBindings(src, 'main.go', '.go');
    expect(performance.now() - t0).toBeLessThan(1000);
    // Neither call site passes a literal → both reads stay unfollowed, counted.
    expect(scan.bindings).toEqual([]);
    expect(scan.unfollowed).toHaveLength(2);
  });

  it('stays linear on a file with 10,000 literal Getenv calls (no helper at all)', () => {
    const lines = Array.from({ length: 10000 }, (_, i) => `var v${i} = os.Getenv("VAR_${i}")`).join('\n');
    const t0 = performance.now();
    const scan = scanEnvHelperBindings(`package main\n${lines}\n`, 'main.go', '.go');
    expect(performance.now() - t0).toBeLessThan(2000);
    // Every key is a literal: nothing indirect, so no declaration is even enumerated.
    expect(scan).toEqual({ bindings: [], unfollowed: [], callSiteCapHit: false });
  });

  it('bounds the indirect reads it considers per file', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `var v${i} = os.Getenv(k${i})`).join('\n');
    const scan = scanEnvHelperBindings(`package main\n${lines}\n`, 'main.go', '.go');
    expect(scan.unfollowed.length).toBeLessThanOrEqual(50);
    expect(scan.unfollowed.length).toBeGreaterThan(0);
  });
});
