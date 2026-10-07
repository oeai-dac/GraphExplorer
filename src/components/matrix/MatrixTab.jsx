import { useEffect, useMemo, useState } from 'react'
import ReactFlow, { Background, Controls, MiniMap } from 'reactflow'
import 'reactflow/dist/style.css'
import { useStore } from '../../store'
import { hideNodeHover, scheduleNodeHover } from '../shared/nodeHover'
import { nodeColor, nodeColorOverride, typeLabel, fmt } from '../../lib/schema'
import { detectDotOneProperties, buildSequence } from '../../lib/harrisMatrix'
import {
  assignCategoryColors,
  conditionForCategory,
  dimForProperty,
  groupAndCount,
  listChartProperties,
  NO_VALUE,
} from '../../lib/chartData'
import { layoutHarrisMatrix } from '../../lib/dagreLayout'
import { MatrixNode } from './MatrixNode'

const NODE_TYPES = { matrixNode: MatrixNode }

const EDGE_TYPE = 'step' // angular/right-angle routing, no curves

const RANK_EDGE_STYLE = { stroke: 'var(--gold)', strokeWidth: 1.4 }
const SAME_RANK_EDGE_STYLE = { stroke: 'var(--tx2)', strokeWidth: 1.2, strokeDasharray: '5 4' }
const EQUALS_EDGE_STYLE = { stroke: '#32A88B', strokeWidth: 1.4, strokeDasharray: '1 3' }
const UNKNOWN_EDGE_STYLE = { stroke: '#c94052', strokeWidth: 1.2, strokeDasharray: '2 3' }

function propLocalName(uri) {
  return uri.split('#').pop().split('/').pop().replace(/_/g, ' ')
}

// Rank edges always connect source's TOP (source = physically lower) to
// target's BOTTOM (target = physically higher) -- the two box edges that
// actually face each other across the gap between adjacent ranks, instead
// of routing the long way around both boxes.
//
// Drawn as plain lines, the way a Harris matrix is drawn on paper: the
// direction is already in the layout (lower/older sinks to the bottom), so
// an arrowhead on every single edge only adds ink.
function rankEdgeToRf(e, i) {
  return {
    id: `r${i}`, source: e.source, target: e.target,
    sourceHandle: 'top', targetHandle: 'bottom',
    type: EDGE_TYPE, style: RANK_EDGE_STYLE,
  }
}

// Same-rank/equals edges are horizontal: connect the RIGHT handle of
// whichever node ends up positioned further left to the LEFT handle of
// whichever ends up further right, so the line runs straight through the
// gap between the two boxes instead of dipping via top/bottom handles.
function horizontalEdgeToRf(e, i, idPrefix, style, positions) {
  const pa = positions[e.source]
  const pb = positions[e.target]
  const [leftId, rightId] = (pa?.x ?? 0) <= (pb?.x ?? 0) ? [e.source, e.target] : [e.target, e.source]
  return {
    id: `${idPrefix}${i}`, source: leftId, target: rightId,
    sourceHandle: 'right', targetHandle: 'left',
    type: EDGE_TYPE, style,
  }
}

export function MatrixTab({ active, domId = 'tab-matrix' }) {
  const graph = useStore((s) => s.graph)
  const schema = useStore((s) => s.schema)
  const nodeIds = useStore((s) => s.nodeIds)
  const typeIndex = useStore((s) => s.typeIndex)
  const explorerType = useStore((s) => s.explorerType)
  const setExplorerType = useStore((s) => s.setExplorerType)
  const openInExplorer = useStore((s) => s.openInExplorer)
  const openExplorerWithFilter = useStore((s) => s.openExplorerWithFilter)
  const selectedId = useStore((s) => s.selectedId)

  const [selectedProp, setSelectedProp] = useState('')
  // Which property the boxes are colored by ('' = the node type's own color).
  // Local, like the dot-one property above: two Dashboard panes may well want
  // to look at the same matrix through two different lenses.
  const [colorPropId, setColorPropId] = useState('')

  // Only list types that can actually produce a Harris Matrix (i.e. carry
  // Dot-One relations among their own instances) -- picking e.g. a Material
  // type would always land on the "keine Dot-One-Relationen" empty state.
  const types = useMemo(
    () => Object.keys(graph?.node_types || typeIndex || {})
      .filter((t) => detectDotOneProperties(graph, typeIndex[t] || []).length > 0)
      .sort(),
    [graph, typeIndex]
  )

  // Suggest the type with the most dot-one relations as a starting point,
  // but only while nothing is picked yet -- once the user (or the Explorer
  // tab) sets a type, that choice always wins.
  const suggestedType = useMemo(() => {
    if (!graph) return ''
    let best = ''
    let bestCount = 0
    for (const t of types) {
      const ids = typeIndex[t] || []
      const props = detectDotOneProperties(graph, ids)
      if (props.length && ids.length > bestCount) {
        best = t
        bestCount = ids.length
      }
    }
    return best
  }, [graph, types, typeIndex])

  useEffect(() => {
    if (!explorerType && suggestedType) setExplorerType(suggestedType)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestedType])

  // The type is shared with the Explorer's type filter. A type without
  // Dot-One relations (e.g. the Explorer narrowed to finds) has no matrix,
  // so fall back to the suggestion instead of showing an empty canvas.
  const activeType = types.includes(explorerType) ? explorerType : suggestedType
  const typeNodeIds = activeType ? (typeIndex[activeType] || []) : []

  const dotOneProps = useMemo(
    () => (graph ? detectDotOneProperties(graph, typeNodeIds) : []),
    [graph, typeNodeIds]
  )
  const activeProp = dotOneProps.includes(selectedProp) ? selectedProp : dotOneProps[0] || ''

  const { rankEdges, sameRankEdges, equalsEdges, unknownEdges } = useMemo(() => {
    if (!graph || !activeProp) return { rankEdges: [], sameRankEdges: [], equalsEdges: [], unknownEdges: [] }
    return buildSequence(graph, typeNodeIds, activeProp)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, typeNodeIds, activeProp])

  const { positions, width, height } = useMemo(
    () => layoutHarrisMatrix(typeNodeIds, rankEdges, sameRankEdges, equalsEdges),
    [typeNodeIds, rankEdges, sameRankEdges, equalsEdges]
  )

  // What the boxes can be colored by: every property these units actually
  // carry -- connections ("Hat die Interpretation") and literal attributes
  // alike, the same list the Diagramme tab groups by.
  const colorProps = useMemo(
    () => (graph ? listChartProperties(graph, typeNodeIds, schema) : []),
    [graph, typeNodeIds, schema]
  )
  const colorProp = colorProps.find((p) => p.id === colorPropId) || null
  const colorDim = useMemo(() => dimForProperty(colorProp, ''), [colorProp])

  const categories = useMemo(() => {
    if (!graph || !colorDim || !typeNodeIds.length) return null
    // 'count' order is what makes the color assignment meaningful: the biggest
    // groups get the palette, and a unit with two values takes the color of
    // its bigger one (see assignCategoryColors).
    return assignCategoryColors(groupAndCount(graph, typeNodeIds, colorDim, { sort: 'count' }))
  }, [graph, typeNodeIds, colorDim])

  if (!graph) return null

  const rfNodes = typeNodeIds.map((id) => {
    const nd = graph.nodes[id]
    const pos = positions[id] || { x: 0, y: 0 }
    // A color given to this one node still wins -- it says "this specific unit
    // matters", which no category rule should overrule.
    const color = categories
      ? nodeColorOverride(schema, id) || categories.colorOf(id)
      : nodeColor(schema, id, nd?.t)
    return {
      id,
      type: 'matrixNode',
      position: pos,
      selected: id === selectedId,
      data: { label: nd?.l ?? id, color },
      style: { width, height },
    }
  })

  // The tail the palette couldn't cover, plus the units without a value,
  // folded into one entry -- listing 300 grey categories individually would
  // bury the ones that are actually distinguishable.
  const namedCategories = categories?.legend.filter((c) => !c.plain) || []
  const plainCategories = categories?.legend.filter((c) => c.plain) || []

  // Same move as a bar click in the Diagramme tab: the category re-expressed
  // as an Explorer filter, so "which units are these?" is one click away.
  function openCategory(cat) {
    const cond = conditionForCategory(graph, colorDim, cat.label, cat.ids)
    if (cond) openExplorerWithFilter(activeType, [cond])
  }

  const rfEdges = [
    ...rankEdges.map((e, i) => rankEdgeToRf(e, i)),
    ...sameRankEdges.map((e, i) => horizontalEdgeToRf(e, i, 's', SAME_RANK_EDGE_STYLE, positions)),
    ...equalsEdges.map((e, i) => horizontalEdgeToRf(e, i, 'eq', EQUALS_EDGE_STYLE, positions)),
    ...unknownEdges.map((e, i) => horizontalEdgeToRf(e, i, 'u', UNKNOWN_EDGE_STYLE, positions)),
  ]

  return (
    <div className={'panel' + (active ? ' on' : '')} id={domId}>
      <div className="sec-hdr">
        <h2>Harris Matrix</h2>
        <span className="badge">{fmt(typeNodeIds.length)} units</span>
      </div>

      <div className="frow">
        <select className="sl" value={activeType} onChange={(e) => setExplorerType(e.target.value)}>
          <option value="">Choose type…</option>
          {types.map((t) => (
            <option key={t} value={t}>{typeLabel(schema, t)}</option>
          ))}
        </select>
        {dotOneProps.length > 1 && (
          <select className="sl" value={activeProp} onChange={(e) => setSelectedProp(e.target.value)}>
            {dotOneProps.map((p) => (
              <option key={p} value={p}>{propLocalName(p)}</option>
            ))}
          </select>
        )}
        {colorProps.length > 0 && (
          <select
            className="sl"
            // Falls back to "Typfarbe" when the picked property doesn't exist
            // for the newly chosen type -- an unmatched value would leave the
            // dropdown showing nothing at all.
            value={colorProp ? colorPropId : ''}
            title="Colour the boxes by the value of a property. The number in brackets tells how many units have a value for this property."
            onChange={(e) => setColorPropId(e.target.value)}
          >
            <option value="">Colour by: type colour</option>
            {colorProps.map((p) => (
              <option key={p.id} value={p.id}>Colour by: {p.label} ({fmt(p.coverage)})</option>
            ))}
          </select>
        )}
        <span style={{ fontSize: '.7rem', color: 'var(--tx3)', display: 'flex', alignItems: 'center', gap: '.9rem', marginLeft: '.4rem' }}>
          <span><span style={{ display: 'inline-block', width: 14, height: 2, background: 'var(--gold)', marginRight: 4, verticalAlign: 'middle' }} />above/below</span>
          <span><span style={{ display: 'inline-block', width: 14, height: 0, borderTop: '2px dashed var(--tx2)', marginRight: 4, verticalAlign: 'middle' }} />contemporary (same level)</span>
          <span><span style={{ display: 'inline-block', width: 14, height: 0, borderTop: '2px dotted #32A88B', marginRight: 4, verticalAlign: 'middle' }} />equals (same level + close)</span>
          {unknownEdges.length > 0 && (
            <span><span style={{ display: 'inline-block', width: 14, height: 0, borderTop: '2px dashed #c94052', marginRight: 4, verticalAlign: 'middle' }} />unknown value</span>
          )}
        </span>
      </div>

      {categories && (
        <div className="mx-legend">
          <span className="mx-leg-lbl">{colorProp.label}:</span>
          {namedCategories.map((c) => (
            <span
              key={c.label}
              className="mx-leg-item"
              title={`${fmt(c.count)} units — open in Explorer`}
              onClick={() => openCategory(c)}
            >
              <span className="tl-leg-dot" style={{ background: c.color }} />
              {c.label} <em>{fmt(c.count)}</em>
            </span>
          ))}
          {plainCategories.length > 0 && (
            <span
              className="mx-leg-item plain"
              title={
                plainCategories.length === 1 && plainCategories[0].label === NO_VALUE
                  ? 'Units without a value'
                  : `Without a value, and ${fmt(plainCategories.length)} more values too rare for a colour of their own`
              }
            >
              <span className="tl-leg-dot" style={{ background: plainCategories[0].color }} />
              {plainCategories.length === 1 ? plainCategories[0].label : 'other'} <em>{fmt(categories.plainCount)}</em>
            </span>
          )}
        </div>
      )}
      {/* Outside the legend box, which scrolls once there are many values --
          a hint that can scroll out of sight is no hint. Same honesty as the
          Diagramme tab: a property with one value per unit can't produce a
          readable coloring, and saying so beats leaving people to wonder. */}
      {categories && colorProp.poorGrouping && (
        <div className="cat-note">
          “{colorProp.label}” has a value of its own for almost every unit — only the most frequent get a colour.
        </div>
      )}

      <div style={{ flex: 1, border: '1px solid var(--bd)', borderRadius: 'var(--r)', overflow: 'hidden', background: 'var(--bg2)' }}>
        {!activeType ? (
          <div className="det-empty">Please choose a node type with Dot-One relations</div>
        ) : !activeProp ? (
          <div className="det-empty">No Dot-One relations were found for this type</div>
        ) : (
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={NODE_TYPES}
            fitView
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={true}
            proOptions={{ hideAttribution: true }}
            onNodeClick={(_, n) => openInExplorer(n.id)}
            // The boxes only carry a label; hovering one reveals what that
            // stratigraphic unit actually holds without leaving the matrix.
            onNodeMouseEnter={(e, n) => scheduleNodeHover(n.id, e.currentTarget)}
            onNodeMouseLeave={hideNodeHover}
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
