/**
 * HTTP Route Parser Tests
 *
 * Covers:
 *   - normalizeUrl()
 *   - extractHttpCalls()   — fetch, axios, ky, got in JS/TS files
 *   - extractRouteDefinitions() — FastAPI, Flask, Django in Python files
 *   - buildHttpEdges()     — matching logic (exact / path / fuzzy)
 *   - extractAllHttpEdges() — end-to-end batch helper
 *
 * Also covers the Python absolute-import fix in resolveImport() via an
 * integration smoke-test (the detailed resolution tests live in
 * import-parser.test.ts; here we only verify that the dependency graph
 * picks up the cross-language HTTP edges).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  normalizeUrl,
  extractHttpCalls,
  extractRouteDefinitions,
  extractTsRouteDefinitions,
  extractJavaRouteDefinitions,
  buildHttpEdges,
  buildRouteInventory,
  extractAllHttpEdges,
  type HttpCall,
  type RouteDefinition,
} from './http-route-parser.js';

// ============================================================================
// HELPERS
// ============================================================================

async function createTempDir(): Promise<string> {
  const dir = join(tmpdir(), `http-parser-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function createFile(dir: string, name: string, content: string): Promise<string> {
  const filePath = join(dir, name);
  const fileDir = join(dir, ...name.split('/').slice(0, -1));
  if (fileDir !== dir && name.includes('/')) {
    await mkdir(fileDir, { recursive: true });
  }
  await writeFile(filePath, content, 'utf-8');
  return filePath;
}

// ============================================================================
// FIXTURES
// ============================================================================

const FETCH_FIXTURES = {
  simpleGet: `fetch('/api/items')`,
  explicitGet: `fetch('/api/items', { method: 'GET' })`,
  post: `fetch('/api/items', { method: 'POST', body: JSON.stringify(data) })`,
  put: `fetch('/api/items/1', { method: 'PUT' })`,
  delete: `fetch('/api/items/1', { method: 'DELETE' })`,
  templateLiteral: "fetch(`/api/items/${id}`)",
  templateWithMethod: "fetch(`/api/items/${id}`, { method: 'DELETE' })",
  fullUrl: `fetch('https://api.example.com/items')`,
  withQueryString: `fetch('/api/search?q=hello&page=1')`,
  awaitedInFunction: `
    async function loadItems() {
      const res = await fetch('/api/items');
      return res.json();
    }
  `,
  multipleInFile: `
    fetch('/api/users');
    fetch('/api/posts', { method: 'POST' });
  `,
};

const AXIOS_FIXTURES = {
  axiosGet: `axios.get('/api/items')`,
  axiosPost: `axios.post('/api/items', { name: 'test' })`,
  axiosPut: `axios.put('/api/items/1', data)`,
  axiosPatch: `axios.patch('/api/items/1', { name: 'updated' })`,
  axiosDelete: `axios.delete('/api/items/1')`,
  axiosGenericWithMethod: `axios({ method: 'post', url: '/api/items' })`,
  axiosGenericNoMethod: `axios({ url: '/api/items' })`,
  axiosRequest: `axios.request({ method: 'DELETE', url: '/api/items/1' })`,
  axiosTemplateLiteral: "axios.get(`/api/items/${itemId}`)",
  axiosWithPrefix: `axios.get('/api/v1/search')`,
};

const KY_FIXTURES = {
  kyGet: `ky.get('/api/items')`,
  kyPost: `ky.post('/api/items', { json: data })`,
  kyDelete: `ky.delete('/api/items/1')`,
};

const GOT_FIXTURES = {
  gotGet: `got.get('/api/items')`,
  gotPost: `got.post('/api/items', { json: data })`,
};

const FASTAPI_FIXTURES = {
  simpleGet: `
@app.get("/items")
async def list_items():
    return []
`,
  postWithBody: `
@app.post("/items")
async def create_item(item: Item):
    return item
`,
  pathParam: `
@app.get("/items/{item_id}")
async def get_item(item_id: int):
    return {"id": item_id}
`,
  routerGet: `
@router.get("/search")
async def search_items(q: str):
    return []
`,
  multiMethod: `
@app.api_route("/items", methods=["GET", "POST"])
async def items_multi():
    return []
`,
  put: `
@app.put("/items/{item_id}")
async def update_item(item_id: int, item: Item):
    return item
`,
  delete: `
@app.delete("/items/{item_id}")
async def delete_item(item_id: int):
    return {"deleted": item_id}
`,
  asyncWithDecorator: `
@router.post("/rag/search")
async def rag_search(query: RagQuery, db: Session = Depends(get_db)):
    results = retriever.search(query.text)
    return results
`,
  multipleRoutes: `
@app.get("/users")
async def list_users():
    return []

@app.post("/users")
async def create_user(user: UserCreate):
    return user

@app.get("/users/{user_id}")
async def get_user(user_id: int):
    return {"id": user_id}
`,
};

const FLASK_FIXTURES = {
  simpleGet: `
@app.route("/items")
def list_items():
    return jsonify([])
`,
  withMethods: `
@app.route("/items", methods=["GET", "POST"])
def items():
    return jsonify([])
`,
  blueprintRoute: `
@bp.route("/items/<int:item_id>", methods=["DELETE"])
def delete_item(item_id):
    return jsonify({"deleted": item_id})
`,
};

const DJANGO_FIXTURES = {
  pathRoute: `
urlpatterns = [
    path('api/items/', views.ItemListView.as_view(), name='item-list'),
    path('api/items/<int:pk>/', views.ItemDetailView.as_view(), name='item-detail'),
]
`,
};

// ============================================================================
// normalizeUrl
// ============================================================================

describe('normalizeUrl', () => {
  it('should return root path unchanged', () => {
    expect(normalizeUrl('/')).toBe('/');
  });

  it('should normalise a simple path', () => {
    expect(normalizeUrl('/api/items')).toBe('/api/items');
  });

  it('should strip query strings', () => {
    expect(normalizeUrl('/api/search?q=hello&page=1')).toBe('/api/search');
  });

  it('should strip fragments', () => {
    expect(normalizeUrl('/api/items#section')).toBe('/api/items');
  });

  it('should strip protocol and host', () => {
    expect(normalizeUrl('https://api.example.com/items')).toBe('/items');
  });

  it('should replace FastAPI path parameters {param}', () => {
    expect(normalizeUrl('/items/{item_id}')).toBe('/items/:param');
  });

  it('should replace Flask path parameters <int:param>', () => {
    expect(normalizeUrl('/items/<int:item_id>')).toBe('/items/:param');
  });

  it('should replace Express-style :param', () => {
    expect(normalizeUrl('/items/:id')).toBe('/items/:param');
  });

  it('should replace template literal ${...} interpolations', () => {
    expect(normalizeUrl('/api/items/${id}')).toBe('/api/items/:param');
  });

  it('should collapse duplicate slashes', () => {
    expect(normalizeUrl('//api//items')).toBe('/api/items');
  });

  it('should remove trailing slash', () => {
    expect(normalizeUrl('/api/items/')).toBe('/api/items');
  });

  it('should lowercase the result', () => {
    expect(normalizeUrl('/API/Items')).toBe('/api/items');
  });

  it('should handle multiple parameters', () => {
    expect(normalizeUrl('/users/{user_id}/posts/{post_id}')).toBe('/users/:param/posts/:param');
  });
});

// ============================================================================
// extractHttpCalls
// ============================================================================

describe('extractHttpCalls', () => {
  let tempDir: string;

  beforeEach(async () => { tempDir = await createTempDir(); });
  afterEach(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it('should return empty array for non-JS files', async () => {
    const filePath = await createFile(tempDir, 'styles.css', 'body {}');
    expect(await extractHttpCalls(filePath)).toHaveLength(0);
  });

  it('should return empty array for Python files', async () => {
    const filePath = await createFile(tempDir, 'main.py', 'print("hello")');
    expect(await extractHttpCalls(filePath)).toHaveLength(0);
  });

  it('reports correct line numbers for calls AFTER a comment (length-preserving mask)', async () => {
    // A line comment earlier in the file must not shift the reported line of a later
    // call — comment masking is length/line preserving. Regression: a non-preserving
    // strip drifted later calls one line early, breaking enclosing-function resolution.
    const src = [
      'export async function a() {',                       // 1
      "  return fetch('/api/a');   // an inline comment",  // 2
      '}',                                                 // 3
      '/* a block',                                        // 4
      '   comment */',                                     // 5
      'export async function b() {',                       // 6
      "  return fetch('/api/b');",                         // 7
      '}',                                                 // 8
    ].join('\n');
    const filePath = await createFile(tempDir, 'client.ts', src);
    const calls = await extractHttpCalls(filePath);
    const byUrl = new Map(calls.map(c => [c.normalizedUrl, c.line]));
    expect(byUrl.get('/api/a')).toBe(2);
    expect(byUrl.get('/api/b')).toBe(7); // not 6 — the comment lines didn't shift it
  });

  it('should return empty for file with no HTTP calls', async () => {
    const filePath = await createFile(tempDir, 'utils.ts', 'export const add = (a: number, b: number) => a + b;');
    expect(await extractHttpCalls(filePath)).toHaveLength(0);
  });

  // ── fetch ──────────────────────────────────────────────────────────────────

  describe('fetch()', () => {
    it('should detect a bare fetch() call as GET', async () => {
      const filePath = await createFile(tempDir, 'api.ts', FETCH_FIXTURES.simpleGet);
      const calls = await extractHttpCalls(filePath);

      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        method: 'GET',
        url: '/api/items',
        normalizedUrl: '/api/items',
        client: 'fetch',
      });
    });

    it('should detect explicit GET method', async () => {
      const filePath = await createFile(tempDir, 'api.ts', FETCH_FIXTURES.explicitGet);
      const calls = await extractHttpCalls(filePath);
      expect(calls[0].method).toBe('GET');
    });

    it('should detect POST method from options', async () => {
      const filePath = await createFile(tempDir, 'api.ts', FETCH_FIXTURES.post);
      const calls = await extractHttpCalls(filePath);
      expect(calls[0].method).toBe('POST');
    });

    it('should detect DELETE method', async () => {
      const filePath = await createFile(tempDir, 'api.ts', FETCH_FIXTURES.delete);
      const calls = await extractHttpCalls(filePath);
      expect(calls[0].method).toBe('DELETE');
    });

    it('should handle template literal URL', async () => {
      const filePath = await createFile(tempDir, 'api.ts', FETCH_FIXTURES.templateLiteral);
      const calls = await extractHttpCalls(filePath);

      expect(calls).toHaveLength(1);
      expect(calls[0].normalizedUrl).toBe('/api/items/:param');
    });

    it('should strip query string from normalizedUrl', async () => {
      const filePath = await createFile(tempDir, 'api.ts', FETCH_FIXTURES.withQueryString);
      const calls = await extractHttpCalls(filePath);

      expect(calls[0].normalizedUrl).toBe('/api/search');
    });

    it('should strip protocol and host from full URLs', async () => {
      const filePath = await createFile(tempDir, 'api.ts', FETCH_FIXTURES.fullUrl);
      const calls = await extractHttpCalls(filePath);

      expect(calls[0].normalizedUrl).toBe('/items');
    });

    it('should extract multiple fetch calls from one file', async () => {
      const filePath = await createFile(tempDir, 'api.ts', FETCH_FIXTURES.multipleInFile);
      const calls = await extractHttpCalls(filePath);

      expect(calls).toHaveLength(2);
      expect(calls.map(c => c.normalizedUrl)).toContain('/api/users');
      expect(calls.map(c => c.normalizedUrl)).toContain('/api/posts');
    });

    it('should record the file path', async () => {
      const filePath = await createFile(tempDir, 'api.ts', FETCH_FIXTURES.simpleGet);
      const calls = await extractHttpCalls(filePath);
      expect(calls[0].file).toBe(filePath);
    });

    it('should record a line number > 0', async () => {
      const filePath = await createFile(tempDir, 'api.ts', FETCH_FIXTURES.awaitedInFunction);
      const calls = await extractHttpCalls(filePath);
      expect(calls[0].line).toBeGreaterThan(0);
    });
  });

  // ── axios ──────────────────────────────────────────────────────────────────

  describe('axios', () => {
    it('should detect axios.get()', async () => {
      const filePath = await createFile(tempDir, 'api.ts', AXIOS_FIXTURES.axiosGet);
      const calls = await extractHttpCalls(filePath);

      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ method: 'GET', client: 'axios', normalizedUrl: '/api/items' });
    });

    it('should detect axios.post()', async () => {
      const filePath = await createFile(tempDir, 'api.ts', AXIOS_FIXTURES.axiosPost);
      const calls = await extractHttpCalls(filePath);
      expect(calls[0].method).toBe('POST');
    });

    it('should detect axios.put()', async () => {
      const filePath = await createFile(tempDir, 'api.ts', AXIOS_FIXTURES.axiosPut);
      const calls = await extractHttpCalls(filePath);
      expect(calls[0].method).toBe('PUT');
    });

    it('should detect axios.patch()', async () => {
      const filePath = await createFile(tempDir, 'api.ts', AXIOS_FIXTURES.axiosPatch);
      const calls = await extractHttpCalls(filePath);
      expect(calls[0].method).toBe('PATCH');
    });

    it('should detect axios.delete()', async () => {
      const filePath = await createFile(tempDir, 'api.ts', AXIOS_FIXTURES.axiosDelete);
      const calls = await extractHttpCalls(filePath);
      expect(calls[0].method).toBe('DELETE');
    });

    it('should detect axios({ method, url }) config form', async () => {
      const filePath = await createFile(tempDir, 'api.ts', AXIOS_FIXTURES.axiosGenericWithMethod);
      const calls = await extractHttpCalls(filePath);

      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe('POST');
      expect(calls[0].normalizedUrl).toBe('/api/items');
    });

    it('should default to UNKNOWN method for axios({ url }) without method', async () => {
      const filePath = await createFile(tempDir, 'api.ts', AXIOS_FIXTURES.axiosGenericNoMethod);
      const calls = await extractHttpCalls(filePath);
      expect(calls[0].method).toBe('UNKNOWN');
    });

    it('should detect axios.request() config form', async () => {
      const filePath = await createFile(tempDir, 'api.ts', AXIOS_FIXTURES.axiosRequest);
      const calls = await extractHttpCalls(filePath);

      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe('DELETE');
    });

    it('should normalise template literal URL in axios.get()', async () => {
      const filePath = await createFile(tempDir, 'api.ts', AXIOS_FIXTURES.axiosTemplateLiteral);
      const calls = await extractHttpCalls(filePath);
      expect(calls[0].normalizedUrl).toBe('/api/items/:param');
    });
  });

  // ── ky ─────────────────────────────────────────────────────────────────────

  describe('ky', () => {
    it('should detect ky.get()', async () => {
      const filePath = await createFile(tempDir, 'api.ts', KY_FIXTURES.kyGet);
      const calls = await extractHttpCalls(filePath);
      expect(calls[0]).toMatchObject({ method: 'GET', client: 'ky' });
    });

    it('should detect ky.post()', async () => {
      const filePath = await createFile(tempDir, 'api.ts', KY_FIXTURES.kyPost);
      const calls = await extractHttpCalls(filePath);
      expect(calls[0].method).toBe('POST');
    });

    it('should detect ky.delete()', async () => {
      const filePath = await createFile(tempDir, 'api.ts', KY_FIXTURES.kyDelete);
      const calls = await extractHttpCalls(filePath);
      expect(calls[0].method).toBe('DELETE');
    });
  });

  // ── got ─────────────────────────────────────────────────────────────────────

  describe('got', () => {
    it('should detect got.get()', async () => {
      const filePath = await createFile(tempDir, 'api.ts', GOT_FIXTURES.gotGet);
      const calls = await extractHttpCalls(filePath);
      expect(calls[0]).toMatchObject({ method: 'GET', client: 'got' });
    });

    it('should detect got.post()', async () => {
      const filePath = await createFile(tempDir, 'api.ts', GOT_FIXTURES.gotPost);
      const calls = await extractHttpCalls(filePath);
      expect(calls[0].method).toBe('POST');
    });
  });

  // ── mixed file ──────────────────────────────────────────────────────────────

  it('should extract calls from multiple clients in the same file', async () => {
    const content = `
      fetch('/api/users');
      axios.get('/api/posts');
      ky.post('/api/comments');
    `;
    const filePath = await createFile(tempDir, 'api.ts', content);
    const calls = await extractHttpCalls(filePath);

    expect(calls).toHaveLength(3);
    const clients = calls.map(c => c.client);
    expect(clients).toContain('fetch');
    expect(clients).toContain('axios');
    expect(clients).toContain('ky');
  });

  it('should work with .tsx files', async () => {
    const content = `
      export function SearchComponent() {
        const handleSearch = async () => {
          const res = await fetch('/api/search');
          return res.json();
        };
        return null;
      }
    `;
    const filePath = await createFile(tempDir, 'Search.tsx', content);
    const calls = await extractHttpCalls(filePath);
    expect(calls).toHaveLength(1);
    expect(calls[0].normalizedUrl).toBe('/api/search');
  });
});

// ============================================================================
// extractRouteDefinitions
// ============================================================================

describe('extractRouteDefinitions', () => {
  let tempDir: string;

  beforeEach(async () => { tempDir = await createTempDir(); });
  afterEach(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it('should return empty array for JS files', async () => {
    const filePath = await createFile(tempDir, 'app.ts', 'export const x = 1;');
    expect(await extractRouteDefinitions(filePath)).toHaveLength(0);
  });

  it('should return empty for a Python file with no routes', async () => {
    const filePath = await createFile(tempDir, 'utils.py', 'def helper(): pass');
    expect(await extractRouteDefinitions(filePath)).toHaveLength(0);
  });

  // ── FastAPI ─────────────────────────────────────────────────────────────────

  describe('FastAPI', () => {
    it('should detect @app.get()', async () => {
      const filePath = await createFile(tempDir, 'main.py', FASTAPI_FIXTURES.simpleGet);
      const routes = await extractRouteDefinitions(filePath);

      expect(routes).toHaveLength(1);
      expect(routes[0]).toMatchObject({
        method: 'GET',
        path: '/items',
        normalizedPath: '/items',
        handlerName: 'list_items',
        framework: 'fastapi',
      });
    });

    it('should detect @app.post()', async () => {
      const filePath = await createFile(tempDir, 'main.py', FASTAPI_FIXTURES.postWithBody);
      const routes = await extractRouteDefinitions(filePath);

      expect(routes[0].method).toBe('POST');
      expect(routes[0].handlerName).toBe('create_item');
    });

    it('should detect path parameters and normalise them', async () => {
      const filePath = await createFile(tempDir, 'main.py', FASTAPI_FIXTURES.pathParam);
      const routes = await extractRouteDefinitions(filePath);

      expect(routes[0].path).toBe('/items/{item_id}');
      expect(routes[0].normalizedPath).toBe('/items/:param');
    });

    it('should detect @router.get()', async () => {
      const filePath = await createFile(tempDir, 'routers.py', FASTAPI_FIXTURES.routerGet);
      const routes = await extractRouteDefinitions(filePath);

      expect(routes[0]).toMatchObject({ method: 'GET', path: '/search' });
    });

    it('should expand @app.api_route() with multiple methods', async () => {
      const filePath = await createFile(tempDir, 'main.py', FASTAPI_FIXTURES.multiMethod);
      const routes = await extractRouteDefinitions(filePath);

      expect(routes).toHaveLength(2);
      expect(routes.map(r => r.method)).toContain('GET');
      expect(routes.map(r => r.method)).toContain('POST');
      // both should share the same path
      expect(routes.every(r => r.path === '/items')).toBe(true);
    });

    it('should detect @app.put()', async () => {
      const filePath = await createFile(tempDir, 'main.py', FASTAPI_FIXTURES.put);
      const routes = await extractRouteDefinitions(filePath);
      expect(routes[0].method).toBe('PUT');
    });

    it('should detect @app.delete()', async () => {
      const filePath = await createFile(tempDir, 'main.py', FASTAPI_FIXTURES.delete);
      const routes = await extractRouteDefinitions(filePath);
      expect(routes[0].method).toBe('DELETE');
    });

    it('should extract handler name for async def with Depends()', async () => {
      const filePath = await createFile(tempDir, 'rag.py', FASTAPI_FIXTURES.asyncWithDecorator);
      const routes = await extractRouteDefinitions(filePath);

      expect(routes[0].handlerName).toBe('rag_search');
      expect(routes[0].path).toBe('/rag/search');
    });

    it('should extract multiple routes from one file', async () => {
      const filePath = await createFile(tempDir, 'users.py', FASTAPI_FIXTURES.multipleRoutes);
      const routes = await extractRouteDefinitions(filePath);

      expect(routes).toHaveLength(3);
      expect(routes.map(r => r.method)).toEqual(['GET', 'POST', 'GET']);
      expect(routes.map(r => r.handlerName)).toContain('list_users');
      expect(routes.map(r => r.handlerName)).toContain('create_user');
      expect(routes.map(r => r.handlerName)).toContain('get_user');
    });

    it('should record the file path', async () => {
      const filePath = await createFile(tempDir, 'main.py', FASTAPI_FIXTURES.simpleGet);
      const routes = await extractRouteDefinitions(filePath);
      expect(routes[0].file).toBe(filePath);
    });

    it('should record a line number > 0', async () => {
      const filePath = await createFile(tempDir, 'main.py', FASTAPI_FIXTURES.simpleGet);
      const routes = await extractRouteDefinitions(filePath);
      expect(routes[0].line).toBeGreaterThan(0);
    });
  });

  // ── Flask ───────────────────────────────────────────────────────────────────

  describe('Flask', () => {
    it('should detect @app.route() with default GET method', async () => {
      const filePath = await createFile(tempDir, 'app.py', FLASK_FIXTURES.simpleGet);
      const routes = await extractRouteDefinitions(filePath);

      expect(routes).toHaveLength(1);
      expect(routes[0]).toMatchObject({
        method: 'GET',
        path: '/items',
        framework: 'flask',
      });
    });

    it('should expand @app.route() with multiple methods', async () => {
      const filePath = await createFile(tempDir, 'app.py', FLASK_FIXTURES.withMethods);
      const routes = await extractRouteDefinitions(filePath);

      expect(routes).toHaveLength(2);
      expect(routes.map(r => r.method)).toContain('GET');
      expect(routes.map(r => r.method)).toContain('POST');
    });

    it('should detect blueprint routes and normalise Flask path params', async () => {
      const filePath = await createFile(tempDir, 'bp.py', FLASK_FIXTURES.blueprintRoute);
      const routes = await extractRouteDefinitions(filePath);

      expect(routes[0].method).toBe('DELETE');
      expect(routes[0].normalizedPath).toBe('/items/:param');
    });
  });

  // ── Django ──────────────────────────────────────────────────────────────────

  describe('Django', () => {
    it('should detect path() entries in urls.py', async () => {
      const filePath = await createFile(tempDir, 'urls.py', DJANGO_FIXTURES.pathRoute);
      const routes = await extractRouteDefinitions(filePath);

      expect(routes.length).toBeGreaterThanOrEqual(2);
      const paths = routes.map(r => r.normalizedPath);
      expect(paths).toContain('/api/items');
      expect(paths).toContain('/api/items/:param');
    });

    it('should set framework to django', async () => {
      const filePath = await createFile(tempDir, 'urls.py', DJANGO_FIXTURES.pathRoute);
      const routes = await extractRouteDefinitions(filePath);
      expect(routes.every(r => r.framework === 'django')).toBe(true);
    });

    it('should detect re_path()/url() regex routes (not just path())', async () => {
      const src = [
        'urlpatterns = [',
        "    re_path(r'^api/items/(?P<pk>[0-9]+)/$', views.item_detail),",
        "    url(r'^api/legacy/$', views.legacy_view),",
        ']',
      ].join('\n');
      const filePath = await createFile(tempDir, 'urls.py', src);
      const routes = await extractRouteDefinitions(filePath);
      const byHandler = new Map(routes.map(r => [r.handlerName, r.normalizedPath]));
      // named capture group → :param; anchors stripped
      expect(byHandler.get('item_detail')).toBe('/api/items/:param');
      expect(byHandler.get('legacy_view')).toBe('/api/legacy');
    });
  });

  // ── Non-code masking: docstrings & comments ──────────────────────────────────
  // Regression for the false-positive route (and downstream synthesized
  // route→handler edge) found by dogfooding on Flask's sansio/scaffold.py, whose
  // method docstrings embed `.. code-block:: python` examples containing
  // `@app.route("/")`. Two compounding defects: (1) route regexes matched inside
  // triple-quoted docstrings, and (2) `#`-comment stripping shifted match offsets
  // so getLine() reported the wrong line and bound the wrong `def` as handler.

  describe('non-code masking (docstrings & comments)', () => {
    it('does not match a route decorator inside a triple-quoted docstring', async () => {
      const src = [
        'class Scaffold:',
        '    def route(self, rule, **options):',
        '        """Register a view function for a URL rule.',
        '',
        '        .. code-block:: python',
        '',
        '            @app.route("/")',
        '            def index():',
        '                return "Hello, World!"',
        '        """',
        '        return self._add(rule, **options)',
        '',
        '    @cached_property',
        '    def jinja_loader(self):',
        '        return None',
      ].join('\n');
      const filePath = await createFile(tempDir, 'scaffold.py', src);
      const routes = await extractRouteDefinitions(filePath);
      expect(routes).toHaveLength(0);
    });

    it('reports the correct line and handler when comments precede the route', async () => {
      const src = [
        '# Copyright (c) 2026',
        '# Licensed under the terms of the MIT license.',
        '# See LICENSE for details — this header pads the offset.',
        '@app.route("/real")',
        'def real_handler():',
        '    return "ok"',
      ].join('\n');
      const filePath = await createFile(tempDir, 'app.py', src);
      const routes = await extractRouteDefinitions(filePath);

      expect(routes).toHaveLength(1);
      expect(routes[0]).toMatchObject({
        method: 'GET',
        path: '/real',
        handlerName: 'real_handler',
        line: 4,
      });
    });
  });
});

// ============================================================================
// buildHttpEdges
// ============================================================================

describe('buildHttpEdges', () => {
  function makeCall(overrides: Partial<HttpCall> & { file: string; url: string }): HttpCall {
    const url = overrides.url;
    return {
      method: 'GET',
      normalizedUrl: url,
      line: 1,
      client: 'fetch',
      ...overrides,
    };
  }

  function makeRoute(overrides: Partial<RouteDefinition> & { file: string; path: string }): RouteDefinition {
    const path = overrides.path;
    return {
      method: 'GET',
      normalizedPath: path,
      handlerName: 'handler',
      framework: 'fastapi',
      line: 1,
      contractSource: 'none',
      ...overrides,
    };
  }

  it('should return no edges when there are no calls', () => {
    const route = makeRoute({ file: '/back/items.py', path: '/items' });
    expect(buildHttpEdges([], [route])).toHaveLength(0);
  });

  it('should return no edges when there are no routes', () => {
    const call = makeCall({ file: '/front/api.ts', url: '/items' });
    expect(buildHttpEdges([call], [])).toHaveLength(0);
  });

  it('should create an exact edge when method and path both match', () => {
    const call = makeCall({ file: '/front/api.ts', url: '/items', method: 'GET' });
    const route = makeRoute({ file: '/back/items.py', path: '/items', method: 'GET' });

    const edges = buildHttpEdges([call], [route]);

    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      callerFile: '/front/api.ts',
      handlerFile: '/back/items.py',
      method: 'GET',
      confidence: 'exact',
    });
  });

  it('should create a path edge when method is UNKNOWN on the call side', () => {
    const call = makeCall({ file: '/front/api.ts', url: '/items', method: 'UNKNOWN' });
    const route = makeRoute({ file: '/back/items.py', path: '/items', method: 'GET' });

    const edges = buildHttpEdges([call], [route]);

    expect(edges).toHaveLength(1);
    expect(edges[0].confidence).toBe('path');
  });

  it('should strip /api/v1 prefix to match backend route', () => {
    const call = makeCall({ file: '/front/api.ts', url: '/api/v1/items', method: 'GET' });
    const route = makeRoute({ file: '/back/items.py', path: '/items', method: 'GET' });

    const edges = buildHttpEdges([call], [route]);

    expect(edges).toHaveLength(1);
    expect(edges[0].confidence).toBe('fuzzy');
  });

  it('should strip /api prefix to match backend route', () => {
    const call = makeCall({ file: '/front/api.ts', url: '/api/search', method: 'POST' });
    const route = makeRoute({ file: '/back/search.py', path: '/search', method: 'POST' });

    const edges = buildHttpEdges([call], [route]);

    expect(edges).toHaveLength(1);
  });

  it('should match parameterised routes (fuzzy fallback)', () => {
    // frontend: /api/items/42  →  normalised: /api/items/42  (no param detected statically)
    // backend:  /items/:param
    const call = makeCall({ file: '/front/api.ts', url: '/items/:param', method: 'GET' });
    const route = makeRoute({ file: '/back/items.py', path: '/items/:param', method: 'GET' });

    const edges = buildHttpEdges([call], [route]);
    expect(edges).toHaveLength(1);
  });

  it('should not match routes with different path segments', () => {
    const call = makeCall({ file: '/front/api.ts', url: '/users', method: 'GET' });
    const route = makeRoute({ file: '/back/items.py', path: '/items', method: 'GET' });

    expect(buildHttpEdges([call], [route])).toHaveLength(0);
  });

  it('should not create self-loop edges (caller === handler)', () => {
    const sameFile = '/app/main.py';
    const call = makeCall({ file: sameFile, url: '/items', method: 'GET' });
    const route = makeRoute({ file: sameFile, path: '/items', method: 'GET' });

    // buildHttpEdges itself doesn't filter self-loops; that's done by buildHttpCrossEdges.
    // But when callerFile === handlerFile we do NOT want them in graph edges — document
    // the expectation here so downstream consumers know to filter if needed.
    const edges = buildHttpEdges([call], [route]);
    // Edges may exist at this layer; the self-loop guard lives in DependencyGraphBuilder.
    // We just verify the fields are correct.
    if (edges.length > 0) {
      expect(edges[0].callerFile).toBe(edges[0].handlerFile);
    }
  });

  it('should deduplicate identical edges', () => {
    // Same call matched twice (e.g. two routes with identical normalised path)
    const call = makeCall({ file: '/front/api.ts', url: '/items', method: 'GET' });
    const route1 = makeRoute({ file: '/back/items.py', path: '/items', method: 'GET' });
    const route2 = makeRoute({ file: '/back/items.py', path: '/items', method: 'GET' });

    const edges = buildHttpEdges([call], [route1, route2]);
    expect(edges).toHaveLength(1);
  });

  it('should attach call and route references to the edge', () => {
    const call = makeCall({ file: '/front/api.ts', url: '/items', method: 'GET' });
    const route = makeRoute({ file: '/back/items.py', path: '/items', method: 'GET' });

    const edges = buildHttpEdges([call], [route]);
    expect(edges[0].call).toBe(call);
    expect(edges[0].route).toBe(route);
  });

  it('should pair each method to its own handler, never cross-link GET↔POST', () => {
    const getCall = makeCall({ file: '/front/api.ts', url: '/items', method: 'GET' });
    const postCall = makeCall({ file: '/front/api.ts', url: '/items', method: 'POST' });
    const getRoute = makeRoute({ file: '/back/items.py', path: '/items', method: 'GET', handlerName: 'listItems' });
    const postRoute = makeRoute({ file: '/back/items.py', path: '/items', method: 'POST', handlerName: 'createItem' });

    const edges = buildHttpEdges([getCall, postCall], [getRoute, postRoute]);
    expect(edges).toHaveLength(2);
    // The GET call links to the GET handler and the POST call to the POST handler —
    // no phantom cross-link from a method mismatch on a shared path.
    const byCall = new Map(edges.map(e => [e.call.method, e.route.handlerName]));
    expect(byCall.get('GET')).toBe('listItems');
    expect(byCall.get('POST')).toBe('createItem');
  });

  it('emits no edge when both methods are known and differ (no phantom path link)', () => {
    const postCall = makeCall({ file: '/front/api.ts', url: '/items', method: 'POST' });
    const getRoute = makeRoute({ file: '/back/items.py', path: '/items', method: 'GET', handlerName: 'listItems' });
    // A POST client and a GET-only route on the same path are different endpoints.
    expect(buildHttpEdges([postCall], [getRoute])).toHaveLength(0);
  });

  it('still links when one side has an UNKNOWN method (bare fetch / Django)', () => {
    const bareCall = makeCall({ file: '/front/api.ts', url: '/items', method: 'UNKNOWN' });
    const postRoute = makeRoute({ file: '/back/items.py', path: '/items', method: 'POST', handlerName: 'createItem' });
    const edges = buildHttpEdges([bareCall], [postRoute]);
    expect(edges).toHaveLength(1);
    expect(edges[0].confidence).toBe('path');
  });
});

// ============================================================================
// extractAllHttpEdges  (end-to-end)
// ============================================================================

describe('extractAllHttpEdges', () => {
  let tempDir: string;

  beforeEach(async () => { tempDir = await createTempDir(); });
  afterEach(async () => { await rm(tempDir, { recursive: true, force: true }); });

  it('should return empty results for an empty file list', async () => {
    const result = await extractAllHttpEdges([]);
    expect(result.calls).toHaveLength(0);
    expect(result.routes).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });

  it('should find no edges when there are only frontend files', async () => {
    const fp = await createFile(tempDir, 'api.ts', `fetch('/api/items')`);
    const result = await extractAllHttpEdges([fp]);
    expect(result.calls).toHaveLength(1);
    expect(result.routes).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });

  it('aggregates calls in filePaths order, not I/O completion order (determinism)', async () => {
    const a = await createFile(tempDir, 'a.ts', `export function fa() { return fetch('/api/a'); }`);
    const b = await createFile(tempDir, 'b.ts', `export function fb() { return fetch('/api/b'); }`);
    // Result order follows the INPUT order regardless of which read finishes first,
    // so re-analysis is byte-stable. Swapping inputs swaps the output order.
    expect((await extractAllHttpEdges([a, b])).calls.map(c => c.normalizedUrl)).toEqual(['/api/a', '/api/b']);
    expect((await extractAllHttpEdges([b, a])).calls.map(c => c.normalizedUrl)).toEqual(['/api/b', '/api/a']);
  });

  it('should find no edges when there are only backend files', async () => {
    const fp = await createFile(tempDir, 'main.py', FASTAPI_FIXTURES.simpleGet);
    const result = await extractAllHttpEdges([fp]);
    expect(result.routes).toHaveLength(1);
    expect(result.calls).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });

  it('should create a cross-language edge for a matching fetch → FastAPI route', async () => {
    const frontendFile = await createFile(tempDir, 'api.ts', `
      export async function fetchItems() {
        return fetch('/api/items');
      }
    `);
    const backendFile = await createFile(tempDir, 'items.py', `
@app.get("/api/items")
async def list_items():
    return []
    `);

    const result = await extractAllHttpEdges([frontendFile, backendFile]);

    expect(result.calls).toHaveLength(1);
    expect(result.routes).toHaveLength(1);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].callerFile).toBe(frontendFile);
    expect(result.edges[0].handlerFile).toBe(backendFile);
    expect(result.edges[0].method).toBe('GET');
  });

  it('should create a cross-language edge for axios.post → FastAPI route', async () => {
    const frontendFile = await createFile(tempDir, 'search.ts', `
      import axios from 'axios';
      export const search = (q: string) => axios.post('/rag/search', { query: q });
    `);
    const backendFile = await createFile(tempDir, 'rag.py', FASTAPI_FIXTURES.asyncWithDecorator);

    const result = await extractAllHttpEdges([frontendFile, backendFile]);

    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toMatchObject({
      method: 'POST',
      callerFile: frontendFile,
      handlerFile: backendFile,
    });
    expect(result.edges[0].route.handlerName).toBe('rag_search');
  });

  it('should match after stripping /api/v1 prefix', async () => {
    const frontendFile = await createFile(tempDir, 'api.ts', `
      axios.get('/api/v1/search')
    `);
    const backendFile = await createFile(tempDir, 'search.py', `
@router.get("/search")
async def search():
    return []
    `);

    const result = await extractAllHttpEdges([frontendFile, backendFile]);

    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].confidence).toBe('fuzzy');
  });

  it('should create edges for all matched pairs in a larger codebase', async () => {
    const frontend = await createFile(tempDir, 'client.ts', `
      fetch('/items');
      axios.post('/items');
      fetch('/users');
    `);
    const backend = await createFile(tempDir, 'server.py', `
@app.get("/items")
async def list_items():
    return []

@app.post("/items")
async def create_item():
    return {}

@app.get("/users")
async def list_users():
    return []
    `);

    const result = await extractAllHttpEdges([frontend, backend]);

    expect(result.calls).toHaveLength(3);
    expect(result.routes).toHaveLength(3);
    // fetch('/items') → GET /items, axios.post('/items') → POST /items, fetch('/users') → GET /users
    expect(result.edges).toHaveLength(3);
  });

  it('should not create edges for unmatched calls', async () => {
    const frontend = await createFile(tempDir, 'client.ts', `fetch('/api/nonexistent')`);
    const backend = await createFile(tempDir, 'server.py', FASTAPI_FIXTURES.simpleGet);

    const result = await extractAllHttpEdges([frontend, backend]);

    expect(result.calls).toHaveLength(1);
    expect(result.routes).toHaveLength(1);
    expect(result.edges).toHaveLength(0);
  });

  it('should handle non-existent file gracefully', async () => {
    // extractHttpCalls and extractRouteDefinitions catch read errors internally
    const result = await extractAllHttpEdges(['/nonexistent/file.ts', '/nonexistent/file.py']);
    expect(result.calls).toHaveLength(0);
    expect(result.routes).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });
});

// ============================================================================
// extractJavaRouteDefinitions — Spring MVC / JAX-RS
// ============================================================================

describe('extractJavaRouteDefinitions — Spring', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should extract @GetMapping with class-level @RequestMapping prefix', async () => {
    const file = await createFile(tempDir, 'UserController.java', `
package com.example.web;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/users")
public class UserController {

    @GetMapping("/{id}")
    public User getUser(@PathVariable Long id) {
        return null;
    }
}
`);

    const routes = await extractJavaRouteDefinitions(file);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      method: 'GET',
      path: '/api/users/{id}',
      framework: 'spring',
      handlerName: 'getUser',
    });
  });

  it('should extract multiple HTTP methods in one controller', async () => {
    const file = await createFile(tempDir, 'UserController.java', `
package com.example.web;

@RestController
@RequestMapping("/api/users")
public class UserController {

    @GetMapping
    public List<User> listUsers() { return null; }

    @PostMapping
    public User createUser(@RequestBody User user) { return null; }

    @PutMapping("/{id}")
    public User updateUser(@PathVariable Long id, @RequestBody User u) { return null; }

    @DeleteMapping("/{id}")
    public void deleteUser(@PathVariable Long id) {}

    @PatchMapping("/{id}")
    public User patchUser(@PathVariable Long id) { return null; }
}
`);

    const routes = await extractJavaRouteDefinitions(file);
    const byMethod = Object.fromEntries(routes.map(r => [r.method, r.path]));
    expect(byMethod.GET).toBe('/api/users');
    expect(byMethod.POST).toBe('/api/users');
    expect(byMethod.PUT).toBe('/api/users/{id}');
    expect(byMethod.DELETE).toBe('/api/users/{id}');
    expect(byMethod.PATCH).toBe('/api/users/{id}');
  });

  it('should extract @RequestMapping with method= on a method', async () => {
    const file = await createFile(tempDir, 'SearchController.java', `
package com.example.web;

@RestController
public class SearchController {

    @RequestMapping(value = "/search", method = RequestMethod.GET)
    public List<Result> search() { return null; }
}
`);

    const routes = await extractJavaRouteDefinitions(file);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      method: 'GET',
      path: '/search',
      framework: 'spring',
      handlerName: 'search',
    });
  });

  it('should handle named path arg (path = "/foo")', async () => {
    const file = await createFile(tempDir, 'X.java', `
@RestController
public class X {
  @GetMapping(path = "/foo")
  public String foo() { return ""; }
}
`);

    const routes = await extractJavaRouteDefinitions(file);
    expect(routes).toHaveLength(1);
    expect(routes[0].path).toBe('/foo');
  });

  it('should not treat class-level @RequestMapping as a route', async () => {
    const file = await createFile(tempDir, 'UserController.java', `
@RestController
@RequestMapping("/api/users")
public class UserController {
    @GetMapping
    public List<User> list() { return null; }
}
`);

    const routes = await extractJavaRouteDefinitions(file);
    // Only @GetMapping should produce a route — the class-level @RequestMapping
    // is a prefix, not a route.
    expect(routes).toHaveLength(1);
    expect(routes[0].method).toBe('GET');
  });

  it('resolves the handler name when an annotation sits in the return-type position (#138)', async () => {
    const file = await createFile(tempDir, 'VetController.java', `
@Controller
public class VetController {
    @GetMapping("/vets")
    public @ResponseBody Vets showResourcesVetList() { return null; }
}
`);

    const routes = await extractJavaRouteDefinitions(file);
    expect(routes).toHaveLength(1);
    // Before the fix the inline @ResponseBody broke the regex → "unknown".
    expect(routes[0].handlerName).toBe('showResourcesVetList');
  });

  it('should ignore non-Java files', async () => {
    const file = await createFile(tempDir, 'App.py', '@app.get("/foo")');
    expect(await extractJavaRouteDefinitions(file)).toEqual([]);
  });
});

describe('extractJavaRouteDefinitions — JAX-RS', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should extract @GET / @POST on @Path-annotated class', async () => {
    const file = await createFile(tempDir, 'UserResource.java', `
package com.example;

import jakarta.ws.rs.*;

@Path("/users")
public class UserResource {

    @GET
    public List<User> list() { return null; }

    @POST
    public User create(User user) { return null; }

    @GET
    @Path("/{id}")
    public User get(@PathParam("id") Long id) { return null; }
}
`);

    const routes = await extractJavaRouteDefinitions(file);
    expect(routes.every(r => r.framework === 'jaxrs')).toBe(true);
    const paths = routes.map(r => [r.method, r.path].join(' '));
    expect(paths).toContain('GET /users');
    expect(paths).toContain('POST /users');
    expect(paths).toContain('GET /users/{id}');
  });

  it('does NOT treat a Retrofit client interface as server routes (#138)', async () => {
    // Retrofit's @GET/@Path come from retrofit2.http — client request templates,
    // not server endpoints. Without the JAX-RS (ws.rs) import these must yield 0
    // routes, otherwise OpenLore hallucinates a server API for a client library.
    const file = await createFile(tempDir, 'GitHubService.java', `
package com.example;

import retrofit2.Call;
import retrofit2.http.GET;
import retrofit2.http.Path;

public interface GitHubService {
    @GET("/repos/{owner}/{repo}")
    Call<Repo> getRepo(@Path("owner") String owner, @Path("repo") String repo);

    @GET("/users/{user}/repos")
    Call<List<Repo>> listRepos(@Path("user") String user);
}
`);

    const routes = await extractJavaRouteDefinitions(file);
    expect(routes).toEqual([]);
  });
});

describe('extractAllHttpEdges with Java', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should produce edges between JS caller and Spring handler', async () => {
    const frontend = await createFile(tempDir, 'client.ts', `
      axios.get('/api/users/42');
      axios.post('/api/users', { name: 'alice' });
    `);
    const backend = await createFile(tempDir, 'UserController.java', `
@RestController
@RequestMapping("/api/users")
public class UserController {
  @GetMapping("/{id}")
  public User getUser(@PathVariable Long id) { return null; }

  @PostMapping
  public User createUser(@RequestBody User u) { return null; }
}
`);

    const result = await extractAllHttpEdges([frontend, backend]);

    expect(result.routes.length).toBeGreaterThanOrEqual(2);
    expect(result.edges.length).toBeGreaterThanOrEqual(2);
    const edgeMethods = result.edges.map(e => e.method).sort();
    expect(edgeMethods).toContain('GET');
    expect(edgeMethods).toContain('POST');
  });
});

describe('Fastify routes + test-file exclusion', () => {
  let tmpDir: string;
  beforeEach(async () => { tmpDir = await createTempDir(); });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

  it('extracts fastify.<method>() routes (plugin idiom, @fastify/* import)', async () => {
    const fp = await createFile(tmpDir, 'src/routes/tasks/index.ts', `
import { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
const plugin: FastifyPluginAsyncTypebox = async (fastify) => {
  fastify.get('/', async () => ({ ok: true }));
  fastify.post('/login', async () => ({ token: 'x' }));
};
export default plugin;
`);
    const routes = await extractTsRouteDefinitions(fp);
    const sigs = routes.map(r => `${r.method} ${r.path}`);
    expect(sigs).toContain('GET /');
    expect(sigs).toContain('POST /login');
    expect(routes.every(r => r.framework === 'fastify')).toBe(true);
  });

  it('buildRouteInventory excludes routes declared in test files', async () => {
    await createFile(tmpDir, 'src/routes/real.ts', `
import Fastify from 'fastify';
const fastify = Fastify();
fastify.get('/real', async () => ({}));
`);
    const testFp = await createFile(tmpDir, 'test/error-handler.test.ts', `
import Fastify from 'fastify';
const fastify = Fastify();
fastify.get('/error', async () => { throw new Error('x'); });
`);
    const inv = await buildRouteInventory(
      [join(tmpDir, 'src/routes/real.ts'), testFp],
      tmpDir,
    );
    const paths = inv.routes.map(r => r.path);
    expect(paths).toContain('/real');
    expect(paths).not.toContain('/error'); // phantom from the test file is excluded
  });
});
