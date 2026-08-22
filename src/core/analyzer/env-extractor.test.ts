import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractEnvVars, summarizeEnvVars, extractEnvReadSites } from './env-extractor.js';

// The extractor sizes and reads a file through ONE open handle, so the cap cannot be raced
// (change: fix-unbounded-file-scan-oom). The mock models that handle; `mockReadFile` still
// stands in for the file's content so every case below reads as it did before.
vi.mock('node:fs/promises', () => ({
  open: vi.fn(),
}));

import { open } from 'node:fs/promises';

const mockReadFile = vi.fn();
const mockOpen = open as ReturnType<typeof vi.fn>;

/**
 * A stand-in for the `FileHandle` the bounded scan opens. It models `read()` — NOT `readFile()` —
 * because the scan reads exactly the number of bytes it stat'd, so that a file growing under it
 * cannot be read past its checked size (change: fix-unbounded-file-scan-oom).
 */
function fakeHandle(content: string): {
  stat: () => Promise<{ isFile: () => boolean; size: number }>;
  read: (buf: Buffer, offset: number, length: number, position: number) => Promise<{ bytesRead: number }>;
  close: () => Promise<void>;
} {
  const bytes = Buffer.from(content, 'utf-8');
  return {
    stat: () => Promise.resolve({ isFile: () => true, size: bytes.length }),
    read: (buf, offset, length, position) => {
      const copied = bytes.copy(buf, offset, position, Math.min(position + length, bytes.length));
      return Promise.resolve({ bytesRead: copied });
    },
    close: () => Promise.resolve(),
  };
}

describe('extractEnvVars', () => {
  beforeEach(() => {
    mockReadFile.mockReset();
    mockOpen.mockReset();
    mockOpen.mockImplementation(async (p: string) => fakeHandle(String(await mockReadFile(p) ?? '')));
  });

  it('should return empty array when no files provided', async () => {
    const result = await extractEnvVars([], '/root');
    expect(result).toEqual([]);
  });

  it('should parse .env.example declarations', async () => {
    mockReadFile.mockResolvedValue('DATABASE_URL=postgres://localhost/db\nSECRET_KEY=\n');
    const result = await extractEnvVars(['/root/.env.example'], '/root');
    expect(result).toHaveLength(2);

    const dbUrl = result.find(v => v.name === 'DATABASE_URL');
    expect(dbUrl?.hasDefault).toBe(true);
    expect(dbUrl?.files).toContain('.env.example');

    const secret = result.find(v => v.name === 'SECRET_KEY');
    expect(secret?.hasDefault).toBe(false);
  });

  it('should capture inline comments from .env.example as description', async () => {
    mockReadFile.mockResolvedValue('STRIPE_KEY= # Stripe secret key from dashboard\n');
    const result = await extractEnvVars(['/root/.env.example'], '/root');
    expect(result[0].description).toBe('Stripe secret key from dashboard');
  });

  it('should capture preceding comment lines as description', async () => {
    mockReadFile.mockResolvedValue('# Redis connection string\nREDIS_URL=redis://localhost\n');
    const result = await extractEnvVars(['/root/.env.example'], '/root');
    expect(result[0].description).toBe('Redis connection string');
  });

  it('should detect process.env usage in TypeScript files', async () => {
    mockReadFile.mockResolvedValue('const url = process.env.DATABASE_URL;\nconst port = process.env[\'PORT\'];\n');
    const result = await extractEnvVars(['/root/src/config.ts'], '/root');
    const names = result.map(v => v.name);
    expect(names).toContain('DATABASE_URL');
    expect(names).toContain('PORT');
  });

  it('should mark vars required when no fallback in TS', async () => {
    mockReadFile.mockResolvedValue('const url = process.env.DATABASE_URL;\n');
    const result = await extractEnvVars(['/root/src/db.ts'], '/root');
    expect(result[0].required).toBe(true);
  });

  it('should not mark vars required when fallback present in TS', async () => {
    mockReadFile.mockResolvedValue('const port = process.env.PORT ?? \'3000\';\n');
    const result = await extractEnvVars(['/root/src/server.ts'], '/root');
    expect(result[0].required).toBe(false);
  });

  it('should detect os.environ usage in Python files', async () => {
    mockReadFile.mockResolvedValue('db_url = os.environ["DATABASE_URL"]\nport = os.getenv("PORT", "5432")\n');
    const result = await extractEnvVars(['/root/app/config.py'], '/root');
    const names = result.map(v => v.name);
    expect(names).toContain('DATABASE_URL');
    expect(names).toContain('PORT');

    const dbUrl = result.find(v => v.name === 'DATABASE_URL');
    expect(dbUrl?.required).toBe(true); // os.environ["X"] is strict

    const port = result.find(v => v.name === 'PORT');
    expect(port?.required).toBe(false); // os.getenv has optional default
  });

  it('should detect os.Getenv in Go files', async () => {
    mockReadFile.mockResolvedValue('dsn := os.Getenv("DATABASE_URL")\n');
    const result = await extractEnvVars(['/root/main.go'], '/root');
    expect(result[0].name).toBe('DATABASE_URL');
  });

  it('should detect ENV[] in Ruby files', async () => {
    mockReadFile.mockResolvedValue('url = ENV["REDIS_URL"]\nkey = ENV.fetch("SECRET_KEY")\n');
    const result = await extractEnvVars(['/root/config.rb'], '/root');
    const names = result.map(v => v.name);
    expect(names).toContain('REDIS_URL');
    expect(names).toContain('SECRET_KEY');
  });

  it('should classify Ruby bracket and fetch forms by their runtime semantics', async () => {
    mockReadFile.mockResolvedValue(
      'soft = ENV["SOFT"]\nhard = ENV.fetch("HARD")\ndefaulted = ENV.fetch("DEFAULTED", "d")\n',
    );
    const result = await extractEnvVars(['/root/config.rb'], '/root');

    expect(result.find(v => v.name === 'SOFT')?.required).toBe(false);
    expect(result.find(v => v.name === 'HARD')?.required).toBe(true);
    expect(result.find(v => v.name === 'DEFAULTED')?.required).toBe(false);
  });

  it('should detect Go os.LookupEnv as an optional checked read', async () => {
    mockReadFile.mockResolvedValue('value, ok := os.LookupEnv("OPTIONAL")\n');
    const result = await extractEnvVars(['/root/main.go'], '/root');

    expect(result).toContainEqual(expect.objectContaining({ name: 'OPTIONAL', required: false }));
  });

  it('should detect TypeScript process.env destructuring', async () => {
    mockReadFile.mockResolvedValue('const { API_KEY, REGION } = process.env;\n');
    const result = await extractEnvVars(['/root/config.ts'], '/root');

    expect(result.map(v => v.name)).toEqual(['API_KEY', 'REGION']);
    expect(result.every(v => v.required)).toBe(true);
  });

  it('should detect JavaScript process.env destructuring', async () => {
    mockReadFile.mockResolvedValue('const { API_KEY, REGION } = process.env;\n');
    const result = await extractEnvVars(['/root/config.js'], '/root');

    expect(result.map(v => v.name)).toEqual(['API_KEY', 'REGION']);
  });

  it('should evaluate TypeScript fallbacks per read site', async () => {
    mockReadFile.mockResolvedValue(
      'const optional = process.env.OPTIONAL ?? "default";\nconst required = process.env.REQUIRED;\n',
    );
    const result = await extractEnvVars(['/root/config.ts'], '/root');

    expect(result.find(v => v.name === 'OPTIONAL')?.required).toBe(false);
    expect(result.find(v => v.name === 'REQUIRED')?.required).toBe(true);
  });

  it('handles typed destructuring and nested default expressions per property', async () => {
    mockReadFile.mockResolvedValue(
      'const { API_KEY = make({ nested: true }), REGION }: NodeJS.ProcessEnv = process.env;\n',
    );
    const result = await extractEnvVars(['/root/config.ts'], '/root');
    expect(result.find(v => v.name === 'API_KEY')?.required).toBe(false);
    expect(result.find(v => v.name === 'REGION')?.required).toBe(true);
  });

  it('handles semicolons inside an inline object type annotation', async () => {
    mockReadFile.mockResolvedValue(
      'const { API_KEY }: { API_KEY?: string; REGION?: string } = process.env;\n',
    );
    const result = await extractEnvVars(['/root/config.ts'], '/root');
    expect(result.map(v => v.name)).toEqual(['API_KEY']);
  });

  it('ignores comment syntax while parsing destructuring structure and defaults', async () => {
    mockReadFile.mockResolvedValue(
      'const { API_KEY /* = not a default } */, REGION } = process.env;\n',
    );
    const result = await extractEnvVars(['/root/config.ts'], '/root');
    expect(result.find(v => v.name === 'API_KEY')?.required).toBe(true);
    expect(result.find(v => v.name === 'REGION')?.required).toBe(true);
  });

  it('does not match environment APIs as suffixes of other identifiers', async () => {
    mockReadFile.mockResolvedValue('myprocess.env.FAKE; myos.LookupEnv("NOPE"); MYENV.fetch("NEVER")\n');
    expect(await extractEnvVars(['/root/config.ts'], '/root')).toEqual([]);
  });

  it('should merge vars from declaration files and source files', async () => {
    mockReadFile
      .mockResolvedValueOnce('DATABASE_URL=postgres://localhost/db\n')  // .env.example
      .mockResolvedValueOnce('const db = process.env.DATABASE_URL;\n'); // source file
    const result = await extractEnvVars(['/root/.env.example', '/root/src/db.ts'], '/root');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('DATABASE_URL');
    expect(result[0].hasDefault).toBe(true);
    expect(result[0].required).toBe(true);
    expect(result[0].files).toHaveLength(2);
  });

  it('should skip test files', async () => {
    mockReadFile.mockResolvedValue('const url = process.env.DATABASE_URL;\n');
    const result = await extractEnvVars(['/root/src/db.test.ts'], '/root');
    expect(result).toEqual([]);
  });

  it('should skip node_modules', async () => {
    const result = await extractEnvVars(['/root/node_modules/lib/index.ts'], '/root');
    expect(result).toEqual([]);
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it('should sort results alphabetically', async () => {
    mockReadFile.mockResolvedValue('ZEBRA_KEY=1\nAPPLE_KEY=2\n');
    const result = await extractEnvVars(['/root/.env.example'], '/root');
    expect(result[0].name).toBe('APPLE_KEY');
    expect(result[1].name).toBe('ZEBRA_KEY');
  });
});

describe('summarizeEnvVars', () => {
  it('should return empty string for no vars', () => {
    expect(summarizeEnvVars([])).toBe('');
  });

  it('should list vars with required/has-default flags', () => {
    const vars = [
      { name: 'DATABASE_URL', files: ['src/db.ts'], hasDefault: false, required: true },
      { name: 'PORT', files: ['src/server.ts'], hasDefault: true, required: false, description: 'HTTP port' },
    ];
    const summary = summarizeEnvVars(vars);
    expect(summary).toContain('DATABASE_URL');
    expect(summary).toContain('[required]');
    expect(summary).toContain('PORT');
    expect(summary).toContain('[has-default]');
    expect(summary).toContain('HTTP port');
  });
});

describe('extractEnvReadSites (change: add-env-config-impact-graph)', () => {
  it('reports a required TS read with no fallback', () => {
    const src = 'const a = 1;\nconst url = process.env.DATABASE_URL;\n';
    const sites = extractEnvReadSites(src, 'src/db.ts', '.ts');
    expect(sites).toEqual([{ name: 'DATABASE_URL', file: 'src/db.ts', line: 2, required: true }]);
  });

  it('marks a TS read with a ?? fallback not required', () => {
    const src = "const port = process.env.PORT ?? '3000';\n";
    const sites = extractEnvReadSites(src, 'src/server.ts', '.ts');
    expect(sites[0]).toMatchObject({ name: 'PORT', required: false });
  });

  it('marks a TS read with a || fallback not required', () => {
    const src = "const host = process.env.HOST || 'localhost';\n";
    expect(extractEnvReadSites(src, 'a.ts', '.ts')[0]).toMatchObject({ name: 'HOST', required: false });
  });

  it('handles the bracket form and TS non-null before fallback', () => {
    const src = "const x = process.env['API_KEY']!;\nconst y = process.env.OPT! ?? 'd';\n";
    const sites = extractEnvReadSites(src, 'a.ts', '.ts');
    expect(sites.find(s => s.name === 'API_KEY')).toMatchObject({ required: true, line: 1 });
    expect(sites.find(s => s.name === 'OPT')).toMatchObject({ required: false, line: 2 });
  });

  it('Python strict subscript and defaultless .get/.getenv are required; with a default they are not', () => {
    const src = [
      'import os',
      "secret = os.environ['SECRET']",      // strict subscript → required
      "region = os.getenv('REGION')",        // getenv, no default → required (returns None)
      "x = os.environ.get('OPT')",           // get, no default → required (returns None)
      "y = os.getenv('TZ', 'UTC')",          // getenv with default → not required
      "z = os.environ.get('LANG', 'C')",     // get with default → not required
    ].join('\n') + '\n';
    const sites = extractEnvReadSites(src, 'app.py', '.py');
    expect(sites.find(s => s.name === 'SECRET')).toMatchObject({ required: true });
    expect(sites.find(s => s.name === 'REGION')).toMatchObject({ required: true });
    expect(sites.find(s => s.name === 'OPT')).toMatchObject({ required: true });
    expect(sites.find(s => s.name === 'TZ')).toMatchObject({ required: false });
    expect(sites.find(s => s.name === 'LANG')).toMatchObject({ required: false });
  });

  it('treats Go os.Getenv as never-required', () => {
    const src = 'package main\nvar p = os.Getenv("PORT")\n';
    expect(extractEnvReadSites(src, 'main.go', '.go')[0]).toMatchObject({ name: 'PORT', required: false });
  });

  it('treats Ruby ENV[] as soft and ENV.fetch as default-aware (positional and block defaults)', () => {
    const src = [
      "a = ENV['SECRET']",                   // missing subscript → nil, not required
      "b = ENV.fetch('REGION')",             // fetch, no default → required
      "c = ENV.fetch('OPT', 'd')",           // fetch with positional default → not required
      "d = ENV.fetch('BRACE') { 'x' }",      // fetch with block default → not required
      "e = ENV.fetch('DOO') do",             // fetch with do-block default → not required
      "  'y'",
      'end',
    ].join('\n') + '\n';
    const sites = extractEnvReadSites(src, 'app.rb', '.rb');
    expect(sites.find(s => s.name === 'SECRET')).toMatchObject({ required: false });
    expect(sites.find(s => s.name === 'REGION')).toMatchObject({ required: true });
    expect(sites.find(s => s.name === 'OPT')).toMatchObject({ required: false });
    expect(sites.find(s => s.name === 'BRACE')).toMatchObject({ required: false });
    expect(sites.find(s => s.name === 'DOO')).toMatchObject({ required: false });
  });

  it('detects Go os.LookupEnv as an optional checked read site', () => {
    const sites = extractEnvReadSites('package main\nvar value, ok = os.LookupEnv("OPTIONAL")\n', 'main.go', '.go');
    expect(sites).toEqual([{ name: 'OPTIONAL', file: 'main.go', line: 2, required: false }]);
  });

  it('detects each TypeScript process.env destructuring read site', () => {
    const sites = extractEnvReadSites(
      'const { API_KEY, REGION } = process.env;\n',
      'src/config.ts', '.ts',
    );
    expect(sites).toEqual([
      { name: 'API_KEY', file: 'src/config.ts', line: 1, required: true },
      { name: 'REGION', file: 'src/config.ts', line: 1, required: true },
    ]);
  });

  it('recognizes transparent comments before a TypeScript fallback', () => {
    const sites = extractEnvReadSites('const port = process.env.PORT /* optional */ ?? "3000";\n', 'a.ts', '.ts');
    expect(sites[0]).toMatchObject({ name: 'PORT', required: false });
  });

  it('classifies parenthesis-free Ruby fetch forms', () => {
    const sites = extractEnvReadSites(
      "a = ENV.fetch 'HARD'\nb = ENV.fetch 'SOFT', 'd'\nc = ENV.fetch 'BLOCK' do\n  'd'\nend\n",
      'app.rb', '.rb',
    );
    expect(sites.find(s => s.name === 'HARD')).toMatchObject({ required: true });
    expect(sites.find(s => s.name === 'SOFT')).toMatchObject({ required: false });
    expect(sites.find(s => s.name === 'BLOCK')).toMatchObject({ required: false });
  });

  it('returns nothing for an unsupported language', () => {
    expect(extractEnvReadSites('let x = os.Getenv("X")', 'a.rs', '.rs')).toEqual([]);
  });

  it('is deterministic and line-precise across multiple reads', () => {
    const src = 'a\nb\nprocess.env.B_VAR\nc\nprocess.env.A_VAR\n';
    const sites = extractEnvReadSites(src, 'a.ts', '.ts');
    expect(sites.map(s => [s.name, s.line])).toEqual([['B_VAR', 3], ['A_VAR', 5]]);
  });
});
