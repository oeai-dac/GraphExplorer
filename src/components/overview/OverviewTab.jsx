import { useMemo } from 'react'
import { useStore } from '../../store'
import { Dot, ColorDot } from '../shared/TypeTag'
import { nodeHoverProps } from '../shared/nodeHover'
import { fmt, typeColor, nodeColor, typeLabel, edgeLabel } from '../../lib/schema'
import { SchemaGraph } from './SchemaGraph'

// domId defaults to the classic tab's element id; a Dashboard pane passes
// null so the two copies that are mounted at once don't share one id.
export function OverviewTab({ active, domId = 'tab-overview' }) {
  const graph = useStore((s) => s.graph)
  const schema = useStore((s) => s.schema)
  const prefs = useStore((s) => s.prefs)
  const nodeIds = useStore((s) => s.nodeIds)
  const typeIndex = useStore((s) => s.typeIndex)
  const openExplorerFiltered = useStore((s) => s.openExplorerFiltered)
  const openInExplorer = useStore((s) => s.openInExplorer)
  const collapsedTypes = useStore((s) => s.collapsedTypes)
  const baseGraph = useStore((s) => s.baseGraph)
  const toggleCollapseType = useStore((s) => s.toggleCollapseType)
  const resetNodeColor = useStore((s) => s.resetNodeColor)

  const collapsedLabel = (t) =>
    baseGraph?.schema?.typeLabels?.[t] || t.split(/[#/]/).pop()

  const ntEntries = useMemo(() => {
    if (!graph) return []
    return Object.entries(graph.node_types || typeIndex).sort((a, b) => b[1] - a[1])
  }, [graph, typeIndex])

  const etEntries = useMemo(() => {
    if (!graph) return []
    return Object.entries(graph.edge_types || {}).sort((a, b) => b[1] - a[1])
  }, [graph])

  // Colors the user gave to single nodes. Listed here because that is set far
  // away (on the node itself, in der Detailansicht) -- without this the only
  // way back to an override would be to find that node again. Overrides for
  // ids the current graph doesn't have stay saved but aren't shown.
  const nodeColorEntries = useMemo(() => {
    if (!graph) return []
    return Object.entries(prefs.nodeColors || {})
      .filter(([id]) => graph.nodes[id])
      .map(([id, color]) => ({ id, color, label: graph.nodes[id].l || id }))
  }, [graph, prefs.nodeColors])

  const topNodes = useMemo(() => {
    if (!graph) return []
    return nodeIds
      .map((id) => {
        const nd = graph.nodes[id]
        const outDeg = Object.values(nd.o || {}).reduce((s, a) => s + a.length, 0)
        const inDeg = Object.values(nd.i || {}).reduce((s, a) => s + a.length, 0)
        return { id, nd, deg: outDeg + inDeg }
      })
      .sort((a, b) => b.deg - a.deg)
      .slice(0, 15)
  }, [graph, nodeIds])

  if (!graph) return null

  const nc = graph.meta?.node_count || nodeIds.length
  const ec = graph.meta?.edge_count || 0
  const maxN = Math.max(...ntEntries.map((e) => e[1]), 1)
  const maxE = Math.max(...etEntries.map((e) => e[1]), 1)
  const maxDeg = topNodes[0]?.deg || 1

  return (
    <div className={'panel panel-overview' + (active ? ' on' : '')} id={domId}>
      <div className="sec-hdr">
        <h2>Graph Overview</h2>
        <span className="badge">{fmt(nc)} nodes · {fmt(ec)} edges</span>
      </div>

      <SchemaGraph graph={graph} schema={schema} />

      <div className="ovgrid">
        <div className="infocard">
          <h3>Node Types <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>&middot; dot = type colour · ⤺ = collapse type · single nodes: detail view</span></h3>
          {collapsedTypes.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', margin: '4px 0 10px' }}>
              <span style={{ fontSize: '0.8em', color: 'var(--tx2)' }}>Collapsed:</span>
              {collapsedTypes.map((t) => (
                <button
                  key={t}
                  title="Show again"
                  onClick={() => toggleCollapseType(t)}
                  style={{ fontSize: '0.8em', padding: '2px 8px', borderRadius: 12, cursor: 'pointer',
                           border: '1px solid var(--gold, #c8a24a)', background: 'transparent', color: 'inherit' }}
                >
                  {collapsedLabel(t)} ✕
                </button>
              ))}
            </div>
          )}
          {nodeColorEntries.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', margin: '4px 0 10px' }}>
              <span style={{ fontSize: '0.8em', color: 'var(--tx2)' }}>Custom node colours:</span>
              {nodeColorEntries.map(({ id, color, label }) => (
                <span
                  key={id}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.8em',
                           padding: '2px 8px', borderRadius: 12, border: '1px solid var(--bd2)' }}
                >
                  <span className="dot" style={{ background: color }} />
                  <span style={{ cursor: 'pointer' }} title="Open in Explorer" onClick={() => openInExplorer(id)}>{label}</span>
                  <button
                    title="Use the node type colour again"
                    onClick={() => resetNodeColor(id)}
                    style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'inherit', padding: 0, lineHeight: 1 }}
                  >✕</button>
                </span>
              ))}
            </div>
          )}
          <div className="blist">
            {ntEntries.map(([t, c]) => {
              const pct = ((c / maxN) * 100).toFixed(1)
              return (
                <div key={t} className="brow clickable" onClick={() => openExplorerFiltered(t)}>
                  <span className="blbl">
                    <ColorDot schema={schema} type={t} hasOverride={!!prefs.typeColors[t]} /> {typeLabel(schema, t)}
                    <button
                      title="Collapse this node type: skip its nodes, connect their neighbours directly and pass their attributes (e.g. a date) on to the neighbours"
                      onClick={(e) => { e.stopPropagation(); toggleCollapseType(t) }}
                      style={{ marginLeft: 6, border: 'none', background: 'transparent', cursor: 'pointer',
                               opacity: 0.55, fontSize: '0.95em', lineHeight: 1, padding: '0 2px' }}
                    >⤺</button>
                  </span>
                  <div className="btrk">
                    <div className="bfill" style={{ width: pct + '%', background: typeColor(schema, t) }} />
                  </div>
                  <span className="bcnt">{fmt(c)}</span>
                </div>
              )
            })}
          </div>
        </div>

        {etEntries.length > 0 && (
          <div className="infocard">
            <h3>Edge Types</h3>
            <div className="blist">
              {etEntries.map(([t, c]) => {
                const pct = ((c / maxE) * 100).toFixed(1)
                return (
                  <div key={t} className="brow">
                    <span className="blbl" style={{ color: 'var(--tx2)' }}>{edgeLabel(schema, t)}</span>
                    <div className="btrk">
                      <div className="bfill" style={{ width: pct + '%', background: 'var(--gold)' }} />
                    </div>
                    <span className="bcnt">{fmt(c)}</span>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {topNodes.length > 0 && (
          <div className="infocard">
            <h3>Most Connected Nodes</h3>
            <div className="blist">
              {topNodes.map(({ id, nd, deg }) => {
                const pct = ((deg / maxDeg) * 100).toFixed(1)
                return (
                  <div key={id} className="brow clickable" onClick={() => openInExplorer(id)} {...nodeHoverProps(id)}>
                    <span className="blbl">
                      <Dot schema={schema} type={nd.t} id={id} /> {nd.l}
                    </span>
                    <div className="btrk">
                      <div className="bfill" style={{ width: pct + '%', background: nodeColor(schema, id, nd.t) }} />
                    </div>
                    <span className="bcnt">{fmt(deg)}</span>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
