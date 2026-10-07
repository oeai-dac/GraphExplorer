import { useStore } from '../store'
import { fmt } from '../lib/schema'

// Serialise the CURRENT display graph (already collapsed, if the user bypassed
// any types) to a Graph-JSON file. Re-loading that .json later skips the RDF
// parse and the collapse step entirely, and never carries the removed nodes --
// so it loads faster, uses less memory, and is the ideal thing to hand on.
function downloadJson(graph, collapsedCount) {
  const base = (graph.meta?.title || 'graph').replace(/\.[^.]+$/, '').replace(/[^\w\-]+/g, '_') || 'graph'
  const name = base + (collapsedCount ? '-collapsed' : '') + '.json'
  const blob = new Blob([JSON.stringify(graph)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

export function Header() {
  const graph = useStore((s) => s.graph)
  const nodeIds = useStore((s) => s.nodeIds)
  const reset = useStore((s) => s.reset)
  const collapsedTypes = useStore((s) => s.collapsedTypes)

  const nc = graph.meta?.node_count || nodeIds.length
  const ec = graph.meta?.edge_count || 0

  return (
    <header className="hdr">
      <div className="hdr-logo">&#9906;</div>
      <div className="hdr-title">
        <h1>{graph.meta?.title || 'GraphExplorer'}</h1>
        <p>{fmt(nc)} nodes · {fmt(ec)} edges</p>
      </div>
      <button
        className="reset-btn"
        title="Save the current view as graph JSON – loads much faster afterwards (no RDF parsing), ideal for sharing with colleagues"
        onClick={() => downloadJson(graph, collapsedTypes.length)}
      >&#128190; Save as JSON</button>
      <button className="reset-btn" onClick={reset}>&#8617; Load new file</button>
    </header>
  )
}
