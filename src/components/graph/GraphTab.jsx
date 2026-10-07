import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactFlow, { Background, Controls, MiniMap } from 'reactflow'
import 'reactflow/dist/style.css'
import { useStore } from '../../store'
import { hideNodeHover, scheduleNodeHover } from '../shared/nodeHover'
import { fmt, nodeColor, typeLabel } from '../../lib/schema'
import { getNodeSubline } from '../../lib/subline'
import { Dot, NodeColorDot, Tag } from '../shared/TypeTag'
import {
  DEFAULT_GROUP_LIMIT,
  MAX_VISIBLE_NODES,
  NODE_HEIGHT,
  NODE_WIDTH,
  collapseAll,
  deriveGraph,
  emptyExploreState,
  exploreEdgeLabel,
  groupStatus,
  hiddenNeighborCount,
  isExpanded,
  layoutExploreGraph,
  loadMore,
  positionNewNodes,
  rootAt,
  searchNodes,
  toggle,
  topDegreeNodes,
} from '../../lib/graphExplore'
import { ExploreNode } from './ExploreNode'

const NODE_TYPES = { exploreNode: ExploreNode }

// Above this many lines, edge labels stop being information and become a grey
// wash that also costs an SVG text node each. The checkbox still governs
// whether they are wanted at all; this is the ceiling on top of it.
const MAX_EDGE_LABELS = 150

// A click that lands this soon after the previous one on the same box is the
// second half of a double click -- which means "open in Explorer", not "toggle
// twice and end up where you started".
const DOUBLE_CLICK_MS = 300

const DIR_SYMBOL = { o: '→', i: '←' }

// Which pair of handles an edge should use: the two sides that actually face
// each other. With neighbours fanned out in every direction, a fixed
// left-to-right pair would send half the lines around the outside of their own
// box before reaching the gap between the two.
function handlePair(a, b) {
  const dx = (b?.x ?? 0) - (a?.x ?? 0)
  const dy = (b?.y ?? 0) - (a?.y ?? 0)
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? ['s-right', 't-left'] : ['s-left', 't-right']
  return dy >= 0 ? ['s-bottom', 't-top'] : ['s-top', 't-bottom']
}

/** Free exploration of the graph itself: start at one node and open its
    neighbours click by click. Distinct from the Overview's schema graph (types,
    not instances) and from the Harris Matrix (one stratigraphic property, in
    ranks) -- here the whole graph is reachable, one hop at a time. */
export function GraphTab({ active, domId = 'tab-graph' }) {
  const graph = useStore((s) => s.graph)
  const schema = useStore((s) => s.schema)
  const selectedId = useStore((s) => s.selectedId)
  const navigateTo = useStore((s) => s.navigateTo)
  const openInExplorer = useStore((s) => s.openInExplorer)

  // The exploration lives here, not in the store, for the same reason the
  // Matrix keeps its property choice local: two Dashboard panes should be able
  // to follow two different threads through the same graph.
  const [state, setState] = useState(emptyExploreState)
  const [focusId, setFocusId] = useState(null)
  const [query, setQuery] = useState('')
  const [pickerType, setPickerType] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [showEdgeLabels, setShowEdgeLabels] = useState(true)
  // Positions are a cache, not state: they must survive every re-derivation
  // untouched (that is what keeps the canvas still while you expand). The tick
  // is what tells React the cache changed after a drag or a re-layout.
  const positionsRef = useRef({})
  const [layoutTick, setLayoutTick] = useState(0)
  const rfRef = useRef(null)
  const pickerRef = useRef(null)
  const lastClick = useRef({ id: null, at: 0 })

  // A new graph -- a fresh import, or types collapsed/re-expanded -- invalidates
  // every id we hold. Adjusting during render rather than in an effect avoids
  // painting one frame of the old exploration over the new data.
  const graphRef = useRef(graph)
  if (graphRef.current !== graph) {
    graphRef.current = graph
    positionsRef.current = {}
    setState(emptyExploreState())
    setFocusId(null)
    setQuery('')
    setPickerType('')
  }

  const derived = useMemo(() => deriveGraph(graph, state), [graph, state])
  const visibleIds = useMemo(() => new Set(derived.nodes.map((n) => n.id)), [derived])

  const positions = useMemo(() => {
    const next = positionNewNodes(derived.nodes, positionsRef.current)
    positionsRef.current = next
    return next
    // layoutTick is the dependency that matters after a drag or "Neu anordnen":
    // the node set is unchanged, the cache behind it is not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [derived, layoutTick])

  // How many neighbours each box is still holding back. Kept out of the node
  // list below so dragging -- which changes positions on every pointer move --
  // doesn't re-walk the adjacency of every visible node.
  const hiddenCounts = useMemo(() => {
    const m = new Map()
    for (const n of derived.nodes) m.set(n.id, hiddenNeighborCount(graph, visibleIds, n.id))
    return m
  }, [graph, derived, visibleIds])

  const types = useMemo(
    () => Object.keys(graph?.node_types || {}).sort((a, b) => typeLabel(schema, a).localeCompare(typeLabel(schema, b))),
    [graph, schema]
  )

  const hits = useMemo(
    () => (pickerOpen ? searchNodes(graph, query, pickerType) : []),
    [graph, query, pickerType, pickerOpen]
  )

  // Only worth the full scan while there is nothing to show yet.
  const suggestions = useMemo(
    () => (state.rootId || !graph ? [] : topDegreeNodes(graph, 8)),
    [graph, state.rootId]
  )

  const setRoot = useCallback((id) => {
    positionsRef.current = {}
    setState(rootAt(id))
    setFocusId(id)
    setPickerOpen(false)
    setQuery('')
  }, [])

  // Pick up whatever the rest of the app has selected, but only to get
  // started: re-rooting on every later selection change would throw away an
  // exploration in progress each time a click elsewhere lands on a node.
  useEffect(() => {
    if (!state.rootId && selectedId && graph?.nodes?.[selectedId]) setRoot(selectedId)
  }, [selectedId, state.rootId, graph, setRoot])

  // The picker floats over the canvas, so it has to close on a click anywhere
  // outside it -- otherwise it stays put over exactly the graph it was opened
  // to reach.
  useEffect(() => {
    if (!pickerOpen) return
    function onDocDown(e) {
      if (!pickerRef.current?.contains(e.target)) setPickerOpen(false)
    }
    document.addEventListener('mousedown', onDocDown)
    return () => document.removeEventListener('mousedown', onDocDown)
  }, [pickerOpen])

  // The panel is hidden until its tab is active, and a hidden container has no
  // size -- so ReactFlow's initial fitView has nothing to fit to. Fit once the
  // view is actually on screen, and again whenever the exploration restarts.
  useEffect(() => {
    if (!active || !state.rootId) return
    const t = setTimeout(() => rfRef.current?.fitView({ padding: 0.3, duration: 250 }), 60)
    return () => clearTimeout(t)
  }, [active, state.rootId])

  const onNodesChange = useCallback((changes) => {
    let moved = false
    for (const c of changes) {
      if (c.type === 'position' && c.position) {
        positionsRef.current[c.id] = c.position
        moved = true
      }
    }
    if (moved) setLayoutTick((t) => t + 1)
  }, [])

  function relayout() {
    positionsRef.current = layoutExploreGraph(derived.nodes, derived.edges)
    setLayoutTick((t) => t + 1)
    setTimeout(() => rfRef.current?.fitView({ padding: 0.3, duration: 250 }), 30)
  }

  function handleNodeClick(e, n) {
    hideNodeHover()
    // Ctrl/Cmd-click is the shortcut for the focus bar's "Im Explorer öffnen",
    // for people who'd rather not go via the bar.
    if (e.ctrlKey || e.metaKey) {
      openInExplorer(n.id)
      return
    }
    const now = Date.now()
    if (lastClick.current.id === n.id && now - lastClick.current.at < DOUBLE_CLICK_MS) return
    lastClick.current = { id: n.id, at: now }
    setFocusId(n.id)
    setState((s) => toggle(s, n.id))
    // Keep the linked views in sync without touching the Explorer's trail --
    // expanding a node is looking around, not navigating to it.
    navigateTo(n.id, false)
  }

  if (!graph) return null

  const focusNode = focusId && graph.nodes[focusId] ? graph.nodes[focusId] : null
  const focusGroups = focusNode ? groupStatus(graph, state, visibleIds, focusId) : []

  const rfNodes = derived.nodes.map((n) => {
    const nd = graph.nodes[n.id]
    return {
      id: n.id,
      type: 'exploreNode',
      position: positions[n.id] || { x: 0, y: 0 },
      selected: n.id === focusId,
      data: {
        label: nd.l ?? n.id,
        type: typeLabel(schema, nd.t),
        // Per-node colors win over the type's, exactly as in Matrix, Karte and
        // Zeitstrahl -- one highlighted node stays highlighted everywhere.
        color: nodeColor(schema, n.id, nd.t),
        expanded: isExpanded(state, n.id),
        hidden: hiddenCounts.get(n.id) || 0,
        root: n.id === state.rootId,
      },
      // Real dimensions up front, not just style: fitView computes its bounds
      // before it can measure a custom node's DOM box, and would otherwise clip.
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      style: { width: NODE_WIDTH, height: NODE_HEIGHT },
    }
  })

  const withLabels = showEdgeLabels && derived.edges.length <= MAX_EDGE_LABELS
  const rfEdges = derived.edges.map((e) => {
    const [sourceHandle, targetHandle] = handlePair(positions[e.source], positions[e.target])
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle,
      targetHandle,
      type: 'smoothstep',
      label: withLabels ? exploreEdgeLabel(schema, e.etype) : undefined,
      labelStyle: { fill: 'var(--tx2)', fontSize: 9 },
      labelBgStyle: { fill: 'var(--bg2)', fillOpacity: 0.85 },
      style: { stroke: 'var(--bd2)', strokeWidth: 1.2 },
      markerEnd: { type: 'arrowclosed', color: 'var(--bd2)', width: 12, height: 12 },
    }
  })

  return (
    <div className={'panel' + (active ? ' on' : '')} id={domId}>
      <div className="sec-hdr">
        <h2>Graph</h2>
        <span className="badge">{fmt(derived.nodes.length)} nodes</span>
        <span className="badge">{fmt(derived.edges.length)} edges</span>
        {derived.truncated && (
          <span className="badge gx-warn" title={`The canvas holds ${fmt(MAX_VISIBLE_NODES)} nodes. Collapse branches to open further ones.`}>
            limit reached
          </span>
        )}
      </div>

      <div className="frow">
        <div className="gx-picker" ref={pickerRef}>
          <input
            className="si"
            value={query}
            placeholder="Search start node (label or ID)…"
            onFocus={() => setPickerOpen(true)}
            onChange={(e) => {
              setQuery(e.target.value)
              setPickerOpen(true)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setPickerOpen(false)
              if (e.key === 'Enter' && hits.length) setRoot(hits[0])
            }}
          />
          {pickerOpen && (
            <div className="gx-picker-panel">
              {!hits.length ? (
                <div className="gx-picker-empty">
                  {query.trim().length < 2 && !pickerType
                    ? 'At least 2 characters — or choose a type'
                    : 'No matches'}
                </div>
              ) : (
                hits.map((id) => {
                  const nd = graph.nodes[id]
                  const sub = getNodeSubline(schema, nd)
                  return (
                    <div key={id} className="gx-picker-row" onClick={() => setRoot(id)}>
                      <Dot schema={schema} type={nd.t} id={id} />
                      <span className="gx-picker-main">
                        <span className="gx-picker-label">{nd.l ?? id}</span>
                        {sub && <span className="gx-picker-sub">{sub}</span>}
                      </span>
                      <Tag schema={schema} type={nd.t} />
                    </div>
                  )
                })
              )}
            </div>
          )}
        </div>

        <select className="sl" value={pickerType} onChange={(e) => { setPickerType(e.target.value); setPickerOpen(true) }}>
          <option value="">All types</option>
          {types.map((t) => (
            <option key={t} value={t}>{typeLabel(schema, t)}</option>
          ))}
        </select>

        <button className="dash-preset" onClick={relayout} disabled={!derived.nodes.length} title="Arrange the visible part hierarchically once (nodes stay freely movable afterwards)">
          ⤢ Rearrange
        </button>
        <button className="dash-preset" onClick={() => setState(collapseAll)} disabled={!state.rootId} title="Back to the start node">
          ⊖ Collapse all
        </button>
        {/* Only while the selection made elsewhere is actually off this canvas.
            Clicking a box here selects it too (linked views), so a plain
            "differs from the root" test would leave this button standing after
            every single click, offering to fetch something already on screen. */}
        {selectedId && !visibleIds.has(selectedId) && graph.nodes[selectedId] && (
          <button className="dash-preset" onClick={() => setRoot(selectedId)} title="Make the node selected elsewhere the start node">
            ⟲ Use selection
          </button>
        )}
        <label className="gx-check" title={`Edge labels are hidden anyway from ${MAX_EDGE_LABELS} edges on — they would no longer be readable.`}>
          <input type="checkbox" checked={showEdgeLabels} onChange={(e) => setShowEdgeLabels(e.target.checked)} />
          Edge labels
        </label>
        {/* Said once, here, rather than as a title on every box: a native
            tooltip on a node would race the quick-info card that the same
            hover opens. */}
        <span className="dash-hint">Click: expand/collapse · Double-click: open in Explorer</span>
      </div>

      {focusNode && (
        <div className="gx-focus">
          <NodeColorDot schema={schema} id={focusId} type={focusNode.t} />
          <strong className="gx-focus-label">{focusNode.l ?? focusId}</strong>
          <Tag schema={schema} type={focusNode.t} />
          <button className="act-btn" onClick={() => openInExplorer(focusId)}>Open in Explorer</button>
          <span className="gx-focus-groups">
            {!focusGroups.length && <span className="gx-focus-none">no connections</span>}
            {focusGroups.map((g) => (
              <span key={g.key} className="gx-group" title={`${exploreEdgeLabel(schema, g.etype)} — ${fmt(g.shown)} of ${fmt(g.total)} drawn`}>
                <span className="gx-group-dir">{DIR_SYMBOL[g.dir]}</span>
                {exploreEdgeLabel(schema, g.etype)}
                <em>{fmt(g.shown)}/{fmt(g.total)}</em>
                {g.remaining > 0 && (
                  <>
                    <button className="gx-group-more" onClick={() => setState((s) => loadMore(s, focusId, g.key))}>
                      +{fmt(Math.min(DEFAULT_GROUP_LIMIT, g.remaining))}
                    </button>
                    {g.remaining > DEFAULT_GROUP_LIMIT && (
                      <button className="gx-group-more" title={`Open all ${fmt(g.total)}`} onClick={() => setState((s) => loadMore(s, focusId, g.key, g.remaining))}>
                        all
                      </button>
                    )}
                  </>
                )}
              </span>
            ))}
          </span>
        </div>
      )}

      <div className="gx-canvas">
        {!state.rootId ? (
          <div className="gx-start">
            <p className="gx-start-hd">Choose a start node</p>
            <p className="gx-start-sub">
              Search above — or start with one of the most connected nodes. A click on a
              node opens its neighbours, another click collapses them again.
            </p>
            <div className="gx-start-list">
              {suggestions.map((s) => {
                const nd = graph.nodes[s.id]
                return (
                  <div key={s.id} className="gx-picker-row" onClick={() => setRoot(s.id)}>
                    <Dot schema={schema} type={nd.t} id={s.id} />
                    <span className="gx-picker-main">
                      <span className="gx-picker-label">{nd.l ?? s.id}</span>
                      <span className="gx-picker-sub">{fmt(s.degree)} connections</span>
                    </span>
                    <Tag schema={schema} type={nd.t} />
                  </div>
                )
              })}
            </div>
          </div>
        ) : (
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={NODE_TYPES}
            onInit={(inst) => { rfRef.current = inst }}
            onNodesChange={onNodesChange}
            fitView
            fitViewOptions={{ padding: 0.3 }}
            minZoom={0.05}
            nodesConnectable={false}
            proOptions={{ hideAttribution: true }}
            onNodeClick={handleNodeClick}
            onNodeDoubleClick={(_, n) => openInExplorer(n.id)}
            onNodeMouseEnter={(e, n) => scheduleNodeHover(n.id, e.currentTarget)}
            onNodeMouseLeave={hideNodeHover}
            onPaneClick={() => { setPickerOpen(false); hideNodeHover() }}
          >
            <Background color="#d2dfe2" gap={16} />
            <Controls showInteractive={false} />
            <MiniMap
              pannable zoomable
              maskColor="rgba(244,248,249,0.75)"
              style={{ background: 'var(--bg3)' }}
              nodeColor={(n) => n.data?.color || '#4a5e66'}
            />
          </ReactFlow>
        )}
      </div>
    </div>
  )
}
