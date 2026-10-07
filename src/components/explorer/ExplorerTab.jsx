import { useMemo, useState } from 'react'
import { useStore } from '../../store'
import { fmt, typeLabel } from '../../lib/schema'
import { applyConditions } from '../../lib/filters'
import { Breadcrumbs } from './Breadcrumbs'
import { NodeList } from './NodeList'
import { NodeDetail } from './NodeDetail'
import { FilterBuilder } from '../shared/FilterBuilder'

export function ExplorerTab({ active, domId = 'tab-explore' }) {
  const graph = useStore((s) => s.graph)
  const schema = useStore((s) => s.schema)
  const nodeIds = useStore((s) => s.nodeIds)
  const typeIndex = useStore((s) => s.typeIndex)
  const query = useStore((s) => s.explorerQuery)
  const typeFilter = useStore((s) => s.explorerType)
  const conditions = useStore((s) => s.explorerConditions)
  const page = useStore((s) => s.explorerPage)
  const trail = useStore((s) => s.trail)
  const selectedId = useStore((s) => s.selectedId)
  const setExplorerQuery = useStore((s) => s.setExplorerQuery)
  const setExplorerType = useStore((s) => s.setExplorerType)
  const setExplorerConditions = useStore((s) => s.setExplorerConditions)
  const setExplorerPage = useStore((s) => s.setExplorerPage)
  const navigateTo = useStore((s) => s.navigateTo)
  const navigateBack = useStore((s) => s.navigateBack)
  const navigateToTrailIndex = useStore((s) => s.navigateToTrailIndex)

  // Stays open once toggled, and also whenever conditions arrive from
  // elsewhere (e.g. a Charts tab bar click) even if the user never
  // explicitly opened it on this visit.
  const [filtersToggled, setFiltersToggled] = useState(false)
  const showFilters = filtersToggled || conditions.length > 0

  const typePool = useMemo(() => (typeFilter ? typeIndex[typeFilter] || [] : nodeIds), [typeFilter, typeIndex, nodeIds])

  const filtered = useMemo(() => {
    if (!graph) return []
    const q = query.toLowerCase().trim()
    let pool = typePool
    if (q.length >= 2) {
      pool = pool.filter((id) => {
        const nd = graph.nodes[id]
        if (id.toLowerCase().includes(q) || nd.l.toLowerCase().includes(q)) return true
        for (const k in nd.a) {
          if (String(nd.a[k]).toLowerCase().includes(q)) return true
        }
        return false
      })
    }
    return applyConditions(graph, pool, conditions)
  }, [graph, typePool, query, conditions])

  if (!graph) return null

  const types = Object.keys(graph.node_types || typeIndex).sort()
  const countFor = (t) => (graph.node_types ? graph.node_types[t] : typeIndex[t]?.length || 0)

  return (
    <div className={'panel' + (active ? ' on' : '')} id={domId}>
      <div className="sec-hdr">
        <h2>Explorer</h2>
        <span className="badge">{fmt(filtered.length)} nodes</span>
      </div>

      <Breadcrumbs
        schema={schema}
        trail={trail}
        onBack={navigateBack}
        onSelect={navigateToTrailIndex}
      />

      <div className="frow">
        <input
          className="si"
          placeholder="⚑ Search ID, label, attribute…"
          value={query}
          onChange={(e) => setExplorerQuery(e.target.value)}
        />
        <span className="copy-btn" onClick={() => setFiltersToggled((s) => !s)}>
          &#9881; {showFilters ? 'Hide filters' : 'Advanced filters'}
          {conditions.length > 0 ? ` (${conditions.length})` : ''}
        </span>
      </div>

      {showFilters && (
        <FilterBuilder graph={graph} schema={schema} poolIds={typePool} conditions={conditions} onChange={setExplorerConditions} />
      )}

      <div className="ld">
        {/* The type filter sits directly on top of the list it narrows down --
            in the toolbar next to the search field it read as a third, unrelated
            control and it wasn't obvious that it steers the left column. */}
        <div className="ld-list">
          <select className="sl ld-typesel" value={typeFilter} onChange={(e) => setExplorerType(e.target.value)}>
            <option value="">All node types</option>
            {types.map((t) => (
              <option key={t} value={t}>
                {typeLabel(schema, t)} ({fmt(countFor(t))})
              </option>
            ))}
          </select>
          <NodeList
            graph={graph}
            schema={schema}
            ids={filtered}
            page={page}
            onPageChange={setExplorerPage}
            selectedId={selectedId}
            onSelect={(id) => navigateTo(id, true)}
          />
        </div>
        <div className="det">
          <NodeDetail
            graph={graph}
            schema={schema}
            nodeId={selectedId}
            onNavigate={(id) => navigateTo(id, true)}
          />
        </div>
      </div>
    </div>
  )
}
