import { useMemo, useState } from 'react'
import { useStore } from '../../store'
import { Dot } from '../shared/TypeTag'
import { buildMapSearchIndex, findMatchedEntry } from '../../lib/geo'

const MAX_RESULTS = 20
// Real-world chains turn out longer than expected -- e.g. in a production
// dataset, a shared Material node ("Bronze / Kupfer", 533 Funds) sits a
// full 3 hops from the nearest geometry. Candidates include the geometry
// node itself (hop 0) as well as its 1-hop neighbors, so 3 hops out from
// the candidate is needed to reliably reach that kind of shared value from
// every candidate, not just the ones already closest to it.
const RADIUS = 3

/** Text search restricted to the map's candidate pool (geometry-bearing
    nodes and their one-hop neighbors, see MapTab), but matching against a
    small neighborhood around each candidate (buildMapSearchIndex) so a
    value connected via a shared node -- e.g. searching "Münze" finds the
    Funds typed as such, not just nodes whose own id/label/attrs literally
    contain that text. Picking a result selects it via the store like any
    other cross-tab selection, so the existing highlight/pan-to-selection
    logic takes over automatically. */
export function MapSearch({ graph, schema, candidateIds, onHighlightAll }) {
  const navigateTo = useStore((s) => s.navigateTo)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)

  // Expensive-ish (BFS per candidate) but computed once per dataset, not
  // per keystroke -- only candidateIds/graph identity changes trigger it.
  const searchIndex = useMemo(
    () => buildMapSearchIndex(graph, candidateIds, RADIUS),
    [graph, candidateIds]
  )

  const hits = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q.length < 2) return []
    const found = []
    // Fast pass: one precomputed blob per candidate, so a plain
    // String.includes() decides membership even for thousands of
    // candidates. The (much pricier) "which nearby entry matched" lookup
    // only runs on the handful of ids that already passed this check.
    for (const id of candidateIds) {
      if (found.length >= MAX_RESULTS) break
      const blob = searchIndex.get(id)
      if (blob && blob.includes(q)) found.push(id)
    }
    return found.map((id) => {
      const matchedEntry = findMatchedEntry(graph, id, RADIUS, q)
      return { id, matchedVia: matchedEntry && matchedEntry.id !== id ? matchedEntry.label : null }
    })
  }, [query, candidateIds, searchIndex])

  function pick(id) {
    onHighlightAll?.(null) // a single explicit pick replaces any active "highlight all"
    navigateTo(id, true)
    setQuery('')
    setOpen(false)
  }

  function highlightAll() {
    onHighlightAll?.(hits.map((h) => h.id))
    setQuery('')
    setOpen(false)
  }

  return (
    <div style={{ position: 'relative', minWidth: 220 }}>
      <input
        className="si"
        placeholder="⚑ Search the map (also via linked values)…"
        value={query}
        onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && query.trim().length >= 2 && (
        <div className="lst" style={{ position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4, maxHeight: 280, overflowY: 'auto', zIndex: 1000 }}>
          {hits.length === 0 ? (
            <div className="empty" style={{ padding: '.6rem' }}>No matches</div>
          ) : (
            <>
              <div className="li" onMouseDown={highlightAll} style={{ color: 'var(--gold)', fontWeight: 500 }}>
                &#10003; Mark all {hits.length}{hits.length >= MAX_RESULTS ? '+' : ''} matches on the map
              </div>
              {hits.map(({ id, matchedVia }) => {
                const nd = graph.nodes[id]
                return (
                  <div key={id} className="li" onMouseDown={() => pick(id)}>
                    <div className="li-top">
                      <Dot schema={schema} type={nd.t} id={id} /> <strong>{nd.l}</strong>
                    </div>
                    <span className="li-sub">
                      {matchedVia ? `Match via: ${matchedVia}` : id}
                    </span>
                  </div>
                )
              })}
            </>
          )}
        </div>
      )}
    </div>
  )
}
