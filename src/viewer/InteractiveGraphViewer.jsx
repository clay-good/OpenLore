import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { extColor, CLUSTER_PALETTE, CLUSTER_PALETTE_LIGHT } from './utils/constants.js';
import {
  parseSpecRequirements,
  buildMappingIndex,
  normalizePath,
  parseGraph,
  enrichGraphWithRefactors,
  computeBlast,
  selectionBelongsToCluster,
} from './utils/graph-helpers.js';
import { FlatGraph } from './components/FlatGraph.jsx';
import { ClusterGraph } from './components/ClusterGraph.jsx';
import { ClassGraph } from './components/ClassGraph.jsx';
import { FilterBar } from './components/FilterBar.jsx';
import { ArchitectureView } from './components/ArchitectureView.jsx';
import { Hint, SL, Row, Chip, KindBadge } from './components/MicroComponents.jsx';
import { ChatPanel } from './components/ChatPanel.jsx';
import { FreshnessBanner } from './components/FreshnessBanner.jsx';
import { THEMES, THEME_KEYS, DEFAULT_THEME } from './utils/themes.js';
import { freshnessFromResponse, mergeFreshness } from './utils/freshness.js';

export default function App({ graphUrl, mappingUrl = '/api/mapping', specUrl = '/api/spec' }) {
  const [rawGraph, setRawGraph] = useState(null);
  const [llmCtx, setLlmCtx] = useState(null);
  const [refReport, setRefReport] = useState(null);
  const [classData, setClassData] = useState(null);
  const [freshness, setFreshness] = useState(null);
  const [selectedClass, setSelectedClass] = useState(null); // full class object
  const selectedClassId = selectedClass?.id ?? null;
  const [focusedPaths, setFocusedPaths] = useState([]);
  const [mapping, setMapping] = useState(null);
  const [specReqs, setSpecReqs] = useState({});
  const [selectedId, setSelectedId] = useState(null);
  const [affectedIds, setAffectedIds] = useState([]);
  const [focusedIds, setFocusedIds] = useState([]);
  const [search, setSearch] = useState('');
  const [semanticResults, setSemanticResults] = useState([]);
  const [semanticAvailable, setSemanticAvailable] = useState(true);
  const semanticTimer = useRef(null);
  const [tab, setTab] = useState('node');
  const [skeletonData, setSkeletonData] = useState(null);
  const [skeletonLoading, setSkeletonLoading] = useState(false);
  const [viewMode, setViewMode] = useState('clusters');
  const [expandedClusters, setExpandedClusters] = useState(new Set());
  const [filters, setFilters] = useState({
    hideOrphans: false,
    minScore: 0,
    topN: 999,
    cluster: '',
    refactorOnly: false,
  });
  const [loaded, setLoaded] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [themeName, setThemeName] = useState(
    () => localStorage.getItem('openlore-theme') || DEFAULT_THEME
  );
  const theme = THEMES[themeName] ?? THEMES[DEFAULT_THEME];
  const clusterPalette = themeName === 'light' ? CLUSTER_PALETTE_LIGHT : CLUSTER_PALETTE;

  // Derive graph from raw data — recomputes automatically when theme, refReport or raw data changes.
  const graph = useMemo(() => {
    if (!rawGraph) return null;
    const g = parseGraph(rawGraph, clusterPalette);
    return refReport ? enrichGraphWithRefactors(g, refReport) : g;
  }, [rawGraph, clusterPalette, refReport]);

  const cycleTheme = () => setThemeName((prev) => {
    const idx = THEME_KEYS.indexOf(prev);
    const next = THEME_KEYS[(idx + 1) % THEME_KEYS.length];
    localStorage.setItem('openlore-theme', next);
    return next;
  });
  const fileRef = useRef();
  const hasAutoLoadedRef = useRef(false);

  useEffect(() => {
    setTimeout(() => setLoaded(true), 80);
  }, []);

  const loadGraph = useCallback(
    (jsonStr) => {
      try {
        setRawGraph(JSON.parse(jsonStr));
        setSelectedId(null);
        setAffectedIds([]);
        setFocusedIds([]);
        setSearch('');
        setFilters({
          hideOrphans: false,
          minScore: 0,
          topN: 999,
          cluster: '',
          refactorOnly: false,
        });
        setExpandedClusters(new Set());
      } catch (e) {
        alert('Invalid JSON: ' + e.message);
      }
    },
    []
  );

  const loadMapping = useCallback((jsonStr) => {
    try {
      const m = JSON.parse(jsonStr);
      setMapping(buildMappingIndex(m));
    } catch (e) {
      console.error('Invalid mapping JSON', e);
    }
  }, []);

  const loadSpec = useCallback((mdStr) => {
    setSpecReqs(parseSpecRequirements(mdStr));
  }, []);

  const observeFreshness = useCallback((response) => {
    const observed = freshnessFromResponse(response);
    if (observed) setFreshness((current) => mergeFreshness(current, observed));
  }, []);

  const mappingRef = useRef();
  const specRef = useRef();

  useEffect(() => {
    if (!graphUrl || hasAutoLoadedRef.current) return;
    hasAutoLoadedRef.current = true;
    (async () => {
      try {
        const res = await fetch(graphUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        observeFreshness(res);
        const text = await res.text();
        loadGraph(text);

        try {
          const ctxRes = await fetch('/api/llm-context');
          if (ctxRes.ok) { observeFreshness(ctxRes); setLlmCtx(await ctxRes.json()); }
        } catch { /* ignore */ }

        try {
          const cgRes = await fetch('/api/class-graph');
          if (cgRes.ok) { observeFreshness(cgRes); setClassData(await cgRes.json()); }
        } catch { /* ignore */ }

        try {
          const refRes = await fetch('/api/refactor-priorities');
          if (refRes.ok) {
            observeFreshness(refRes);
            const report = await refRes.json();
            setRefReport(report);
          }
        } catch { /* ignore */ }

        try {
          const mRes = await fetch('/api/mapping');
          if (mRes.ok) { observeFreshness(mRes); loadMapping(await mRes.text()); }
        } catch { /* ignore */ }
        try {
          const srRes = await fetch('/api/spec-requirements');
          if (srRes.ok) {
            const reqsJson = await srRes.json();
            setSpecReqs(reqsJson);
          } else {
            try {
              const sRes = await fetch('/api/spec');
              if (sRes.ok) loadSpec(await sRes.text());
            } catch { /* ignore */ }
          }
        } catch { /* ignore */ }
      } catch (e) {
        console.error('Failed to load graph from', graphUrl, e);
      }
    })();
  }, [graphUrl, mappingUrl, specUrl, loadGraph, observeFreshness]);

  const handleFile = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = (ev) => loadGraph(ev.target.result);
    r.readAsText(f);
  };

  // ── Filtered nodes/edges ──────────────────────────────────────────────────
  const { visibleNodes, visibleEdges, filterStats } = useMemo(() => {
    if (!graph) return { visibleNodes: [], visibleEdges: [], filterStats: {} };

    const connectedIds = new Set();
    graph.edges.forEach((e) => {
      connectedIds.add(e.source);
      connectedIds.add(e.target);
    });
    const orphanCount = graph.nodes.filter((n) => !connectedIds.has(n.id)).length;

    let nodes = filters.cluster
      ? graph.nodes.filter((n) => n.cluster.name === filters.cluster)
      : graph.nodes;

    if (filters.refactorOnly) {
      nodes = nodes.filter((n) => n.refactor);
    }

    if (filters.hideOrphans) nodes = nodes.filter((n) => connectedIds.has(n.id));
    if (filters.minScore > 0) nodes = nodes.filter((n) => n.score >= filters.minScore);

    if (filters.topN < 999) {
      const ranked = graph.rankings.byImportance || graph.nodes.map((n) => n.id);
      const topSet = new Set(ranked.slice(0, filters.topN));
      nodes = nodes.filter((n) => topSet.has(n.id));
    }

    const vset = new Set(nodes.map((n) => n.id));
    const edges = graph.edges.filter((e) => vset.has(e.source) && vset.has(e.target));

    const refactorTotal =
      graph.refactorStats?.withIssues ?? graph.nodes.filter((n) => n.refactor).length;
    const refactorVisible = nodes.filter((n) => n.refactor).length;

    return {
      visibleNodes: nodes,
      visibleEdges: edges,
      filterStats: {
        total: graph.nodes.length,
        visible: nodes.length,
        visibleEdges: edges.length,
        orphanCount,
        refactorTotal,
        refactorVisible,
      },
    };
  }, [graph, filters]);

  const handleSearch = (q) => {
    setSearch(q);
    if (!q.trim()) {
      setFocusedIds([]);
      setSemanticResults([]);
      clearTimeout(semanticTimer.current);
      return;
    }
    const lo = q.toLowerCase();
    setFocusedIds(
      visibleNodes
        .filter(
          (n) =>
            n.label.toLowerCase().includes(lo) ||
            n.path.toLowerCase().includes(lo) ||
            n.ext.includes(lo) ||
            n.tags.some((t) => t.toLowerCase().includes(lo)) ||
            n.exports.some((ex) => ex.name.toLowerCase().includes(lo))
        )
        .map((n) => n.id)
    );
    if (!semanticAvailable || q.trim().length < 3) return;
    clearTimeout(semanticTimer.current);
    semanticTimer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q.trim())}`);
        if (res.status === 404) { setSemanticAvailable(false); return; }
        if (!res.ok) return;
        setSemanticResults(await res.json());
      } catch { /* ignore */ }
    }, 400);
  };

  const handleSelect = useCallback(
    (id) => {
      if (selectedId === id) {
        setSelectedId(null);
        setAffectedIds([]);
        return;
      }
      setSelectedId(id);
      setAffectedIds(computeBlast(visibleEdges, id));
      setTab(mapping ? 'spec' : 'node');
    },
    [selectedId, visibleEdges, mapping]
  );

  const toggleCluster = useCallback((cid) => {
    const collapsing = expandedClusters.has(cid);
    // If we're collapsing the cluster that holds the selected node, clear the
    // selection — otherwise its edges keep rendering from the (now empty)
    // cluster center as ghost edges. Mirrors the chat-collapse guard above.
    if (collapsing && selectionBelongsToCluster(graph, selectedId, cid)) {
      setSelectedId(null);
      setAffectedIds([]);
    }
    setExpandedClusters((prev) => {
      const next = new Set(prev);
      next.has(cid) ? next.delete(cid) : next.add(cid);
      return next;
    });
  }, [expandedClusters, selectedId, graph]);

  const clearSelection = useCallback(() => {
    setSelectedId(null);
    setAffectedIds([]);
    setExpandedClusters(new Set());
    setSemanticResults([]);
    setSkeletonData(null);
  }, []);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') clearSelection(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [clearSelection]);

  // Track which clusters were auto-expanded by the chatbot (so we can collapse them on clear)
  const chatExpandedClusters = useRef(new Set());
  // Track whether selectedId was set by the chatbot (so we can clear it on clear)
  const chatSelectedId = useRef(null);

  // Auto-expand clusters when their nodes are highlighted by the chatbot
  useEffect(() => {
    if (!graph) return;

    if (focusedIds.length === 0) {
      // focusedIds cleared — collapse clusters that were auto-expanded by chat
      if (chatExpandedClusters.current.size > 0) {
        const toCollapse = new Set(chatExpandedClusters.current);
        chatExpandedClusters.current = new Set();
        setExpandedClusters((prev) => {
          const next = new Set(prev);
          toCollapse.forEach((cid) => next.delete(cid));
          return next;
        });
        // If the selected node is inside a collapsing cluster, clear selection
        // to avoid ghost edges rendering from cluster centers
        if (selectedId) {
          const selNode = graph.nodes.find((n) => n.id === selectedId);
          if (selNode && toCollapse.has(selNode.cluster?.id)) {
            setSelectedId(null);
            setAffectedIds([]);
          }
        }
      }
      chatSelectedId.current = null;
      return;
    }

    const clusterIdsToExpand = new Set();
    const validNodeIds = [];
    focusedIds.forEach((fid) => {
      const node = graph.nodes.find((n) => n.id === fid);
      if (node) {
        if (node.cluster?.id) clusterIdsToExpand.add(node.cluster.id);
        validNodeIds.push(fid);
      }
    });

    if (clusterIdsToExpand.size > 0) {
      setExpandedClusters((prev) => {
        const next = new Set(prev);
        clusterIdsToExpand.forEach((cid) => {
          if (!prev.has(cid)) {
            next.add(cid);
            chatExpandedClusters.current.add(cid);
          }
        });
        return next;
      });
    }

    // If exactly one node matched, auto-select it for details — but skip blast radius
    // to avoid lighting up unrelated edges through the full reachability set.
    if (validNodeIds.length === 1) {
      setSelectedId(validNodeIds[0]);
      setAffectedIds([]);
      setTab(mapping ? 'spec' : 'node');
      chatSelectedId.current = validNodeIds[0];
    }
  }, [focusedIds, graph, mapping]);

  const selectedNode = graph?.nodes.find((n) => n.id === selectedId);

  const selectedPath = selectedNode?.path ?? null;
  useEffect(() => {
    if (tab !== 'skeleton' || !selectedPath) { setSkeletonData(null); return; }
    setSkeletonLoading(true);
    fetch(`/api/skeleton?file=${encodeURIComponent(selectedPath)}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { setSkeletonData(d); setSkeletonLoading(false); })
      .catch(() => setSkeletonLoading(false));
  }, [tab, selectedPath]);

  const selectedEdges = useMemo(() => {
    if (!selectedId) return [];
    return visibleEdges.filter((e) => e.source === selectedId || e.target === selectedId);
  }, [selectedId, visibleEdges]);

  const linkedIds = useMemo(() => {
    if (!selectedId) return new Set();
    const set = new Set([selectedId, ...affectedIds]);
    visibleEdges.forEach((e) => {
      if (e.source === selectedId) set.add(e.target);
      if (e.target === selectedId) set.add(e.source);
    });
    return set;
  }, [selectedId, affectedIds, visibleEdges]);

  const stats = graph?.statistics || {};
  // Use structuralClusters (clusters with real internal edges) for all UI.
  // Compute from clusters if not present in the JSON (for backward compatibility).
  const structuralClusters = graph?.structuralClusters ??
    (graph?.clusters?.filter(c => c.internalEdges > 0) ?? []);
  // Fall back to all directory clusters when no structural ones exist (e.g. Swift/C++ projects
  // where dep edges come from the call graph and may not yet be available).
  const displayClusters = structuralClusters.length > 0
    ? structuralClusters
    : (graph?.clusters ?? []);
  const clusterNames = displayClusters.map((c) => c.name);

  // ── Upload screen ─────────────────────────────────────────────────────────
  if (!graph)
    return (
      <div
        style={{
          ...theme.vars,
          width: '100%',
          height: '100vh',
          background: 'var(--bg-base)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: "'JetBrains Mono',monospace",
          color: 'var(--tx-primary)',
          opacity: loaded ? 1 : 0,
          transition: 'opacity 0.3s',
        }}
      >
        <div style={{ fontSize: 10, letterSpacing: '0.18em', color: 'var(--tx-faint)', marginBottom: 28 }}>
          INTERACTIVE GRAPH VIEWER
        </div>
        <div
          style={{
            border: '1px dashed var(--ac-edge-type)',
            borderRadius: 12,
            padding: '44px 64px',
            textAlign: 'center',
            cursor: 'pointer',
          }}
          onClick={() => fileRef.current.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const f = e.dataTransfer.files[0];
            if (f) {
              const r = new FileReader();
              r.onload = (ev) => loadGraph(ev.target.result);
              r.readAsText(f);
            }
          }}
        >
          <div style={{ fontSize: 32, marginBottom: 14, color: 'var(--ac-primary)' }}>⬡</div>
          <div style={{ fontSize: 12, color: 'var(--tx-secondary)', marginBottom: 6 }}>
            Drop a <code style={{ color: 'var(--ac-primary)' }}>dependency-graph.json</code>
          </div>
          <div style={{ fontSize: 10, color: 'var(--tx-ghost)' }}>or click to browse</div>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".json"
          style={{ display: 'none' }}
          onChange={handleFile}
        />
        <input
          ref={mappingRef}
          type="file"
          accept=".json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files[0];
            if (f) {
              const r = new FileReader();
              r.onload = (ev) => loadMapping(ev.target.result);
              r.readAsText(f);
            }
          }}
        />
        <input
          ref={specRef}
          type="file"
          accept=".md"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files[0];
            if (f) {
              const r = new FileReader();
              r.onload = (ev) => loadSpec(ev.target.result);
              r.readAsText(f);
            }
          }}
        />
      </div>
    );

  // ── Main UI ───────────────────────────────────────────────────────────────
  return (
    <div
      style={{
        ...theme.vars,
        width: '100%',
        height: '100vh',
        background: 'var(--bg-base)',
        fontFamily: "'JetBrains Mono',monospace",
        color: 'var(--tx-primary)',
        display: 'flex',
        flexDirection: 'column',
        opacity: loaded ? 1 : 0,
        transition: 'opacity 0.3s',
      }}
    >
      {/* Top bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 18px',
          borderBottom: '1px solid var(--bd-faint)',
          background: 'var(--bg-panel)',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <div
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: 'var(--ac-primary)',
              boxShadow: '0 0 8px var(--ac-primary)',
            }}
          />
          <span
            style={{ fontSize: 10, fontWeight: 700, color: 'var(--tx-bright)', letterSpacing: '0.09em' }}
          >
            GRAPH VIEWER
          </span>
        </div>
        {[
          ['nodes', stats.nodeCount],
          ['edges', stats.edgeCount],
          ['clusters', displayClusters.length],
        ].map(([l, v]) => (
          <div
            key={l}
            style={{
              fontSize: 9,
              color: 'var(--tx-dim)',
              background: 'var(--bg-raised)',
              borderRadius: 4,
              padding: '2px 7px',
              border: '1px solid var(--bd-muted)',
            }}
          >
            <span style={{ color: 'var(--tx-muted)' }}>{v}</span> {l}
          </div>
        ))}
        <div style={{ display: 'flex', gap: 2, marginLeft: 8 }}>
          {[
            ['clusters', '⬡ clusters'],
            ['flat', '⊙ flat'],
            ['architecture', '⬛ architecture'],
            ['classes', '◈ classes'],
          ].map(([v, lbl]) => (
            <button
              key={v}
              onClick={() => {
                setViewMode(v);
                setSelectedId(null);
                setAffectedIds([]);
              }}
              style={{
                padding: '3px 10px',
                fontSize: 9,
                background: viewMode === v ? 'var(--bg-select)' : 'transparent',
                border: `1px solid ${viewMode === v ? 'var(--ac-primary)' : 'var(--bd-muted)'}`,
                borderRadius: 4,
                color: viewMode === v ? 'var(--tx-primary)' : 'var(--tx-ghost)',
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {lbl}
            </button>
          ))}
        </div>
        <div style={{ marginLeft: 'auto', position: 'relative' }}>
          <input
            value={search}
            onChange={(e) => handleSearch(e.target.value)}
            placeholder="search name, path, export, tag..."
            style={{
              background: 'var(--bg-input)',
              border: '1px solid var(--bd-muted)',
              color: 'var(--tx-primary)',
              padding: '5px 12px 5px 26px',
              borderRadius: 5,
              fontSize: 9,
              width: 230,
              outline: 'none',
              fontFamily: 'inherit',
            }}
          />
          <span
            style={{
              position: 'absolute',
              left: 8,
              top: '50%',
              transform: 'translateY(-50%)',
              fontSize: 11,
              color: 'var(--tx-ghost)',
            }}
          >
            ⌕
          </span>
          {search && (
            <span
              onClick={() => handleSearch('')}
              style={{
                position: 'absolute',
                right: focusedIds.length > 0 ? 22 : 8,
                top: '50%',
                transform: 'translateY(-50%)',
                fontSize: 10,
                color: 'var(--tx-ghost)',
                cursor: 'pointer',
                lineHeight: 1,
              }}
            >
              x
            </span>
          )}
          {focusedIds.length > 0 && (
            <span
              style={{
                position: 'absolute',
                right: 8,
                top: '50%',
                transform: 'translateY(-50%)',
                fontSize: 9,
                color: 'var(--ac-primary)',
              }}
            >
              {focusedIds.length}
            </span>
          )}
          {semanticResults.length > 0 && (
            <div
              style={{
                position: 'absolute',
                top: '100%',
                right: 0,
                marginTop: 4,
                width: 280,
                background: 'var(--bg-input)',
                border: '1px solid var(--bd-muted)',
                borderRadius: 5,
                zIndex: 100,
                boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
                overflow: 'hidden',
              }}
            >
              <div style={{ padding: '4px 8px', borderBottom: '1px solid var(--bd-muted)', fontSize: 8, color: 'var(--tx-ghost)', fontFamily: 'inherit' }}>
                ✦ semantic matches
              </div>
              {semanticResults.map((r) => {
                const node = graph?.nodes.find((n) => n.path === r.filePath || n.path.endsWith(r.filePath) || r.filePath.endsWith(n.path));
                return (
                  <div
                    key={r.id}
                    onClick={() => { if (node) { handleSelect(node.id); setSemanticResults([]); setSearch(''); } }}
                    style={{
                      padding: '5px 8px',
                      cursor: node ? 'pointer' : 'default',
                      borderBottom: '1px solid var(--bd-faint)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 2,
                      opacity: node ? 1 : 0.4,
                    }}
                    onMouseEnter={(e) => { if (node) e.currentTarget.style.background = 'var(--bg-hover)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: 9, color: 'var(--tx-primary)', fontFamily: "'JetBrains Mono',monospace" }}>{r.name}</span>
                      <span style={{ fontSize: 8, color: 'var(--tx-dim)', fontFamily: 'inherit' }}>{(1 - r.score).toFixed(2)}</span>
                    </div>
                    <span style={{ fontSize: 8, color: 'var(--tx-ghost)', fontFamily: 'inherit', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.filePath.split('/').slice(-2).join('/')}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <button
          onClick={() => {
            setRawGraph(null);
            setSelectedId(null);
          }}
          style={{
            background: 'none',
            border: '1px solid var(--bd-muted)',
            borderRadius: 4,
            color: 'var(--tx-ghost)',
            fontSize: 8,
            padding: '3px 8px',
            cursor: 'pointer',
            fontFamily: 'inherit',
            letterSpacing: '0.06em',
          }}
        >
          LOAD
        </button>
        <button
          onClick={() => mappingRef.current.click()}
          style={{
            background: mapping ? 'var(--bg-select)' : 'none',
            border: `1px solid ${mapping ? 'var(--ac-teal)' : 'var(--bd-muted)'}`,
            borderRadius: 4,
            color: mapping ? 'var(--ac-teal)' : 'var(--tx-ghost)',
            fontSize: 8,
            padding: '3px 8px',
            cursor: 'pointer',
            fontFamily: 'inherit',
            letterSpacing: '0.06em',
          }}
          title="Load mapping.json"
        >
          {mapping ? '[x] MAP' : 'MAP'}
        </button>
        <button
          onClick={() => specRef.current.click()}
          style={{
            background: Object.keys(specReqs).length ? 'var(--bg-select)' : 'none',
            border: `1px solid ${Object.keys(specReqs).length ? 'var(--ac-primary)' : 'var(--bd-muted)'}`,
            borderRadius: 4,
            color: Object.keys(specReqs).length ? 'var(--ac-primary)' : 'var(--tx-ghost)',
            fontSize: 8,
            padding: '3px 8px',
            cursor: 'pointer',
            fontFamily: 'inherit',
            letterSpacing: '0.06em',
          }}
          title="Load spec.md"
        >
          {Object.keys(specReqs).length ? '[x] SPEC' : 'SPEC'}
        </button>
        <button
          onClick={() => setChatOpen((v) => !v)}
          style={{
            background: chatOpen ? 'var(--bg-select)' : 'none',
            border: `1px solid ${chatOpen ? 'var(--ac-primary)' : 'var(--bd-muted)'}`,
            borderRadius: 4,
            color: chatOpen ? 'var(--ac-primary)' : 'var(--tx-ghost)',
            fontSize: 8,
            padding: '3px 8px',
            cursor: 'pointer',
            fontFamily: 'inherit',
            letterSpacing: '0.06em',
          }}
          title="Toggle AI chat"
        >
          CHAT
        </button>
        <button
          onClick={cycleTheme}
          title="Cycle theme"
          style={{
            background: 'none',
            border: '1px solid var(--bd-muted)',
            borderRadius: 4,
            color: 'var(--ac-primary)',
            fontSize: 8,
            padding: '3px 8px',
            cursor: 'pointer',
            fontFamily: 'inherit',
            letterSpacing: '0.06em',
          }}
        >
          {theme.label}
        </button>
        <input
          ref={mappingRef}
          type="file"
          accept=".json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files[0];
            if (f) {
              const r = new FileReader();
              r.onload = (ev) => loadMapping(ev.target.result);
              r.readAsText(f);
            }
          }}
        />
        <input
          ref={specRef}
          type="file"
          accept=".md"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files[0];
            if (f) {
              const r = new FileReader();
              r.onload = (ev) => loadSpec(ev.target.result);
              r.readAsText(f);
            }
          }}
        />
      </div>

      <FreshnessBanner freshness={freshness} />

      {/* Filter bar */}
      {viewMode !== 'architecture' && viewMode !== 'classes' && (
        <FilterBar
          filters={filters}
          setFilters={setFilters}
          stats={filterStats}
          clusterNames={clusterNames}
        />
      )}

      {/* Body */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Canvas */}
        <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
          {viewMode === 'architecture' ? (
            <ArchitectureView graph={graph} llmCtx={llmCtx} focusedIds={focusedIds} />
          ) : viewMode === 'classes' ? (
            <ClassGraph
              classData={classData}
              selectedClassId={selectedClassId}
              onSelectClass={setSelectedClass}
              focusedPaths={focusedPaths}
              onClear={() => setFocusedPaths([])}
            />
          ) : viewMode === 'clusters' ? (
            <ClusterGraph
              clusters={displayClusters.filter(
                (cl) => !filters.cluster || cl.name === filters.cluster
              )}
              edges={visibleEdges}
              nodes={visibleNodes}
              allNodes={graph.nodes.filter(
                (n) => !filters.cluster || n.cluster.name === filters.cluster
              )}
              expandedClusters={expandedClusters}
              onToggle={toggleCluster}
              onSelectNode={handleSelect}
              onClear={clearSelection}
              hasSelection={selectedId !== null || expandedClusters.size > 0}
              selectedId={selectedId}
              affectedIds={affectedIds}
              linkedIds={linkedIds}
              focusedIds={focusedIds}
              noGlow={themeName === 'light' || themeName === 'warm'}
            />
          ) : (
            <FlatGraph
              nodes={visibleNodes}
              edges={visibleEdges}
              selectedId={selectedId}
              affectedIds={affectedIds}
              focusedIds={focusedIds}
              onSelect={handleSelect}
              refactorOnly={filters.refactorOnly}
              linkedIds={linkedIds}
              noGlow={themeName === 'light' || themeName === 'warm'}
            />
          )}
          {!selectedId && (
            <div
              style={{
                position: 'absolute',
                bottom: 12,
                left: '50%',
                transform: 'translateX(-50%)',
                fontSize: 9,
                color: 'var(--bd-edge)',
                letterSpacing: '0.1em',
                pointerEvents: 'none',
                whiteSpace: 'nowrap',
              }}
            >
              {viewMode === 'clusters'
                ? 'CLICK CLUSTER -> EXPAND  ·  CLICK NODE -> INSPECT'
                : viewMode === 'classes'
                ? 'CLICK CLASS -> EXPAND METHODS  ·  DBL-CLICK -> RESET VIEW'
                : 'CLICK NODE -> INSPECT'}
            </div>
          )}
        </div>

        {/* Chat panel */}
        {chatOpen && (
          <ChatPanel
            onHighlight={(ids) => setFocusedIds(ids)}
            onHighlightPaths={(paths) => setFocusedPaths(paths)}
            onClose={() => { setChatOpen(false); setFocusedIds([]); setFocusedPaths([]); }}
            onClearGraph={() => {
              setFocusedIds([]);
              setFocusedPaths([]);
              setExpandedClusters(new Set());
              setSelectedId(null);
              setAffectedIds([]);
            }}
          />
        )}

        {/* Side panel */}
        <div
          style={{
            width: 282,
            borderLeft: '1px solid var(--bd-faint)',
            background: 'var(--bg-deep)',
            display: viewMode === 'architecture' || viewMode === 'classes' ? 'none' : 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            flexShrink: 0,
          }}
        >
          <div style={{ display: 'flex', borderBottom: '1px solid var(--bd-faint)', flexShrink: 0 }}>
            {['node', 'links', 'blast', 'spec', 'skeleton', 'info'].map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                style={{
                  flex: 1,
                  padding: '7px 0',
                  background: 'none',
                  border: 'none',
                  borderBottom: tab === t ? '2px solid var(--ac-primary)' : '2px solid transparent',
                  color: tab === t ? 'var(--tx-primary)' : 'var(--tx-ghost)',
                  fontSize: 8,
                  letterSpacing: '0.06em',
                  fontWeight: 700,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  textTransform: 'uppercase',
                }}
              >
                {t}
              </button>
            ))}
          </div>

          <div style={{ flex: 1, overflow: 'auto', padding: 13 }}>
            {/* NODE */}
            {tab === 'node' && !selectedNode && <Hint>Select a node to inspect it.</Hint>}
            {tab === 'node' && selectedNode && (
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--tx-bright)', marginBottom: 2 }}>
                  {selectedNode.label}
                </div>
                <div
                  style={{
                    fontSize: 8,
                    color: 'var(--tx-ghost)',
                    marginBottom: 9,
                    wordBreak: 'break-all',
                    lineHeight: 1.7,
                  }}
                >
                  {selectedNode.path}
                </div>
                <Row
                  label="ext"
                  value={<Chip color={extColor(selectedNode.ext)}>{selectedNode.ext || '--'}</Chip>}
                />
                <Row label="lines" value={selectedNode.lines} />
                <Row label="size" value={`${(selectedNode.size / 1024).toFixed(1)} KB`} />
                <Row
                  label="score"
                  value={
                    <span style={{ color: 'var(--ac-primary)', fontWeight: 700 }}>{selectedNode.score}</span>
                  }
                />
                <Row
                  label="cluster"
                  value={
                    <Chip color={selectedNode.cluster.color}>{selectedNode.cluster.name}</Chip>
                  }
                />
                <div style={{ display: 'flex', gap: 4, marginTop: 8, flexWrap: 'wrap' }}>
                  {selectedNode.isEntry && <Chip color="#f77c6a">entry-point</Chip>}
                  {selectedNode.isConfig && <Chip color="#f5c518">config</Chip>}
                  {selectedNode.isTest && <Chip color="#3ecfcf">test</Chip>}
                  {selectedNode.tags.map((t) => (
                    <Chip key={t} color="#4a5070">
                      {t}
                    </Chip>
                  ))}
                </div>
                {selectedNode.exports.length > 0 && (
                  <>
                    <SL>Exports ({selectedNode.exports.length})</SL>
                    {selectedNode.exports.map((ex, i) => (
                      <div
                        key={i}
                        style={{
                          display: 'flex',
                          gap: 5,
                          alignItems: 'center',
                          padding: '3px 0',
                          borderBottom: '1px solid var(--bd-faint)',
                        }}
                      >
                        <KindBadge kind={ex.kind} />
                        <span style={{ fontSize: 9, color: 'var(--tx-secondary)' }}>{ex.name}</span>
                        <span style={{ marginLeft: 'auto', fontSize: 8, color: 'var(--tx-faint)' }}>
                          L{ex.line}
                        </span>
                      </div>
                    ))}
                  </>
                )}
                <SL>Metrics</SL>
                {[
                  ['inDegree', '↙'],
                  ['outDegree', '↗'],
                  ['pageRank', 'PR'],
                  ['betweenness', '⋈'],
                ].map(([k, s]) => (
                  <Row
                    key={k}
                    label={`${s} ${k}`}
                    value={
                      typeof selectedNode.metrics[k] === 'number'
                        ? selectedNode.metrics[k].toFixed(3)
                        : '-'
                    }
                  />
                ))}
                {selectedNode.refactor && (
                  <>
                    <SL>Refactor</SL>
                    <Row label="Functions affected" value={selectedNode.refactor.functions} />
                    <Row
                      label="Max priority"
                      value={
                        <span
                          style={{
                            color: selectedNode.refactor.maxPriority >= 5 ? '#f97373' : '#fbbf24',
                            fontWeight: 700,
                          }}
                        >
                          {selectedNode.refactor.maxPriority.toFixed(1)}
                        </span>
                      }
                    />
                    <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {selectedNode.refactor.issues.map((iss) => (
                        <Chip key={iss} color="#f97373">
                          {iss.replace(/_/g, ' ')}
                        </Chip>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}

            {/* LINKS */}
            {tab === 'links' && !selectedId && (
              <Hint>Select a node to see its direct imports/exports.</Hint>
            )}
            {tab === 'links' && selectedId && (
              <div>
                {(() => {
                  const outEdges = selectedEdges.filter((e) => e.source === selectedId);
                  const inEdges = selectedEdges.filter((e) => e.target === selectedId);
                  return (
                    <>
                      <SL>Imports ({outEdges.length})</SL>
                      {outEdges.length === 0 && (
                        <div style={{ color: 'var(--tx-faint)', fontSize: 9 }}>No imports.</div>
                      )}
                      {outEdges.map((e, i) => {
                        const tn = graph.nodes.find((n) => n.id === e.target);
                        return (
                          <div
                            key={i}
                            onClick={() => handleSelect(e.target)}
                            style={{
                              padding: '5px 7px',
                              marginBottom: 3,
                              background: 'var(--bg-input)',
                              borderRadius: 4,
                              border: `1px solid ${tn?.cluster.color || 'var(--bd-muted)'}22`,
                              cursor: 'pointer',
                            }}
                          >
                            <div
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 5,
                                marginBottom: e.importedNames.length ? 3 : 0,
                              }}
                            >
                              <span style={{ fontSize: 8, color: extColor(tn?.ext || '') }}>↗</span>
                              <span style={{ fontSize: 9, color: 'var(--tx-primary)' }}>
                                {tn?.label || e.target}
                              </span>
                              {e.isType && (
                                <span style={{ fontSize: 7, color: 'var(--tx-ghost)', marginLeft: 'auto' }}>
                                  type
                                </span>
                              )}
                            </div>
                            {e.importedNames.length > 0 && (
                              <div style={{ fontSize: 7.5, color: 'var(--tx-dim)', paddingLeft: 12 }}>
                                {e.importedNames.join(', ')}
                              </div>
                            )}
                          </div>
                        );
                      })}
                      <SL>Imported by ({inEdges.length})</SL>
                      {inEdges.length === 0 && (
                        <div style={{ color: 'var(--tx-faint)', fontSize: 9 }}>
                          Not imported by any visible files.
                        </div>
                      )}
                      {inEdges.map((e, i) => {
                        const sn = graph.nodes.find((n) => n.id === e.source);
                        return (
                          <div
                            key={i}
                            onClick={() => handleSelect(e.source)}
                            style={{
                              padding: '5px 7px',
                              marginBottom: 3,
                              background: 'var(--bg-input)',
                              borderRadius: 4,
                              border: `1px solid ${sn?.cluster.color || 'var(--bd-muted)'}22`,
                              cursor: 'pointer',
                            }}
                          >
                            <div
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 5,
                                marginBottom: e.importedNames.length ? 3 : 0,
                              }}
                            >
                              <span style={{ fontSize: 8, color: 'var(--ac-primary)' }}>↙</span>
                              <span style={{ fontSize: 9, color: 'var(--tx-primary)' }}>
                                {sn?.label || e.source}
                              </span>
                              {e.isType && (
                                <span style={{ fontSize: 7, color: 'var(--tx-ghost)', marginLeft: 'auto' }}>
                                  type
                                </span>
                              )}
                            </div>
                            {e.importedNames.length > 0 && (
                              <div style={{ fontSize: 7.5, color: 'var(--tx-dim)', paddingLeft: 12 }}>
                                {e.importedNames.join(', ')}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </>
                  );
                })()}
              </div>
            )}

            {/* BLAST */}
            {tab === 'blast' && !selectedId && (
              <Hint>Select a node to compute downstream impact.</Hint>
            )}
            {tab === 'blast' && selectedId && (
              <div>
                <div style={{ fontSize: 9, color: 'var(--tx-secondary)', marginBottom: 10 }}>
                  Modifying <span style={{ color: 'var(--ac-primary)' }}>{selectedNode?.label}</span> impacts:
                </div>
                {affectedIds.length === 0 ? (
                  <div style={{ color: 'var(--tx-faint)', fontSize: 9 }}>No visible downstream nodes.</div>
                ) : (
                  affectedIds.map((id) => {
                    const n = graph.nodes.find((x) => x.id === id);
                    return (
                      <div
                        key={id}
                        onClick={() => handleSelect(id)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '4px 7px',
                          marginBottom: 3,
                          background: 'var(--bg-input)',
                          borderRadius: 4,
                          border: '1px solid var(--bd-muted)',
                          cursor: 'pointer',
                        }}
                      >
                        <span style={{ fontSize: 8, color: extColor(n?.ext || '') }}>
                          {n?.ext || '?'}
                        </span>
                        <span
                          style={{
                            fontSize: 9,
                            color: 'var(--tx-primary)',
                            flex: 1,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {n?.label || id}
                        </span>
                        <span style={{ fontSize: 7, color: `${n?.cluster.color || '#3a3f5c'}80` }}>
                          {n?.cluster.name.split('/').pop()}
                        </span>
                      </div>
                    );
                  })
                )}
                <div
                  style={{
                    marginTop: 10,
                    padding: '8px 10px',
                    background: 'var(--bg-input)',
                    borderRadius: 5,
                    border: '1px solid var(--bd-muted)',
                  }}
                >
                  <div style={{ fontSize: 8, color: 'var(--tx-ghost)', marginBottom: 2 }}>BLAST RADIUS</div>
                  <div
                    style={{
                      fontSize: 22,
                      fontWeight: 700,
                      color:
                        affectedIds.length > 8
                          ? '#f77c6a'
                          : affectedIds.length > 3
                            ? '#f7c76a'
                            : 'var(--ac-primary)',
                    }}
                  >
                    {affectedIds.length}{' '}
                    <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--tx-ghost)' }}>nodes</span>
                  </div>
                </div>
              </div>
            )}

            {/* SPEC */}
            {tab === 'spec' && !mapping && (
              <Hint>
                Load a <code style={{ color: 'var(--ac-primary)' }}>mapping.json</code> and{' '}
                <code style={{ color: 'var(--ac-primary)' }}>spec.md</code> using the MAP / SPEC buttons in
                the top bar.
              </Hint>
            )}
            {tab === 'spec' && mapping && !selectedId && (
              <Hint>Select a node to see its linked spec requirements.</Hint>
            )}
            {tab === 'spec' &&
              mapping &&
              selectedId &&
              (() => {
                const nodePath = normalizePath(selectedNode?.path || selectedId);
                const entries = [];
                for (const [k, list] of Object.entries(mapping)) {
                  if (nodePath.endsWith(k) || k.endsWith(nodePath) || nodePath === k) {
                    entries.push(...list);
                  }
                }
                const seen = new Set();
                const unique = entries.filter((e) => {
                  const key = e.requirement;
                  if (seen.has(key)) return false;
                  seen.add(key);
                  return true;
                });

                if (unique.length === 0)
                  return <Hint>No spec requirements mapped to this file.</Hint>;

                const confidenceColor = (c) => (c === 'llm' ? '#4ade80' : 'var(--tx-ghost)');

                return (
                  <div>
                    <div style={{ fontSize: 8, color: 'var(--tx-ghost)', marginBottom: 8 }}>
                      {unique.length} requirement{unique.length > 1 ? 's' : ''} linked
                    </div>
                    {unique.map((entry, i) => {
                      const req = specReqs ? specReqs[entry.requirement] : null;
                      const domainColor =
                        {
                          llm: '#3ecfcf',
                          task: '#f7c76a',
                          project: '#6af7a0',
                          openspec: '#7c6af7',
                        }[entry.domain] || '#64748b';
                      return (
                        <div
                          key={i}
                          style={{
                            marginBottom: 10,
                            background: 'var(--bg-node)',
                            borderRadius: 5,
                            border: '1px solid var(--bd-muted)',
                            overflow: 'hidden',
                          }}
                        >
                          <div
                            style={{
                              padding: '6px 9px',
                              borderBottom: '1px solid var(--bd-faint)',
                              display: 'flex',
                              alignItems: 'center',
                              gap: 5,
                              flexWrap: 'wrap',
                            }}
                          >
                            <span
                              style={{ fontSize: 9, fontWeight: 700, color: 'var(--tx-primary)', flex: 1 }}
                            >
                              {entry.requirement}
                            </span>
                            <span
                              style={{
                                fontSize: 7,
                                padding: '1px 5px',
                                borderRadius: 3,
                                background: `${domainColor}18`,
                                color: domainColor,
                                border: `1px solid ${domainColor}30`,
                              }}
                            >
                              {entry.domain}
                            </span>
                            <span
                              style={{ fontSize: 7, color: confidenceColor(entry.confidence) }}
                              title={`confidence: ${entry.confidence}`}
                            >
                              {entry.confidence === 'llm' ? '● llm' : '◌ heuristic'}
                            </span>
                          </div>
                          {req?.body ? (
                            <div
                              style={{
                                padding: '7px 9px',
                                fontSize: 8.5,
                                color: 'var(--tx-secondary)',
                                lineHeight: 1.7,
                                maxHeight: 200,
                                overflow: 'auto',
                              }}
                            >
                              {req.body.split('\n').map((line, li) => {
                                if (line.startsWith('####'))
                                  return (
                                    <div
                                      key={li}
                                      style={{
                                        color: 'var(--tx-node)',
                                        fontWeight: 700,
                                        marginTop: 6,
                                        fontSize: 8,
                                      }}
                                    >
                                      {line.replace(/^#+\s*/, '')}
                                    </div>
                                  );
                                if (line.startsWith('- **'))
                                  return (
                                    <div key={li} style={{ paddingLeft: 6, color: 'var(--tx-secondary)' }}>
                                      {line.replace(/\*\*/g, '')}
                                    </div>
                                  );
                                if (line.trim() === '')
                                  return <div key={li} style={{ height: 4 }} />;
                                return <div key={li}>{line}</div>;
                              })}
                            </div>
                          ) : (
                            <div style={{ padding: '7px 9px', fontSize: 8, color: 'var(--tx-faint)' }}>
                              {req
                                ? 'Requirement title mismatch — spec section not found in the spec file.'
                                : <>Spec not loaded — run <code style={{ color: 'var(--ac-primary)' }}>openlore view</code> or load <code style={{ color: 'var(--ac-primary)' }}>spec.md</code> manually.</>}
                            </div>
                          )}
                          <div
                            style={{
                              padding: '4px 9px',
                              borderTop: '1px solid var(--bd-faint)',
                              fontSize: 7.5,
                              color: 'var(--ac-cluster-arr)',
                            }}
                          >
                            service: <span style={{ color: 'var(--tx-dim)' }}>{entry.service}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}

            {/* SKELETON */}
            {tab === 'skeleton' && !selectedNode && (
              <Hint>Select a node to view its code skeleton.</Hint>
            )}
            {tab === 'skeleton' && selectedNode && (
              <div>
                {skeletonLoading && <Hint>Loading...</Hint>}
                {!skeletonLoading && !skeletonData && <Hint>Skeleton unavailable for this file.</Hint>}
                {!skeletonLoading && skeletonData && (
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <span style={{ fontSize: 9, color: 'var(--tx-muted)', fontFamily: 'inherit' }}>
                        {skeletonData.language} · {skeletonData.skeletonLines}/{skeletonData.originalLines} lines
                      </span>
                      <span style={{ fontSize: 9, color: skeletonData.reductionPct >= 20 ? 'var(--ac-primary)' : 'var(--tx-ghost)', fontFamily: 'inherit' }}>
                        -{skeletonData.reductionPct}%
                      </span>
                    </div>
                    <pre style={{
                      margin: 0,
                      fontSize: 8,
                      lineHeight: 1.6,
                      color: 'var(--tx-secondary)',
                      fontFamily: "'JetBrains Mono', monospace",
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      background: 'var(--bg-deep)',
                      border: '1px solid var(--bd-faint)',
                      borderRadius: 4,
                      padding: '8px 10px',
                    }}>
                      {skeletonData.skeleton}
                    </pre>
                  </div>
                )}
              </div>
            )}

            {/* INFO */}
            {tab === 'info' && (
              <div>
                <SL>Statistics</SL>
                {[
                  ['Nodes', stats.nodeCount],
                  ['Edges', stats.edgeCount],
                  ['Clusters', stats.structuralClusterCount ?? displayClusters.length],
                  ['Cycles', stats.cycleCount],
                  ['Avg degree', stats.avgDegree?.toFixed(2)],
                  ['Density', stats.density?.toFixed(4)],
                ].map(([l, v]) => (
                  <Row key={l} label={l} value={v ?? '-'} />
                ))}
                <SL>Active filters</SL>
                <Row
                  label="Visible nodes"
                  value={<span style={{ color: 'var(--ac-primary)' }}>{filterStats.visible}</span>}
                />
                <Row
                  label="Visible edges"
                  value={<span style={{ color: 'var(--ac-teal)' }}>{filterStats.visibleEdges}</span>}
                />
                <Row label="Orphans" value={filterStats.orphanCount} />
                <SL>Top 10 by score</SL>
                {(graph.rankings.byImportance || []).slice(0, 10).map((fid, i) => {
                  const n = graph.nodes.find((x) => x.id === fid);
                  if (!n) return null;
                  return (
                    <div
                      key={fid}
                      onClick={() => handleSelect(fid)}
                      style={{
                        display: 'flex',
                        gap: 5,
                        alignItems: 'center',
                        padding: '3px 0',
                        cursor: 'pointer',
                      }}
                    >
                      <span style={{ fontSize: 8, color: 'var(--tx-faint)', minWidth: 12 }}>{i + 1}</span>
                      <span style={{ fontSize: 8, color: extColor(n.ext) }}>{n.ext || '—'}</span>
                      <span
                        style={{
                          fontSize: 9,
                          color: 'var(--tx-secondary)',
                          flex: 1,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {n.label}
                      </span>
                      <span style={{ fontSize: 9, color: 'var(--ac-primary)' }}>{n.score}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Cluster legend */}
          <div style={{ padding: '9px 13px', borderTop: '1px solid var(--bd-faint)', flexShrink: 0 }}>
            <div style={{ display: 'flex', gap: 12, marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <svg width="24" height="8" style={{ overflow: 'visible' }}>
                  <line
                    x1="0"
                    y1="4"
                    x2="18"
                    y2="4"
                    stroke="var(--tx-node)"
                    strokeWidth="1.5"
                    markerEnd="url(#arr-legend)"
                  />
                  <defs>
                    <marker
                      id="arr-legend"
                      markerWidth="5"
                      markerHeight="5"
                      refX="4"
                      refY="2.5"
                      orient="auto"
                    >
                      <path d="M0,0 L0,5 L5,2.5z" style={{ fill: 'var(--tx-node)' }} />
                    </marker>
                  </defs>
                </svg>
                <span style={{ fontSize: 7.5, color: 'var(--tx-ghost)' }}>runtime import</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <svg width="24" height="8" style={{ overflow: 'visible' }}>
                  <line
                    x1="0"
                    y1="4"
                    x2="18"
                    y2="4"
                    stroke="var(--tx-ghost)"
                    strokeWidth="1.2"
                    strokeDasharray="3 2"
                    markerEnd="url(#arr-legend-type)"
                  />
                  <defs>
                    <marker
                      id="arr-legend-type"
                      markerWidth="5"
                      markerHeight="5"
                      refX="4"
                      refY="2.5"
                      orient="auto"
                    >
                      <path d="M0,0 L0,5 L5,2.5z" style={{ fill: 'var(--tx-ghost)' }} />
                    </marker>
                  </defs>
                </svg>
                <span style={{ fontSize: 7.5, color: 'var(--tx-ghost)' }}>type-only</span>
              </div>
            </div>
            <div
              style={{ fontSize: 8, color: 'var(--ac-arrow)', letterSpacing: '0.08em', marginBottom: 5 }}
            >
              CLUSTERS · click to filter
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {displayClusters.map((cl) => (
                <div
                  key={cl.id}
                  onClick={() =>
                    setFilters((f) => ({ ...f, cluster: f.cluster === cl.name ? '' : cl.name }))
                  }
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 3,
                    cursor: 'pointer',
                    opacity: filters.cluster && filters.cluster !== cl.name ? 0.25 : 1,
                    transition: 'opacity 0.15s',
                  }}
                >
                  <div
                    style={{
                      width: 5,
                      height: 5,
                      borderRadius: '50%',
                      background: cl.color,
                      boxShadow: filters.cluster === cl.name ? `0 0 5px ${cl.color}` : 'none',
                    }}
                  />
                  <span
                    style={{
                      fontSize: 7.5,
                      color: filters.cluster === cl.name ? cl.color : 'var(--tx-ghost)',
                    }}
                  >
                    {cl.name}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
