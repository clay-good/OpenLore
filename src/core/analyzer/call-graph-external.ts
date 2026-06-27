/**
 * External-call classification & external node creation — extracted from
 * `call-graph.ts` (change: modularize-call-graph-builder; analyzer:
 * StableCallGraphBarrel).
 *
 * Unresolved calls (stdlib / HTTP / DB / filesystem / unknown) become synthetic
 * `external::<name>` leaf nodes. `classifyExternal` buckets a callee name into an
 * `ExternalKind`; `getOrCreateExternalNode` interns the leaf into the node map.
 * Pure (the only mutation is the caller-supplied `nodes` map) and dependency-light
 * — only the `ExternalKind`/`FunctionNode` types. These were file-internal helpers
 * (never on `call-graph.ts`'s public surface); `getOrCreateExternalNode` is imported
 * back by the extractors, so the public import surface is unchanged.
 */

import type { ExternalKind, FunctionNode } from './call-graph-types.js';

const EXTERNAL_HTTP_RE = /^(fetch|axios|got|superagent|node-fetch|ky|request|https?|xmlhttprequest|grpc|undici|requests|aiohttp|httpx|urllib|urllib2|urllib3|curl|curleasy|pycurl|http|httpclient|httpurlconnection|reqwest|hyper|ureq|isahc|surf|net|faraday|httparty|rest|typhoeus|excon|okhttp|retrofit|feign|resttemplate|webclient|urlsession|alamofire|moya)$/;
const EXTERNAL_DB_RE = /^(pg|mysql|mysql2|sqlite|sqlite3|redis|ioredis|mongoose|mongo|mongodb|prisma|knex|sequelize|typeorm|drizzle|cassandra|dynamodb|firestore|supabase|neo4j|influxdb|clickhouse|kysely|psycopg2|psycopg|sqlalchemy|pymysql|asyncpg|motor|aiomysql|tortoise|sql|gorm|sqlx|pgx|bun|diesel|seaorm|rusqlite|activerecord|sequel|jdbc|hibernate|jpa|entitymanager|datasource|jdbctemplate|r2dbc|coredata|grdb|realm)$/;
const EXTERNAL_FS_RE = /^(fs|fsp|readfile|writefile|readdir|stat|mkdir|unlink|rename|copyfile|createreadstream|createwritestream|open|fopen|fread|fwrite|fclose|remove|ifstream|ofstream|fstream|os|path|file)$/;
const EXTERNAL_STDLIB_BASES = new Set([
  // JavaScript / Node.js
  'array', 'object', 'string', 'number', 'math', 'json', 'date', 'regexp',
  'promise', 'map', 'set', 'weakmap', 'weakset', 'symbol', 'reflect', 'proxy',
  'console', 'error', 'buffer', 'process', 'int8array', 'uint8array',
  // Python
  'os', 'sys', 're', 'io', 'abc', 'ast', 'csv', 'copy', 'enum', 'glob',
  'gzip', 'hmac', 'html', 'http', 'logging', 'operator', 'pathlib', 'pickle',
  'pprint', 'queue', 'random', 'shutil', 'signal', 'socket', 'ssl', 'struct',
  'subprocess', 'tempfile', 'threading', 'time', 'traceback', 'typing', 'uuid',
  'warnings', 'collections', 'functools', 'itertools', 'contextlib',
  'dataclasses', 'unittest', 'hashlib', 'base64', 'binascii', 'codecs',
  'inspect', 'importlib', 'weakref', 'gc', 'platform', 'shlex', 'textwrap',
  // C / C++
  'std', 'printf', 'fprintf', 'sprintf', 'snprintf', 'scanf', 'malloc',
  'calloc', 'realloc', 'free', 'memcpy', 'memmove', 'memset', 'memcmp',
  'strlen', 'strcpy', 'strncpy', 'strcat', 'strcmp', 'strncmp', 'strstr',
  'assert', 'abort', 'exit', 'atexit',
  // Go
  'fmt', 'log', 'sort', 'sync', 'atomic', 'bytes', 'errors', 'context',
  'reflect', 'runtime', 'bufio', 'unicode', 'strings', 'strconv', 'math',
  'rand', 'time', 'flag', 'testing',
  // Rust
  'vec', 'option', 'result', 'iter', 'collections', 'thread', 'env',
  'cell', 'rc', 'arc', 'mutex', 'rwlock', 'channel', 'mpsc',
  // Ruby
  'integer', 'float', 'numeric', 'enumerable', 'comparable', 'kernel',
  'module', 'class', 'basicobject', 'nilclass', 'trueclass', 'falseclass',
  'symbol', 'regexp', 'range', 'proc', 'method', 'encoding',
  // Java
  'system', 'integer', 'long', 'double', 'boolean', 'character',
  'list', 'arraylist', 'linkedlist', 'hashmap', 'treemap', 'hashset', 'treeset',
  'optional', 'stream', 'arrays', 'collections', 'objects', 'math',
  'thread', 'runnable', 'exception', 'runtimeexception', 'illegalargumentexception',
  'stringbuilder', 'stringbuffer', 'scanner',
  // Swift
  'int', 'double', 'bool', 'dictionary', 'swift', 'foundation',
  'dispatchqueue', 'notificationcenter', 'nsstring', 'nsarray', 'nsdictionary',
]);
const EXTERNAL_NOISE_RECEIVERS = new Set([
  'response', 'body', 't', 'err', 'error', 'buf', 'str', 'res', 'req', 'data', 'result',
]);

function classifyExternal(name: string): ExternalKind {
  const base = name.split('.')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
  if (EXTERNAL_HTTP_RE.test(base)) return 'http';
  if (EXTERNAL_DB_RE.test(base)) return 'database';
  if (EXTERNAL_FS_RE.test(base)) return 'filesystem';
  if (EXTERNAL_STDLIB_BASES.has(base)) return 'stdlib';
  if (name.includes('.') && EXTERNAL_NOISE_RECEIVERS.has(name.split('.')[0].toLowerCase())) return 'stdlib';
  return 'unknown';
}

export function getOrCreateExternalNode(name: string, nodes: Map<string, FunctionNode>): FunctionNode {
  const id = `external::${name}`;
  if (!nodes.has(id)) {
    nodes.set(id, {
      id, name, filePath: 'external', isExternal: true,
      externalKind: classifyExternal(name),
      isAsync: false, language: 'external',
      startIndex: 0, endIndex: 0, fanIn: 0, fanOut: 0,
    });
  }
  return nodes.get(id)!;
}
