import { useMemo, useState } from 'react'
import { fmt } from '../../lib/schema'
import { naturalCompare } from '../../lib/filters'

// Rows per type before the list asks for a search instead -- a survey with
// thousands of finds would otherwise put thousands of rows into the DOM.
const ROW_LIMIT = 300

const iconBtn = {
  background: 'none', border: 'none', padding: '0 2px', cursor: 'pointer',
  color: 'var(--tx3)', fontSize: '.72rem', lineHeight: 1, flexShrink: 0,
}

/**
 * The 3D tab's outliner: every node drawn in the scene, grouped by type,
 * each with its own visibility -- like Blender's eye icon, and independent
 * of the layer panel, so the scene can be coloured by one grouping and
 * thinned out by another.
 *
 * `entries`: [{ id, label, typeKey, typeLabel, color }]
 * `hidden`: Set of hidden node ids. `onChange(nextSet)` replaces it.
 * `onSelect(id)`: the row's label was clicked.
 */
export function ObjectListPanel({ entries, hidden, onChange, onSelect, selectedId }) {
  const [collapsed, setCollapsed] = useState(true)
  const [query, setQuery] = useState('')
  const [closedTypes, setClosedTypes] = useState(new Set())

  const q = query.trim().toLowerCase()
  const groups = useMemo(() => {
    const byType = new Map()
    for (const e of entries) {
      if (q && !e.label.toLowerCase().includes(q)) continue
      if (!byType.has(e.typeKey)) byType.set(e.typeKey, { key: e.typeKey, label: e.typeLabel, rows: [] })
      byType.get(e.typeKey).rows.push(e)
    }
    const out = [...byType.values()].sort((a, b) => a.label.localeCompare(b.label))
    for (const g of out) g.rows.sort((a, b) => naturalCompare(a.label, b.label))
    return out
  }, [entries, q])

  const shown = groups.flatMap((g) => g.rows)
  const setMany = (ids, hide) => {
    const next = new Set(hidden)
    for (const id of ids) (hide ? next.add(id) : next.delete(id))
    onChange(next)
  }
  const toggle = (id) => setMany([id], !hidden.has(id))
  // Blender's Shift+H: everything but this one.
  const solo = (id) => {
    const next = new Set(hidden)
    for (const e of entries) next.add(e.id)
    next.delete(id)
    onChange(next)
  }

  return (
    <div
      style={{
        position: 'absolute', top: 10, left: 10, zIndex: 1000,
        background: 'var(--bg2)', border: '1px solid var(--bd)', borderRadius: 'var(--r)',
        boxShadow: '0 2px 8px rgba(0,0,0,.15)', fontSize: '.74rem',
        width: collapsed ? 'auto' : 260, maxHeight: collapsed ? 34 : 'calc(100% - 20px)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '.4rem .5rem', cursor: 'pointer',
          borderBottom: collapsed ? 'none' : '1px solid var(--bd)', color: 'var(--tx)', fontWeight: 600, flexShrink: 0,
        }}
        onClick={() => setCollapsed((c) => !c)}
        title={collapsed ? 'Show the object list' : 'Hide the object list'}
      >
        &#9776; Objects
        {hidden.size > 0 && (
          <span style={{ fontWeight: 400, color: 'var(--tx3)' }}>&middot; {fmt(hidden.size)} hidden</span>
        )}
      </div>
      {!collapsed && (
        <>
          <div style={{ padding: '.4rem .5rem', display: 'flex', flexDirection: 'column', gap: 4, borderBottom: '1px solid var(--bd)', flexShrink: 0 }}>
            <input
              className="si"
              placeholder="Filter by name …"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ fontSize: '.72rem', padding: '3px 6px' }}
            />
            <div style={{ display: 'flex', gap: 8, color: 'var(--tx3)', fontSize: '.68rem' }}>
              <span style={{ cursor: 'pointer', textDecoration: 'underline dotted' }} onClick={() => setMany(shown.map((e) => e.id), false)}>
                show {q ? 'matches' : 'all'}
              </span>
              <span style={{ cursor: 'pointer', textDecoration: 'underline dotted' }} onClick={() => setMany(shown.map((e) => e.id), true)}>
                hide {q ? 'matches' : 'all'}
              </span>
              <span style={{ marginLeft: 'auto' }} title="With a node selected in the scene: H hides it, Shift+H hides all others, Alt+H shows everything again">
                H &middot; Shift+H &middot; Alt+H
              </span>
            </div>
          </div>
          <div style={{ overflow: 'auto', padding: '.3rem .5rem', minHeight: 0 }}>
            {!groups.length && <div style={{ color: 'var(--tx3)', padding: '4px 0' }}>Nothing matches.</div>}
            {groups.map((g) => {
              const open = q || !closedTypes.has(g.key)
              const visibleCount = g.rows.filter((e) => !hidden.has(e.id)).length
              return (
                <div key={g.key} style={{ marginBottom: 4 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0', fontWeight: 600 }}>
                    <span
                      style={{ cursor: 'pointer', width: 10, color: 'var(--tx3)' }}
                      onClick={() => setClosedTypes((prev) => {
                        const next = new Set(prev)
                        if (next.has(g.key)) next.delete(g.key)
                        else next.add(g.key)
                        return next
                      })}
                    >
                      {open ? '▾' : '▸'}
                    </span>
                    <input
                      type="checkbox"
                      checked={visibleCount === g.rows.length}
                      ref={(el) => { if (el) el.indeterminate = visibleCount > 0 && visibleCount < g.rows.length }}
                      onChange={() => setMany(g.rows.map((e) => e.id), visibleCount === g.rows.length)}
                      style={{ margin: 0, flexShrink: 0 }}
                    />
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--tx)' }}>{g.label}</span>
                    <span style={{ color: 'var(--tx3)', fontFamily: "'IBM Plex Mono', monospace", fontSize: '.66rem' }}>
                      {fmt(visibleCount)}/{fmt(g.rows.length)}
                    </span>
                  </div>
                  {open && g.rows.slice(0, ROW_LIMIT).map((e) => (
                    <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '1px 0 1px 16px', opacity: hidden.has(e.id) ? 0.5 : 1 }}>
                      <input type="checkbox" checked={!hidden.has(e.id)} onChange={() => toggle(e.id)} style={{ margin: 0, flexShrink: 0 }} />
                      <span style={{ width: 9, height: 9, borderRadius: 2, background: e.color, flexShrink: 0 }} />
                      <span
                        onClick={() => onSelect(e.id)}
                        title={e.label + ' – select'}
                        style={{
                          flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer',
                          color: e.id === selectedId ? 'var(--gold)' : 'var(--tx)', fontWeight: e.id === selectedId ? 600 : 400,
                        }}
                      >
                        {e.label}
                      </span>
                      <button style={iconBtn} onClick={() => solo(e.id)} title="Show only this one">&#9678;</button>
                    </div>
                  ))}
                  {open && g.rows.length > ROW_LIMIT && (
                    <div style={{ color: 'var(--tx3)', padding: '2px 0 2px 16px' }}>
                      &hellip; {fmt(g.rows.length - ROW_LIMIT)} more &ndash; narrow down with the filter
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
