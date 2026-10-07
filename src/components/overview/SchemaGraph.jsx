import { useMemo } from 'react'
import ReactFlow, { Background, Controls, Handle, Position } from 'reactflow'
import 'reactflow/dist/style.css'
import dagre from 'dagre'
import { useStore } from '../../store'
import { edgeLabel, fmt } from '../../lib/schema'
import { Dot } from '../shared/TypeTag'
import { buildTypeGraph } from '../../lib/schemaGraph'

const NODE_WIDTH = 150
const NODE_HEIGHT = 96

// Same visual as the Overview's old stat cards (.stcard/.stcard-val/
// .stcard-lbl, plus the colored Dot) -- the graph replaced the cards'
// LAYOUT (a flat list -> a relationship diagram) but the cards' actual
// look was already good and is reused here as-is, including its hover/
// clickable affordance, instead of inventing a new node style.
// A custom node type (unlike ReactFlow's default) has to declare its own
// Handles explicitly, or edges have nowhere to attach -- matches the
// pattern already used for the Harris Matrix's MatrixNode.
function StatCardNode({ data }) {
  return (
    <div className="stcard clickable" style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', cursor: 'pointer' }}>
      <Handle type="target" position={Position.Left} style={{ visibility: 'hidden' }} />
      <div style={{ marginBottom: '.3rem' }}>
        <Dot schema={data.schema} type={data.typeId} />
      </div>
      <div className="stcard-val" style={{ fontSize: '1.5rem' }}>{fmt(data.count)}</div>
      <div className="stcard-lbl" style={{ whiteSpace: 'normal', lineHeight: 1.3 }}>{data.label}</div>
      <Handle type="source" position={Position.Right} style={{ visibility: 'hidden' }} />
    </div>
  )
}

const NODE_TYPES = { statCard: StatCardNode }

// Plain layered layout, distinct from lib/dagreLayout.js's layoutHarrisMatrix
// -- that one is specialized über/unter/zeitgleich/entspricht rank-clustering
// logic that doesn't apply to a generic type-relationship graph.
function layoutTypeGraph(nodes, edges) {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'LR', nodesep: 24, ranksep: 90, marginx: 10, marginy: 10 })
  g.setDefaultEdgeLabel(() => ({}))
  nodes.forEach((n) => g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT }))
  // Self-loops (a type relating to itself, e.g. SE über/unter SE) confuse a
  // layered layout -- excluded from the layout pass, still rendered below.
  edges.forEach((e) => { if (e.source !== e.target) g.setEdge(e.source, e.target) })
  dagre.layout(g)
  const positions = {}
  nodes.forEach((n) => {
    const gn = g.node(n.id)
    positions[n.id] = gn ? { x: gn.x - NODE_WIDTH / 2, y: gn.y - NODE_HEIGHT / 2 } : { x: 0, y: 0 }
  })
  return positions
}

/** Compact, read-only "at a glance" diagram of how the data's node TYPES
    relate to each other -- structural context meant to make Explorer
    navigation more intuitive, distinct from the Charts tab's per-instance
    analysis and the Explorer's per-node detail. See lib/schemaGraph.js. */
export function SchemaGraph({ graph, schema }) {
  const openExplorerFiltered = useStore((s) => s.openExplorerFiltered)

  const { nodes, edges } = useMemo(() => buildTypeGraph(graph, schema), [graph, schema])
  const positions = useMemo(() => layoutTypeGraph(nodes, edges), [nodes, edges])

  const rfNodes = nodes.map((n) => ({
    id: n.id,
    type: 'statCard',
    position: positions[n.id],
    data: { label: n.label, count: n.count, typeId: n.id, schema },
    // Explicit width/height (not just style) so ReactFlow has real
    // dimensions for fitView's bounds calculation on the very first
    // render, before it gets a chance to measure the actual DOM node --
    // without these, custom node types can make fitView compute bounds
    // from incomplete/zero sizes and clip some nodes out of view.
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
    style: { width: NODE_WIDTH, height: NODE_HEIGHT },
  }))

  const rfEdges = edges.map((e) => {
    const primary = edgeLabel(schema, e.props[0])
    const label = e.props.length > 1 ? `${primary} +${e.props.length - 1}` : primary
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      type: 'smoothstep',
      label,
      labelStyle: { fill: 'var(--tx2)', fontSize: 9 },
      labelBgStyle: { fill: 'var(--bg2)', fillOpacity: 0.85 },
      style: { stroke: 'var(--bd2)', strokeWidth: 1.2 },
      markerEnd: { type: 'arrowclosed', color: 'var(--bd2)', width: 12, height: 12 },
    }
  })

  if (!nodes.length) return null

  return (
    <div style={{ height: 520, flexShrink: 0, border: '1px solid var(--bd)', borderRadius: 'var(--r2)', overflow: 'hidden', marginBottom: '1.3rem', background: 'var(--bg3)' }}>
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={NODE_TYPES}
        fitView
        fitViewOptions={{ padding: 0.25 }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, n) => openExplorerFiltered(n.id)}
      >
        <Background color="#d2dfe2" gap={16} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  )
}
