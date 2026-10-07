import { useMemo, useState } from 'react'
import { useStore } from '../../store'
import { Dot, Tag } from '../shared/TypeTag'
import { nodeHoverProps } from '../shared/nodeHover'
import { fmt, typeLabel } from '../../lib/schema'

const MAX = 300

export function SearchTab({ active, searchInputRef, domId = 'tab-search' }) {
  const graph = useStore((s) => s.graph)
  const schema = useStore((s) => s.schema)
  const nodeIds = useStore((s) => s.nodeIds)
  const typeIndex = useStore((s) => s.typeIndex)
  const openInExplorer = useStore((s) => s.openInExplorer)

  const [query, setQuery] = useState('')
  const [scope, setScope] = useState('')

  const hits = useMemo(() => {
    if (!graph || query.trim().length < 2) return []
    const ql = query.trim().toLowerCase()
    const pool = scope ? typeIndex[scope] || [] : nodeIds
    const found = []
    for (let i = 0; i < pool.length && found.length < MAX; i++) {
      const id = pool[i]
      const nd = graph.nodes[id]
      if (id.toLowerCase().includes(ql) || nd.l.toLowerCase().includes(ql)) {
        found.push(id)
        continue
      }
      for (const k in nd.a) {
        if (String(nd.a[k]).toLowerCase().includes(ql)) {
          found.push(id)
          break
        }
      }
    }
    return found
  }, [graph, nodeIds, typeIndex, query, scope])

  if (!graph) return null

  const types = Object.keys(graph.node_types || typeIndex).sort()

  const groups = useMemo(() => {
    const g = {}
    hits.forEach((id) => {
      const t = graph.nodes[id].t
      if (!g[t]) g[t] = []
      g[t].push(id)
    })
    return Object.entries(g).sort((a, b) => b[1].length - a[1].length)
  }, [hits, graph])

  return (
    <div className={'panel' + (active ? ' on' : '')} id={domId}>
      <div className="sec-hdr">
        <h2>Full-text Search</h2>
        <span className="badge">all nodes</span>
      </div>
      <div className="frow">
        <input
          ref={searchInputRef}
          className="si"
          style={{ fontSize: '.95rem', padding: '.55rem .9rem' }}
          placeholder="⚑ Enter search term…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select className="sl" value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="">All node types</option>
          {types.map((t) => (
            <option key={t} value={t}>{typeLabel(schema, t)}</option>
          ))}
        </select>
      </div>
      <div style={{ fontSize: '.78rem', color: 'var(--tx3)', marginBottom: '.7rem', flexShrink: 0 }}>
        {query.trim().length < 2
          ? ''
          : `${hits.length}${hits.length >= MAX ? '+' : ''} results for "${query.trim()}"`}
      </div>
      <div className="lst" style={{ flex: 1, overflowY: 'auto' }}>
        {query.trim().length < 2 ? (
          <div className="empty">Enter a search term (min. 2 chars)</div>
        ) : !hits.length ? (
          <div className="empty">No results</div>
        ) : (
          groups.map(([type, ids]) => (
            <div key={type}>
              <div className="sr-group">
                <Dot schema={schema} type={type} /> {typeLabel(schema, type)}{' '}
                <span style={{ color: 'var(--tx3)', fontFamily: "'JetBrains Mono',monospace" }}>({ids.length})</span>
              </div>
              {ids.map((id) => {
                const nd = graph.nodes[id]
                return (
                  <div key={id} className="li" onClick={() => openInExplorer(id)} {...nodeHoverProps(id)}>
                    <div className="li-top">
                      <Dot schema={schema} type={nd.t} id={id} /> <strong>{nd.l}</strong>
                    </div>
                    <div className="li-meta">
                      <Tag schema={schema} type={nd.t} />
                      <span style={{ fontSize: '.66rem', color: 'var(--tx3)' }}>{id}</span>
                    </div>
                  </div>
                )
              })}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
