import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractEnvVars, summarizeEnvVars, extractEnvReadSites } from './env-extractor.js';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

import { readFile } from 'node:fs/promises';

const mockReadFile = readFile as ReturnType<typeof vi.fn>;

describe('extractEnvVars', () => {
  beforeEach(() => {
    mockReadFile.mockReset();
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

  it('treats Ruby ENV[] strict and ENV.fetch default-aware (positional and block defaults)', () => {
    const src = [
      "a = ENV['SECRET']",                   // strict subscript → required
      "b = ENV.fetch('REGION')",             // fetch, no default → required
      "c = ENV.fetch('OPT', 'd')",           // fetch with positional default → not required
      "d = ENV.fetch('BRACE') { 'x' }",      // fetch with block default → not required
      "e = ENV.fetch('DOO') do",             // fetch with do-block default → not required
      "  'y'",
      'end',
    ].join('\n') + '\n';
    const sites = extractEnvReadSites(src, 'app.rb', '.rb');
    expect(sites.find(s => s.name === 'SECRET')).toMatchObject({ required: true });
    expect(sites.find(s => s.name === 'REGION')).toMatchObject({ required: true });
    expect(sites.find(s => s.name === 'OPT')).toMatchObject({ required: false });
    expect(sites.find(s => s.name === 'BRACE')).toMatchObject({ required: false });
    expect(sites.find(s => s.name === 'DOO')).toMatchObject({ required: false });
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
