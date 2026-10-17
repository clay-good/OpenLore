/**
 * Message-topology edges (change: add-message-topology-edges), through the real CallGraphBuilder.
 */
import { describe, it, expect } from 'vitest';
import { CallGraphBuilder, EVENT_CHANNEL_FANOUT_CAP, extractFileDynamicBoundary } from './call-graph.js';
import type { CallEdge, FunctionNode } from './call-graph.js';
import { mayContainMessageTopology, MESSAGE_TOPOLOGY_RULE } from './message-topology.js';
import { DYNAMIC_BOUNDARY_KINDS, DYNAMIC_BOUNDARY_REFUSALS } from './dynamic-boundary.js';
import { languageSupport } from './language-support.js';

type Built = Awaited<ReturnType<CallGraphBuilder['build']>>;
type File = { path: string; content: string; language: string };

const ts = (path: string, content: string): File => ({ path, content, language: 'TypeScript' });
const build = (...files: File[]): Promise<Built> => new CallGraphBuilder().build(files);
const legacyBuild = (...files: File[]): Promise<Built> =>
  new CallGraphBuilder({ legacyLatePassesForTesting: true }).build(files);
const idOf = (b: Built, name: string): string | undefined =>
  [...b.nodes.values()].find((n: FunctionNode) => n.name === name)?.id;
const messageEdges = (b: Built): CallEdge[] => b.edges.filter(e => e.synthesizedBy === MESSAGE_TOPOLOGY_RULE);
const hasMessageEdge = (b: Built, from: string, to: string): boolean =>
  messageEdges(b).some(e => e.callerId === idOf(b, from) && e.calleeId === idOf(b, to));
const edgeKey = (e: CallEdge): string => JSON.stringify(e);

/** The 2026-09-20 case: a client action, a server handler, a broadcast, a client reducer. */
const RESTART_PROTOCOL: File[] = [
  ts('src/client/actions.ts', `
    export function requestRestart(ws: WebSocket) { ws.send(JSON.stringify({ type: "restart" })); }
  `),
  ts('src/server/handler.ts', `
    export function handleRestart(msg: any) { restartServer(); broadcast({ type: "restarted" }); }
    function restartServer() { return 1; }
    function broadcast(m: unknown) { return m; }
    export function onMessage(msg: any) {
      switch (msg.type) {
        case "restart": handleRestart(msg); break;
        default: return;
      }
    }
  `),
  ts('src/client/reducer.ts', `
    export function reducer(state: any, action: any) {
      switch (action.type) {
        case "restarted":
          return { ...state, spinning: false };
        default:
          return state;
      }
    }
  `),
];

describe('message-topology edges', () => {
  it('connects a send to the handler its switch case calls', async () => {
    const b = await build(...RESTART_PROTOCOL);
    expect(hasMessageEdge(b, 'requestRestart', 'handleRestart')).toBe(true);
    const edge = messageEdges(b).find(e => e.callerId === idOf(b, 'requestRestart'))!;
    expect(edge.confidence).toBe('synthesized');
    expect(edge.kind).toBe('calls');
  });

  it('crosses the whole client → server → client chain', async () => {
    const b = await build(...RESTART_PROTOCOL);
    expect(hasMessageEdge(b, 'requestRestart', 'handleRestart')).toBe(true);
    // The reducer clause has an inline body, so the handler is the enclosing function.
    expect(hasMessageEdge(b, 'handleRestart', 'reducer')).toBe(true);
  });

  it('treats an equality test as an equivalent consumer', async () => {
    const b = await build(
      ts('src/a.ts', `export function send(port: any) { port.postMessage({ type: "restart" }); }`),
      ts('src/b.ts', `
        export function onRestart() { return 1; }
        export function listen(msg: any) { if (msg.type === "restart") onRestart(); }
        export function listen2(msg: any) { if ("restart" == msg.type) { return onRestart(); } }
      `),
    );
    expect(hasMessageEdge(b, 'send', 'onRestart')).toBe(true);
    // The clauses' containers are handlers too: deleting either clause breaks the sender.
    expect(messageEdges(b).map(e => b.nodes.get(e.calleeId)?.name).sort()).toEqual(['listen', 'listen2', 'onRestart']);
  });

  it('reads one equality out of an && guard, and refuses two', async () => {
    const b = await build(ts('src/a.ts', `
      function onStop() { return 1; }
      function onBoth() { return 2; }
      function listen(msg: any) { if (msg && msg.type === "stop") onStop(); }
      function listen2(msg: any) { if (msg.type === "stop" && msg.kind === "x") onBoth(); }
      function listen3(msg: any) { if (msg.type === "stop" || ready) onBoth(); }
      function stop(w: any) { w.postMessage({ type: "stop" }); }
    `));
    expect(hasMessageEdge(b, 'stop', 'onStop')).toBe(true);
    expect(hasMessageEdge(b, 'stop', 'onBoth')).toBe(false);
  });

  it('gives fallthrough cases the body they fall into', async () => {
    const b = await build(ts('src/a.ts', `
      function onEither() { return 1; }
      function route(m: any) { switch (m.kind) { case "a": case "b": onEither(); break; } }
      function sendB(ws: any) { ws.send({ kind: "b" }); }
    `));
    expect(hasMessageEdge(b, 'sendB', 'onEither')).toBe(true);
  });

  it('pairs constant member tags with constant member cases', async () => {
    const b = await build(ts('src/a.ts', `
      const Msg = { Open: "open" } as const;
      function onOpen() { return 1; }
      function route(m: any) { switch (m.type) { case Msg.Open: onOpen(); } }
      function open(ws: any) { ws.send({ type: Msg.Open }); }
      function openByString(ws: any) { ws.send({ type: "open" }); }
    `));
    expect(hasMessageEdge(b, 'open', 'onOpen')).toBe(true);
    // A string never pairs with a constant reference: their keys are namespaced apart.
    expect(hasMessageEdge(b, 'openByString', 'onOpen')).toBe(false);
  });

  it('creates no edge for a mismatched tag', async () => {
    const b = await build(ts('src/a.ts', `
      function onClose() { return 1; }
      function route(m: any) { switch (m.type) { case "close": onClose(); } }
      function open(ws: any) { ws.send({ type: "open" }); }
    `));
    expect(messageEdges(b)).toHaveLength(0);
  });

  it('creates no edge for a computed, templated, or spread-overridden tag', async () => {
    const b = await build(ts('src/a.ts', `
      function onOpen() { return 1; }
      function route(m: any) { switch (m.type) { case "open": onOpen(); } }
      function computed(ws: any, t: string) { ws.send({ type: t }); }
      function templated(ws: any, t: string) { ws.send({ type: \`op\${t}\` }); }
      function overridden(ws: any, rest: any) { ws.send({ type: "open", ...rest }); }
      function computedKey(ws: any) { ws.send({ ["type"]: "open" }); }
    `));
    expect(messageEdges(b)).toHaveLength(0);
  });

  it('keeps a spread before the tag (the tag wins)', async () => {
    const b = await build(ts('src/a.ts', `
      function onOpen() { return 1; }
      function route(m: any) { switch (m.type) { case "open": onOpen(); } }
      function opened(ws: any, base: any) { ws.send({ ...base, type: "open" }); }
    `));
    expect(hasMessageEdge(b, 'opened', 'onOpen')).toBe(true);
  });

  it('never crosses two discriminant fields that share a tag literal', async () => {
    const b = await build(ts('src/a.ts', `
      function onTypeX() { return 1; }
      function onKindX() { return 2; }
      function routeType(m: any) { switch (m.type) { case "x": onTypeX(); } }
      function routeKind(m: any) { switch (m.kind) { case "x": onKindX(); } }
      function sendType(port: any) { port.postMessage({ type: "x" }); }
      function sendKind(port: any) { port.postMessage({ kind: "x" }); }
    `));
    expect(hasMessageEdge(b, 'sendType', 'onTypeX')).toBe(true);
    expect(hasMessageEdge(b, 'sendKind', 'onKindX')).toBe(true);
    expect(hasMessageEdge(b, 'sendType', 'onKindX')).toBe(false);
    expect(hasMessageEdge(b, 'sendKind', 'onTypeX')).toBe(false);
  });

  it('ignores fields outside the discriminant vocabulary', async () => {
    const b = await build(ts('src/a.ts', `
      function onX() { return 1; }
      function route(m: any) { switch (m.name) { case "x": onX(); } }
      function make(ws: any) { ws.send({ name: "x" }); }
    `));
    expect(messageEdges(b)).toHaveLength(0);
  });

  it('pairs only a literal handed to a transport call, never a plain data enum', async () => {
    const b = await build(ts('src/a.ts', `
      function onCalls() { return 1; }
      function route(e: any) { if (e.kind === "calls") onCalls(); }
      function makeEdge() { return { kind: "calls" }; }
      function store(list: any[]) { list.push({ kind: "calls" }); }
      function viaDispatch(store: any) { store.dispatch({ kind: "calls" }); }
    `));
    expect([...new Set(messageEdges(b).map(e => e.callerId))]).toEqual([idOf(b, 'viaDispatch')]);
  });

  it('drops a key whose handlers exceed the fan-out cap', async () => {
    const consumers = Array.from({ length: EVENT_CHANNEL_FANOUT_CAP + 1 }, (_, i) =>
      `function c${i}(m: any) { if (m.type === "wide") { const x = ${i}; return x; } }`).join('\n');
    const b = await build(ts('src/a.ts', `${consumers}\nfunction send(ws: any) { ws.send({ type: "wide" }); }`));
    expect(messageEdges(b)).toHaveLength(0);
    const sites = b.dynamicBoundaryByFile?.get('src/a.ts')?.sites ?? [];
    expect(sites.filter(s => s.kind === 'message-send').map(s => s.refusal)).toEqual(['over-cap']);
  });

  it('only adds edges: every other edge is identical with and without message protocols', async () => {
    const base = [
      ts('src/e.ts', `
        function onMount() { return 1; }
        function register(em: any) { em.on('mount', onMount); }
        function trigger(em: any) { em.emit('mount'); }
      `),
      { path: 'src/p.py', language: 'Python', content: 'def h():\n  pass\n\ndef reg(bus):\n  bus.on("x", h)\n\ndef fire(bus):\n  bus.emit("x")\n' },
    ];
    const without = await build(...base);
    const protocolOnly = await build(...RESTART_PROTOCOL);
    const withMessages = await build(...base, ...RESTART_PROTOCOL);
    // The two file sets share no names, so every non-message edge of the union build is an edge of
    // one of the separate builds, and nothing else.
    const nonMessage = (b: Built): string[] => b.edges.filter(e => e.synthesizedBy !== MESSAGE_TOPOLOGY_RULE).map(edgeKey);
    expect(nonMessage(withMessages).sort()).toEqual([...nonMessage(without), ...nonMessage(protocolOnly)].sort());
    expect(messageEdges(without)).toHaveLength(0);
    expect(messageEdges(withMessages).map(edgeKey).sort()).toEqual(messageEdges(protocolOnly).map(edgeKey).sort());
    expect(messageEdges(withMessages).length).toBeGreaterThan(0);
  });

  it('produces the same edges and boundaries on the re-parsing lane', async () => {
    const files = [...RESTART_PROTOCOL, ts('src/out.ts', `export function ping(ws: any) { ws.send({ type: "ping" }); }`)];
    const pass1 = await build(...files);
    const legacy = await legacyBuild(...files);
    expect(messageEdges(legacy).map(edgeKey).sort()).toEqual(messageEdges(pass1).map(edgeKey).sort());
    expect(legacy.dynamicBoundaryByFile?.get('src/out.ts')).toEqual(pass1.dynamicBoundaryByFile?.get('src/out.ts'));
  });
});

describe('message-topology review regressions (round 1)', () => {
  it('never resolves a method call on another receiver by its bare name', async () => {
    const files = [
      ts('src/logger.ts', 'export function log() { return 1; }\nexport function reply() { return 2; }'),
      ts('src/w.ts', `
        export function go(ws: any) { ws.send({ type: "a" }); ws.send({ type: "b" }); }
        export function onMsg(m: any) {
          switch (m.type) {
            case "a": console.log(m); break;
            case "b": m.reply(); break;
          }
        }
      `),
    ];
    for (const b of [await build(...files), await legacyBuild(...files)]) {
      expect(hasMessageEdge(b, 'go', 'log')).toBe(false);
      expect(hasMessageEdge(b, 'go', 'reply')).toBe(false);
      expect(hasMessageEdge(b, 'go', 'onMsg')).toBe(true);
    }
  });

  it('still resolves a this-method call to that method', async () => {
    const b = await build(ts('src/w.ts', `
      class Server {
        onRestart() { return 1; }
        route(m: any) { switch (m.type) { case "restart": this.onRestart(); } }
      }
      export function go(ws: any) { ws.send({ type: "restart" }); }
    `));
    expect(hasMessageEdge(b, 'go', 'onRestart')).toBe(true);
  });

  it('refuses a tag read from another message', async () => {
    const b = await build(ts('src/w.ts', `
      export function dropIt() { return 1; }
      export function relay(ws: any, m: any) { ws.send({ type: m.type }); }
      export function filter(x: any, m: any) { if (x.type === m.type) { dropIt(); } }
    `));
    expect(messageEdges(b)).toHaveLength(0);
  });

  it('does not resolve a package import to a same-named repo function', async () => {
    const files = [
      ts('src/util/info.ts', 'export function info() { return 1; }'),
      ts('src/w.ts', `
        import { info } from 'pino';
        export function go(ws: any) { ws.send({ type: "b2" }); }
        export function onMsg(m: any) { switch (m.type) { case "b2": info(m); } }
      `),
    ];
    for (const b of [await build(...files), await legacyBuild(...files)]) {
      expect(hasMessageEdge(b, 'go', 'info')).toBe(false);
      expect(hasMessageEdge(b, 'go', 'onMsg')).toBe(true);
    }
  });

  it('falls back to the enclosing function on both lanes when the callee is not indexed', async () => {
    const files = [
      ts('src/client.ts', 'export function go(ws: any) { ws.send({ type: "restart" }); }'),
      ts('src/server.ts', `
        import { ext } from './lib';
        export function onMsg(m: any) { switch (m.type) { case "restart": ext(m); } }
      `),
    ];
    const pass1 = await build(...files);
    const legacy = await legacyBuild(...files);
    expect(hasMessageEdge(pass1, 'go', 'onMsg')).toBe(true);
    expect(messageEdges(pass1).map(edgeKey)).toEqual(messageEdges(legacy).map(edgeKey));
    expect(pass1.dynamicBoundaryByFile?.get('src/client.ts')).toBeUndefined();
  });

  it('sees through type-only wrappers and quoted keys', async () => {
    const b = await build(ts('src/w.ts', `
      function onX() { return 1; }
      function route(m: any) { switch (m.type) { case "x": onX(); } }
      function a(ws: any) { ws.send({ type: "x" } as any); }
      function c(ws: any) { ws.send({ "type": "x" }); }
    `));
    expect(hasMessageEdge(b, 'a', 'onX')).toBe(true);
    expect(hasMessageEdge(b, 'c', 'onX')).toBe(true);
  });
});

describe('message-topology dogfood regressions (round 1)', () => {
  it('discloses a send no indexed function contains instead of dropping it', async () => {
    const b = await build(
      ts('src/a.ts', 'setInterval(() => { vscode.postMessage({ command: "alert" }); }, 100);\nexport function onAlert() { return 1; }'),
      ts('src/b.ts', 'export function route(m: any) { if (m.command === "alert") { return 1; } }'),
    );
    const sites = b.dynamicBoundaryByFile?.get('src/a.ts')?.sites ?? [];
    expect(sites).toEqual([expect.objectContaining({ kind: 'message-send', refusal: 'unattributed-caller', unattributed: true })]);
  });

  it('never claims no consumer when a clause compares the field to an uncomparable constant', async () => {
    const b = await build(
      ts('src/actions.ts', `import * as types from './types';\nexport function checkout(store: any) { store.dispatch({ type: types.CHECKOUT_REQUEST }); }`),
      ts('src/cart.ts', `import { CHECKOUT_REQUEST } from './types';\nexport function cart(state: any, action: any) { switch (action.type) { case CHECKOUT_REQUEST: return []; default: return state; } }`),
    );
    expect(messageEdges(b)).toHaveLength(0);
    expect(b.dynamicBoundaryByFile?.get('src/actions.ts')?.sites.map(s => s.refusal)).toEqual(['uncomparable-message-consumer']);
  });

  it('pairs a handler in a test file only with a send in that same file', async () => {
    const b = await build(
      ts('test/a.test.ts', 'export function inc(store: any) { store.dispatch({ type: "INCREMENT" }); }'),
      ts('test/b.test.ts', 'export function reducer(s: any, a: any) { switch (a.type) { case "INCREMENT": return s + 1; default: return s; } }\nexport function local(store: any) { store.dispatch({ type: "INCREMENT" }); }'),
      ts('src/counter.ts', 'export function counter(s: any, a: any) { if (a.type === "INCREMENT") { return s + 1; } return s; }'),
    );
    expect(hasMessageEdge(b, 'inc', 'reducer')).toBe(false);
    expect(hasMessageEdge(b, 'local', 'reducer')).toBe(true);
    expect(hasMessageEdge(b, 'inc', 'counter')).toBe(true);
  });
});

describe('message-topology review regressions (round 2)', () => {
  const sites = (b: Built, file: string) => (b.dynamicBoundaryByFile?.get(file)?.sites ?? []).map(s => s.refusal);
  const bothLanes = async (...files: File[]): Promise<Built[]> => [await build(...files), await legacyBuild(...files)];

  it('never treats a parameter member as a constant tag', async () => {
    for (const b of await bothLanes(
      ts('src/a.ts', 'export function onIt() { return 1; }\nexport function route(m: any, ev: any) { switch (m.type) { case ev.name: onIt(); } }'),
      ts('src/b.ts', 'export function s(ws: any, ev: any) { ws.send({ type: ev.name }); }'),
    )) expect(messageEdges(b)).toHaveLength(0);
  });

  it('does not resolve a required package name to a repository function', async () => {
    for (const req of ['const { handle } = require("pino");', 'import handle = require("pino");']) {
      for (const b of await bothLanes(
        ts('src/h.ts', 'export function handle() { return 1; }'),
        ts('src/w.ts', `${req}\nexport function s(ws: any) { ws.send({ type: "x" }); }\nexport function route(m: any) { switch (m.type) { case "x": handle(m); } }`),
      )) {
        expect(hasMessageEdge(b, 's', 'handle'), req).toBe(false);
        expect(hasMessageEdge(b, 's', 'route'), req).toBe(true);
      }
    }
  });

  it('resolves a path-alias import like any repository name', async () => {
    const b = await build(
      ts('src/h.ts', 'export function handle() { return 1; }'),
      ts('src/w.ts', 'import { handle } from "@/h";\nexport function s(ws: any) { ws.send({ type: "x" }); }\nexport function route(m: any) { switch (m.type) { case "x": handle(m); } }'),
    );
    expect(hasMessageEdge(b, 's', 'handle')).toBe(true);
  });

  it('agrees between the single-file lane and the full build for unresolved callees in one function', async () => {
    const cases = Array.from({ length: EVENT_CHANNEL_FANOUT_CAP + 1 }, (_, i) => `case "x": u${i}();`).join(' ');
    const file = ts('src/a.ts', `export function r(m: any) { switch (m.type) { ${cases} } }\nexport function s(ws: any) { ws.send({ type: "x" }); }`);
    expect(sites(await build(file), 'src/a.ts')).toEqual([]);
    expect((await extractFileDynamicBoundary(file))?.sites ?? []).toEqual([]);
  });

  it('discloses a consumer no indexed function contains, on both lanes and the single-file lane', async () => {
    const file = ts('src/a.ts', 'switch (msg.type) { case "x": nowhere(); }\nexport function s(ws: any) { ws.send({ type: "x" }); }');
    for (const b of await bothLanes(file)) expect(sites(b, 'src/a.ts')).toEqual(['unattributed-message-consumer']);
    // One file cannot tell whether `nowhere` resolves elsewhere, so it claims only its own scope.
    expect((await extractFileDynamicBoundary(file))?.sites.map(x => x.refusal)).toEqual(['unresolved-in-file-scope']);
    const inline = ts('src/b.ts', 'switch (msg.type) { case "x": { const y = 1; break; } }\nexport function s(ws: any) { ws.send({ type: "x" }); }');
    expect((await extractFileDynamicBoundary(inline))?.sites.map(x => x.refusal)).toEqual(['unattributed-message-consumer']);
  });

  it('keeps an uncomparable claim to a constant spelled like the tag, never a variable', async () => {
    const b = await build(
      ts('src/walk.ts', 'export function walk(node: any, kind: string) { if (node.type === kind) { return 1; } }'),
      ts('src/s.ts', 'export function s(ws: any) { ws.send({ type: "ping" }); }'),
      ts('src/c.ts', 'import { PONG } from "./k";\nexport function c(m: any) { switch (m.type) { case PONG: return 1; } }\nexport function p(ws: any) { ws.send({ type: "PONG" }); }'),
    );
    expect(sites(b, 'src/s.ts')).toEqual(['unindexed-message-consumer']);
    expect(sites(b, 'src/c.ts')).toEqual(['uncomparable-message-consumer']);
  });

  it('says a tag is handled only in tests rather than unindexed', async () => {
    const b = await build(
      ts('src/s.ts', 'export function s(ws: any) { ws.send({ type: "x" }); }'),
      ts('src/a.test.ts', 'export function h(m: any) { if (m.type === "x") { return 1; } }'),
    );
    expect(messageEdges(b)).toHaveLength(0);
    expect(sites(b, 'src/s.ts')).toEqual(['test-only-message-consumer']);
  });

  it('reads an early-exit negated guard as a consumer, and nothing else negated', async () => {
    const b = await build(
      ts('src/a.ts', `
        export function guarded(m: any) { if (m.type !== "x") return; work(); }
        export function notGuard(m: any) { if (m.type !== "y") { work(); } }
        export function withElse(m: any) { if (m.type !== "z") return; else work(); }
        function work() { return 1; }
      `),
      ts('src/s.ts', 'export function s(ws: any) { ws.send({ type: "x" }); ws.send({ type: "y" }); ws.send({ type: "z" }); }'),
    );
    expect(messageEdges(b).map(e => e.calleeId)).toEqual([idOf(b, 'guarded')]);
  });

  it('derives no tested_by edge from a message a test sends', async () => {
    const b = await build(
      ts('src/server.ts', 'export function handle(m: any) { if (m.type === "x") { return 1; } }'),
      ts('src/server.test.ts', 'export function sendFake(ws: any) { ws.send({ type: "x" }); }'),
    );
    expect(hasMessageEdge(b, 'sendFake', 'handle')).toBe(true);
    expect(b.edges.some(e => e.kind === 'tested_by' && e.callerId === idOf(b, 'handle'))).toBe(false);
  });

  it('pairs a send only with the closest copy of a duplicated handler', async () => {
    const b = await build(
      ts('samples/news/feed.ts', 'export function showStory(w: any) { w.postMessage({ type: "story" }); }'),
      ts('samples/news/frame.ts', 'export function onStory(m: any) { if (m.type === "story") { return 1; } }'),
      ts('samples/news_i18n/frame.ts', 'export function onStory(m: any) { if (m.type === "story") { return 2; } }'),
    );
    const targets = messageEdges(b).map(e => b.nodes.get(e.calleeId)?.filePath);
    expect(targets).toEqual(['samples/news/frame.ts']);
  });
});

describe('message-topology review regressions (round 3)', () => {
  const sites = (b: Built, file: string) => (b.dynamicBoundaryByFile?.get(file)?.sites ?? []).map(s => s.refusal);

  it('keeps both a near client handler and a far server handler of one tag', async () => {
    const b = await build(
      ts('src/client/actions.ts', 'export function requestRestart(ws: any) { ws.send({ type: "restart" }); }'),
      ts('src/client/reducer.ts', 'export function reducer(s: any, a: any) { switch (a.type) { case "restart": return { ...s, spinning: true }; default: return s; } }'),
      ts('src/server/handler.ts', 'export function handleRestart() { return 1; }\nexport function onMessage(m: any) { switch (m.type) { case "restart": handleRestart(); } }'),
    );
    expect(hasMessageEdge(b, 'requestRestart', 'reducer')).toBe(true);
    expect(hasMessageEdge(b, 'requestRestart', 'handleRestart')).toBe(true);
  });

  it('refuses a member tag whose object a parameter or local shadows', async () => {
    const b = await build(
      ts('src/a.ts', `
        const Msg = { A: "a" } as const;
        export function h() { return 1; }
        export function route(m: any, Msg: any) { switch (m.type) { case Msg.A: h(); } }
        export function route2(m: any, t: any) { const Msg = t; if (m.type === Msg.A) { h(); } }
        export function send(ws: any) { ws.send({ type: Msg.A }); }
      `),
    );
    expect(messageEdges(b)).toHaveLength(0);
  });

  it('keys an aliased import by the name it imports', async () => {
    const b = await build(
      ts('src/types.ts', 'export const Types = { A: "a" } as const;'),
      ts('src/s.ts', 'import { Types as T } from "./types";\nexport function send(ws: any) { ws.send({ type: T.A }); }'),
      ts('src/c.ts', 'import { Types } from "./types";\nexport function route(m: any) { if (m.type === Types.A) { return 1; } }'),
    );
    expect(hasMessageEdge(b, 'send', 'route')).toBe(true);
  });

  it('binds declare enum and unexported namespaces at module scope', async () => {
    const b = await build(ts('src/a.ts', `
      declare enum D { A = "a" }
      namespace N { export const B = "b"; }
      export function onD() { return 1; }
      export function onN() { return 2; }
      export function route(m: any) { switch (m.type) { case D.A: onD(); break; case N.B: onN(); break; } }
      export function sendD(ws: any) { ws.send({ type: D.A }); }
      export function sendN(ws: any) { ws.send({ type: N.B }); }
    `));
    expect(hasMessageEdge(b, 'sendD', 'onD')).toBe(true);
    expect(hasMessageEdge(b, 'sendN', 'onN')).toBe(true);
  });

  it('does not let a nested require shadow a top-level function file-wide', async () => {
    const b = await build(ts('src/a.ts', `
      export function handle() { return 1; }
      function lazy() { const handle = require("pkg"); return handle; }
      export function route(m: any) { switch (m.type) { case "x": handle(); } }
      export function send(ws: any) { ws.send({ type: "x" }); }
    `));
    expect(hasMessageEdge(b, 'send', 'handle')).toBe(true);
  });

  it('reads a JSON-style quoted key in a file with no other discriminant spelling', async () => {
    const b = await build(
      ts('src/s.ts', 'export function send(ws: any) { ws.send(JSON.stringify({ "type": "x" })); }'),
      ts('src/c.ts', 'export function route(m: any) { if (m.type === "x") { return 1; } }'),
    );
    expect(hasMessageEdge(b, 'send', 'route')).toBe(true);
  });

  it('reads a block early exit and a ternary as consumers', async () => {
    const b = await build(
      ts('src/c.ts', `
        export function guarded(m: any) { if (m.type !== "g") { console.warn(m); return; } return 1; }
        export function reducer(s: any, a: any) { return a.type === "t" ? s + 1 : s; }
      `),
      ts('src/s.ts', 'export function send(ws: any) { ws.send({ type: "g" }); ws.send({ type: "t" }); }'),
    );
    expect(hasMessageEdge(b, 'send', 'guarded')).toBe(true);
    expect(hasMessageEdge(b, 'send', 'reducer')).toBe(true);
  });

  it('agrees on the single-file lane when many clauses call one name', async () => {
    // The cap counts clause containers on both lanes, so the two always agree.
    for (const n of [EVENT_CHANNEL_FANOUT_CAP, EVENT_CHANNEL_FANOUT_CAP + 1]) {
      const fns = Array.from({ length: n }, (_, i) => `export function r${i}(m: any) { if (m.type === "x") handleX(m); }`).join('\n');
      const file = ts('src/a.ts', `${fns}\nexport function handleX(m: any) { return m; }\nexport function s(ws: any) { ws.send({ type: "x" }); }`);
      const expected = n > EVENT_CHANNEL_FANOUT_CAP ? ['over-cap'] : [];
      expect(sites(await build(file), 'src/a.ts'), String(n)).toEqual(expected);
      expect(((await extractFileDynamicBoundary(file))?.sites ?? []).map(s => s.refusal), String(n)).toEqual(expected);
    }
  });

  it('never lets a NUL byte in a tag forge a marker', async () => {
    const b = await build(
      ts('src/c.ts', `export function route(m: any) { switch (m.type) { case "x\u0000unattributed": return 1; } }`.replace('\\u0000', '\u0000')),
      ts('src/s.ts', 'export function send(ws: any) { ws.send({ type: "x" }); }'),
    );
    expect(sites(b, 'src/s.ts')).toEqual(['unindexed-message-consumer']);
  });

  it('calls a marker left only by a test file test-only', async () => {
    const b = await build(
      ts('src/s.ts', 'import * as types from "./types";\nexport function send(store: any) { store.dispatch({ type: types.CHECKOUT }); }'),
      ts('src/c.test.ts', 'import { CHECKOUT } from "./types";\nexport function r(s: any, a: any) { switch (a.type) { case CHECKOUT: return 1; } }'),
    );
    expect(sites(b, 'src/s.ts')).toEqual(['test-only-message-consumer']);
  });

  it('makes the clause container a handler beside its single callee', async () => {
    const b = await build(...RESTART_PROTOCOL);
    expect(hasMessageEdge(b, 'requestRestart', 'handleRestart')).toBe(true);
    expect(hasMessageEdge(b, 'requestRestart', 'onMessage')).toBe(true);
  });

  it('orders message edges independently of input file order', async () => {
    const files = [...RESTART_PROTOCOL, ts('src/z.ts', 'export function z(m: any) { if (m.type === "restart") { return 1; } }')];
    const forward = messageEdges(await build(...files)).map(edgeKey);
    const backward = messageEdges(await build(...[...files].reverse())).map(edgeKey);
    expect(backward).toEqual(forward);
  });
});

describe('message-topology transport boundaries', () => {
  it('discloses a send no indexed consumer selects, and invents no edge', async () => {
    const b = await build(ts('src/out.ts', `export function ping(ws: any) { ws.send(JSON.stringify({ type: "ping" })); }`));
    expect(messageEdges(b)).toHaveLength(0);
    const record = b.dynamicBoundaryByFile?.get('src/out.ts');
    expect(record?.sites).toEqual([expect.objectContaining({
      line: 1, kind: 'message-send', refusal: 'unindexed-message-consumer', symbolId: idOf(b, 'ping'),
    })]);
    expect(record?.sites[0].evidence).toContain('ws.send');
  });

  it('records nothing for a paired send or for a tagged literal that is not sent', async () => {
    const b = await build(...RESTART_PROTOCOL, ts('src/props.ts', `export function props() { return { type: "button" }; }`));
    for (const record of b.dynamicBoundaryByFile?.values() ?? []) {
      expect(record.sites.filter(s => s.kind === 'message-send')).toEqual([]);
    }
  });

  it('applies the fan-out cap on the single-file lane as the full build does', async () => {
    const consumers = Array.from({ length: EVENT_CHANNEL_FANOUT_CAP + 1 }, (_, i) =>
      `function c${i}(m: any) { if (m.type === "wide") { const x = ${i}; return x; } }`).join('\n');
    const file = ts('src/a.ts', `${consumers}\nfunction send(ws: any) { ws.send({ type: "wide" }); }`);
    const single = await extractFileDynamicBoundary(file);
    const full = (await build(file)).dynamicBoundaryByFile?.get('src/a.ts');
    expect(single?.sites.map(s => s.refusal)).toEqual(['over-cap']);
    expect(full?.sites.map(s => s.refusal)).toEqual(['over-cap']);
  });

  it('keeps the vocabulary closed', () => {
    expect(DYNAMIC_BOUNDARY_KINDS).toContain('message-send');
    expect(DYNAMIC_BOUNDARY_REFUSALS).toContain('unindexed-message-consumer');
  });

  it('discloses unpaired sends on the single-file lane without claiming a repository-wide absence', async () => {
    const record = await extractFileDynamicBoundary(ts('src/out.ts', `
      export function ping(ws: any) { ws.send({ type: "ping" }); }
      export function pong(ws: any) { ws.send({ type: "pong" }); }
      export function route(m: any) { if (m.type === "pong") { return 1; } }
    `));
    expect(record?.sites.map(s => [s.kind, s.refusal, s.line])).toEqual([
      ['message-send', 'unresolved-in-file-scope', 2],
    ]);
  });
});

describe('message-topology prefilter and support', () => {
  it('skips a file that names no discriminant field', () => {
    expect(mayContainMessageTopology('function f(a) { return a.name; }')).toBe(false);
    expect(mayContainMessageTopology('switch (m.type) {}')).toBe(true);
    expect(mayContainMessageTopology('const m = { kind: "x" };')).toBe(true);
  });

  it('backs the JavaScript claim with a real edge', async () => {
    const b = await build(
      { path: 'src/a.js', language: 'JavaScript', content: 'export function go(ws) { ws.send({ type: "go" }); }' },
      { path: 'src/b.js', language: 'JavaScript', content: 'function onGo() { return 1; }\nexport function route(m) { switch (m.type) { case "go": onGo(); } }' },
    );
    expect(hasMessageEdge(b, 'go', 'onGo')).toBe(true);
  });

  it('declares support for TypeScript and JavaScript only', () => {
    expect(languageSupport('TypeScript').capabilities).toContain('messageTopology');
    expect(languageSupport('JavaScript').capabilities).toContain('messageTopology');
    for (const lang of ['Python', 'Go', 'Ruby', 'Java', 'Kotlin', 'Elixir']) {
      expect(languageSupport(lang).capabilities, lang).not.toContain('messageTopology');
    }
  });
});
