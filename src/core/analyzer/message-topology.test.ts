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
    expect(messageEdges(b)).toHaveLength(1);
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
    expect(messageEdges(b).map(e => e.callerId)).toEqual([idOf(b, 'viaDispatch')]);
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
