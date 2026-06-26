/**
 * TypeScript/JS Route Extraction Tests
 *
 * Tests for extractTsRouteDefinitions() and buildRouteInventory()
 * added to http-route-parser.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  extractTsRouteDefinitions,
  buildRouteInventory,
} from './http-route-parser.js';

// ============================================================================
// HELPERS
// ============================================================================

async function createTempDir(): Promise<string> {
  const dir = join(tmpdir(), `ts-route-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function createFile(dir: string, name: string, content: string): Promise<string> {
  const filePath = join(dir, name);
  const parts = name.split('/');
  if (parts.length > 1) {
    await mkdir(join(dir, ...parts.slice(0, -1)), { recursive: true });
  }
  await writeFile(filePath, content, 'utf-8');
  return filePath;
}

// ============================================================================
// TESTS
// ============================================================================

describe('extractTsRouteDefinitions – Express', () => {
  let tmpDir: string;

  beforeEach(async () => { tmpDir = await createTempDir(); });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  it('detects GET and POST routes', async () => {
    const fp = await createFile(tmpDir, 'routes.ts', `
import express from 'express';
const router = express.Router();

router.get('/users', getUsers);
router.post('/users', createUser);
router.delete('/users/:id', deleteUser);
`);
    const routes = await extractTsRouteDefinitions(fp);
    expect(routes.length).toBeGreaterThanOrEqual(3);
    const methods = routes.map(r => r.method);
    expect(methods).toContain('GET');
    expect(methods).toContain('POST');
    expect(methods).toContain('DELETE');
    const paths = routes.map(r => r.path);
    expect(paths).toContain('/users');
    expect(paths.some(p => p.includes('id'))).toBe(true);
  });

  it('sets framework to express when import detected', async () => {
    const fp = await createFile(tmpDir, 'app.ts', `
import express from 'express';
const app = express();
app.get('/health', check);
`);
    const routes = await extractTsRouteDefinitions(fp);
    expect(routes.length).toBeGreaterThanOrEqual(1);
    expect(routes[0].framework).toBe('express');
  });
});

describe('extractTsRouteDefinitions – NestJS', () => {
  let tmpDir: string;

  beforeEach(async () => { tmpDir = await createTempDir(); });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  it('detects NestJS controller routes', async () => {
    const fp = await createFile(tmpDir, 'users.controller.ts', `
import { Controller, Get, Post, Param } from '@nestjs/common';

@Controller('users')
export class UsersController {
  @Get()
  findAll() { return []; }

  @Get(':id')
  findOne(@Param('id') id: string) { return id; }

  @Post()
  create() { return {}; }
}
`);
    const routes = await extractTsRouteDefinitions(fp);
    expect(routes.length).toBeGreaterThanOrEqual(3);
    expect(routes[0].framework).toBe('nestjs');
    const paths = routes.map(r => r.path);
    // All paths should start with /users
    expect(paths.every(p => p.startsWith('/users'))).toBe(true);
    const methods = routes.map(r => r.method);
    expect(methods).toContain('GET');
    expect(methods).toContain('POST');
  });
});

describe('extractTsRouteDefinitions – Next.js App Router', () => {
  let tmpDir: string;

  beforeEach(async () => { tmpDir = await createTempDir(); });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  it('detects Next.js App Router handlers', async () => {
    const fp = await createFile(tmpDir, 'app/users/route.ts', `
export async function GET(request: Request) {
  return Response.json([]);
}

export async function POST(request: Request) {
  return Response.json({});
}
`);
    const routes = await extractTsRouteDefinitions(fp);
    expect(routes.length).toBeGreaterThanOrEqual(2);
    expect(routes[0].framework).toBe('nextjs-app');
    const methods = routes.map(r => r.method);
    expect(methods).toContain('GET');
    expect(methods).toContain('POST');
    // path should be derived from directory
    expect(routes[0].path).toBe('/users');
  });

  // Regression: the analyze pipeline passes REPO-RELATIVE paths that START with the
  // `app/` segment (e.g. `app/api/posts/route.ts`, no leading slash).
  // `lastIndexOf('/app/')` missed that leading segment and collapsed the route to
  // `/`, silently breaking the route inventory and the cross-service edge for every
  // Next.js App Router repo. Reproduced by reading via a path relative to the app dir.
  it('derives the route path from a path that starts with the app/ segment', async () => {
    await createFile(tmpDir, 'app/api/posts/route.ts', `
export async function GET(request: Request) { return Response.json([]); }
`);
    const cwd = process.cwd();
    try {
      process.chdir(tmpDir);
      const routes = await extractTsRouteDefinitions('app/api/posts/route.ts');
      expect(routes.map(r => r.path)).toEqual(['/api/posts']);
    } finally {
      process.chdir(cwd);
    }
  });

  it('derives a dynamic-segment route path from an app/-leading relative path', async () => {
    await createFile(tmpDir, 'app/users/[id]/route.ts', `
export async function GET(request: Request) { return Response.json({}); }
`);
    const cwd = process.cwd();
    try {
      process.chdir(tmpDir);
      const routes = await extractTsRouteDefinitions('app/users/[id]/route.ts');
      expect(routes[0].path).toBe('/users/:id');
    } finally {
      process.chdir(cwd);
    }
  });
});

describe('extractTsRouteDefinitions – Express prefix accumulation', () => {
  let tmpDir: string;

  beforeEach(async () => { tmpDir = await createTempDir(); });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  it('accumulates prefix from app.use when route path is relative', async () => {
    const fp = await createFile(tmpDir, 'app.ts', `
import express from 'express';
const app = express();
const router = express.Router();
app.use('/prefix', router);
router.get('/users', listUsers);
`);
    const routes = await extractTsRouteDefinitions(fp);
    // Should have at least a GET /users route (prefix accumulation is best-effort)
    expect(routes.length).toBeGreaterThanOrEqual(1);
    const paths = routes.map(r => r.path);
    expect(paths.some(p => p.includes('users'))).toBe(true);
  });
});

describe('extractTsRouteDefinitions – Hono/Fastify framework detection', () => {
  let tmpDir: string;

  beforeEach(async () => { tmpDir = await createTempDir(); });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  it('detects Hono framework via import (no express import)', async () => {
    const fp = await createFile(tmpDir, 'hono-app.ts', `
import { Hono } from 'hono';
const app = new Hono();
app.get('/items', listItems);
app.post('/items', createItem);
`);
    const routes = await extractTsRouteDefinitions(fp);
    expect(routes.length).toBeGreaterThanOrEqual(2);
    expect(routes[0].framework).toBe('hono');
  });

  it('detects Fastify framework via import', async () => {
    const fp = await createFile(tmpDir, 'fastify-app.ts', `
import fastify from 'fastify';
const server = fastify();
server.get('/ping', pingHandler);
server.post('/data', dataHandler);
`);
    const routes = await extractTsRouteDefinitions(fp);
    expect(routes.length).toBeGreaterThanOrEqual(2);
    expect(routes[0].framework).toBe('fastify');
  });
});

describe('extractTsRouteDefinitions – NestJS no sub-path on method decorator', () => {
  let tmpDir: string;

  beforeEach(async () => { tmpDir = await createTempDir(); });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  it('@Get() with no argument uses only controller prefix as path', async () => {
    const fp = await createFile(tmpDir, 'cats.controller.ts', `
import { Controller, Get, Post } from '@nestjs/common';

@Controller('cats')
export class CatsController {
  @Get()
  findAll() { return []; }

  @Post()
  create() { return {}; }
}
`);
    const routes = await extractTsRouteDefinitions(fp);
    expect(routes.length).toBeGreaterThanOrEqual(2);
    const paths = routes.map(r => r.path);
    // When @Get() has no argument, path should be just the controller prefix /cats
    expect(paths.some(p => p === '/cats')).toBe(true);
  });
});

describe('extractTsRouteDefinitions – Next.js dynamic segment', () => {
  let tmpDir: string;

  beforeEach(async () => { tmpDir = await createTempDir(); });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  it('converts [id] dynamic segment to :id in path', async () => {
    const fp = await createFile(tmpDir, 'app/users/[id]/route.ts', `
export async function GET(request: Request) {
  return Response.json({});
}
`);
    const routes = await extractTsRouteDefinitions(fp);
    expect(routes.length).toBeGreaterThanOrEqual(1);
    expect(routes[0].framework).toBe('nextjs-app');
    // [id] should be converted to :id
    expect(routes[0].path).toContain(':id');
    expect(routes[0].path).not.toContain('[id]');
  });
});

describe('extractTsRouteDefinitions — per-route contract extraction', () => {
  let tmpDir: string;

  beforeEach(async () => { tmpDir = await createTempDir(); });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  it('extracts requestBodyType from Express handler with req: Request<P, R, Body>', async () => {
    const fp = await createFile(tmpDir, 'users.ts', `
import express from 'express';
const router = express.Router();

interface CreateUserBody {
  name: string;
  email: string;
}

router.post('/users', async (req: Request<{}, User, CreateUserBody>, res) => {
  const body = req.body;
  return res.json(body);
});
`);
    const routes = await extractTsRouteDefinitions(fp);
    const post = routes.find(r => r.method === 'POST');
    expect(post).toBeDefined();
    expect(post!.requestBodyType).toBe('CreateUserBody');
    expect(post!.contractSource).toBe('annotation');
  });

  it('extracts requestBodyType from NestJS @Body() dto param', async () => {
    const fp = await createFile(tmpDir, 'users.controller.ts', `
import { Controller, Post, Body } from '@nestjs/common';

class CreateUserDto {
  name: string;
}

@Controller('users')
export class UsersController {
  @Post()
  create(@Body() dto: CreateUserDto) {
    return dto;
  }
}
`);
    const routes = await extractTsRouteDefinitions(fp);
    const post = routes.find(r => r.method === 'POST');
    expect(post).toBeDefined();
    expect(post!.requestBodyType).toBe('CreateUserDto');
    expect(post!.contractSource).toBe('annotation');
  });

  it('sets contractSource to validator when Zod .parse() is used', async () => {
    const fp = await createFile(tmpDir, 'routes.ts', `
import express from 'express';
import { z } from 'zod';
const router = express.Router();

const userSchema = z.object({ name: z.string() });

router.post('/users', (req, res) => {
  const body = userSchema.parse(req.body);
  return res.json(body);
});
`);
    const routes = await extractTsRouteDefinitions(fp);
    const post = routes.find(r => r.method === 'POST');
    expect(post).toBeDefined();
    expect(post!.contractSource).toBe('validator');
  });

  it('sets contractSource to none when handler has no types', async () => {
    const fp = await createFile(tmpDir, 'simple.ts', `
import express from 'express';
const router = express.Router();

router.get('/ping', (req, res) => {
  res.send('pong');
});
`);
    const routes = await extractTsRouteDefinitions(fp);
    const get = routes.find(r => r.method === 'GET');
    expect(get).toBeDefined();
    expect(get!.contractSource).toBe('none');
    expect(get!.requestBodyType).toBeUndefined();
  });
});

describe('buildRouteInventory', () => {
  let tmpDir: string;

  beforeEach(async () => { tmpDir = await createTempDir(); });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  it('aggregates routes from multiple files', async () => {
    const fp1 = await createFile(tmpDir, 'routes/users.ts', `
import express from 'express';
const router = express.Router();
router.get('/users', list);
router.post('/users', create);
`);
    const fp2 = await createFile(tmpDir, 'routes/products.ts', `
import express from 'express';
const router = express.Router();
router.get('/products', listProducts);
router.delete('/products/:id', deleteProduct);
`);
    const inventory = await buildRouteInventory([fp1, fp2], tmpDir);
    expect(inventory.total).toBeGreaterThanOrEqual(4);
    expect(inventory.byMethod['GET']).toBeGreaterThanOrEqual(2);
    expect(inventory.byMethod['POST']).toBeGreaterThanOrEqual(1);
    expect(inventory.byMethod['DELETE']).toBeGreaterThanOrEqual(1);
    expect(inventory.routes.every(r => !r.file.startsWith('/'))).toBe(true); // relative paths
  });

  it('returns empty inventory for non-route files', async () => {
    const fp = await createFile(tmpDir, 'service.ts', `
export class UserService {
  async findAll() { return []; }
}
`);
    const inventory = await buildRouteInventory([fp], tmpDir);
    expect(inventory.total).toBe(0);
    expect(inventory.routes).toHaveLength(0);
  });
});
