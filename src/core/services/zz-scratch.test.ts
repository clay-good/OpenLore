import { describe, it, expect } from 'vitest';
import { hashContractOperations, hashIacResources, resolveIacLanguage } from './declaration-hashes.js';
import { appendFileSync } from 'node:fs';
const __log = (...a: unknown[]) => appendFileSync('/tmp/zzscratch.txt', a.map(x => JSON.stringify(x, (_k,v)=> v instanceof Map ? Object.fromEntries(v) : v)).join(' ') + '\n');

const k8s = (img: string) => `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 2
  template:
    spec:
      containers:
        - name: web
          image: ${img}
`;

describe('scratch', () => {
  it('k8s property change', async () => {
    const lang = resolveIacLanguage('k8s/web.yaml', k8s('nginx:1.0'));
    __log('lang', lang);
    const a = await hashIacResources('k8s/web.yaml', k8s('nginx:1.0'), lang!);
    const b = await hashIacResources('k8s/web.yaml', k8s('nginx:9.9'), lang!);
    __log('A', a, 'B', b);
    expect(a).toBeDefined();
  });

  it('openapi non-2xx response change', () => {
    const spec = (extra: string) => `openapi: 3.0.0
info: {title: t, version: "1"}
paths:
  /x:
    get:
      responses:
        "200": {description: ok, content: {application/json: {schema: {type: object, properties: {a: {type: string}}}}}}
${extra}`;
    const a = hashContractOperations('o.yaml', spec(''));
    const b = hashContractOperations('o.yaml', spec('        "404": {description: nope}\n'));
    __log('noop', a, b);
    expect(a).toBeDefined();
  });

  it('openapi security change', () => {
    const spec = (sec: string) => `openapi: 3.0.0
info: {title: t, version: "1"}
paths:
  /x:
    get:
${sec}      responses:
        "200": {description: ok}
`;
    const a = hashContractOperations('o.yaml', spec(''));
    const b = hashContractOperations('o.yaml', spec('      security: [{apiKey: []}]\n'));
    __log('sec', a, b);
  });

  it('multi-doc k8s', async () => {
    const two = `${k8s('a:1')}---
apiVersion: apps/v1
kind: Service
metadata:
  name: web
`;
    const lang = resolveIacLanguage('k8s/two.yaml', two)!;
    __log('two', await hashIacResources('k8s/two.yaml', two, lang));
  });

  it('duplicate address in one file', async () => {
    const dup = (v: string) => `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: a
spec:
  replicas: ${v}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: b
spec:
  replicas: 7
`;
    const lang = resolveIacLanguage('k8s/dup.yaml', dup('1'))!;
    __log('dupA', await hashIacResources('k8s/dup.yaml', dup('1'), lang));
    __log('dupB', await hashIacResources('k8s/dup.yaml', dup('5'), lang));
  });
});
