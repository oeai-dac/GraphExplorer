// Turns Dot-One-qualified edges (built by the OntoCartographer backend as synthetic
// "<propUri>#dot1:<canonicalValue>" keys, see backend/main.py) into a
// stratigraphic sequence graph suitable for a Harris Matrix layout.
//
// Mirrors the backend's qualifier vocabulary (_DOT_ONE_VOCAB) so the same
// über/unter/gleichzeitig/entspricht words are understood consistently on
// both sides. Unknown vocabulary is never guessed at -- it's kept visible
// as a distinctly-styled "unklare Beziehung" connector instead of being
// silently mis-ranked.

const LOWER = new Set(['unter', 'below', 'under', 'unten'])
const HIGHER = new Set(['ueber', 'above', 'over', 'oben'])
// "Same rank, no further constraint" -- contemporary units, drawn at the
// same height but with no preference for how close together they sit.
const SAME_RANK = new Set([
  'gleichzeitig', 'zeitgleich', 'same time', 'same-time', 'contemporary with',
])
// "Same rank AND as close together as the layout allows" -- these describe
// what is effectively the same context recorded under two identifiers.
const EQUALS = new Set(['entspricht', 'equals', 'same as', 'corresponds to'])

const DOT1_MARK = '#dot1:'

function classify(canonValue) {
  if (LOWER.has(canonValue)) return 'lower'
  if (HIGHER.has(canonValue)) return 'higher'
  if (SAME_RANK.has(canonValue)) return 'same-rank'
  if (EQUALS.has(canonValue)) return 'equals'
  return 'unknown'
}

/** All distinct base dot-one properties present among the given node ids. */
export function detectDotOneProperties(graph, nodeIds) {
  const props = new Set()
  for (const id of nodeIds) {
    const nd = graph.nodes[id]
    if (!nd) continue
    for (const key of Object.keys(nd.o || {})) {
      const idx = key.indexOf(DOT1_MARK)
      if (idx >= 0) props.add(key.slice(0, idx))
    }
  }
  return [...props].sort()
}

/** True if the graph has ANY dot-one edges at all (used to show/hide the Matrix tab).
    Checks the cheap schema/edge_types maps first, then falls back to scanning
    node adjacency so schema-less graphs (Doc 4.3 backward-compat) still expose
    the Matrix tab when they genuinely contain dot-one edges -- previously the
    gate looked only at schema.edgeLabels and hid the tab for such graphs even
    though detectDotOneProperties()/buildSequence() would have worked. */
export function hasDotOneData(graph) {
  if (!graph) return false
  const labels = graph.schema?.edgeLabels
  if (labels && Object.keys(labels).some((k) => k.includes(DOT1_MARK))) return true
  const etypes = graph.edge_types
  if (etypes && Object.keys(etypes).some((k) => k.includes(DOT1_MARK))) return true
  for (const nd of Object.values(graph.nodes || {})) {
    for (const k of Object.keys(nd.o || {})) if (k.includes(DOT1_MARK)) return true
    for (const k of Object.keys(nd.i || {})) if (k.includes(DOT1_MARK)) return true
  }
  return false
}

/**
 * Build a stratigraphic sequence for `baseProp` among `nodeIds`.
 *
 * Returns (all deduplicated -- the same fact can appear on both ends after
 * the backend's o/i merge, e.g. "A unter B" and "B über A" resolve to the
 * identical pair here, drawn once):
 *   rankEdges     - directed { source, target }, source = physically lower
 *                    / earlier, target = physically higher / later
 *   sameRankEdges - undirected { source, target } (zeitgleich/gleichzeitig):
 *                    must render at the same height, no closeness preference
 *   equalsEdges   - undirected { source, target } (entspricht/equals): must
 *                    render at the same height AND as close together as
 *                    possible
 *   unknownEdges  - undirected { source, target } with unrecognised
 *                    qualifier vocabulary (shown, but not used for ranking)
 */
export function buildSequence(graph, nodeIds, baseProp) {
  const idSet = new Set(nodeIds)
  const rankPairs = new Map()   // "lo|hi" -> {source, target}
  const buckets = { 'same-rank': new Map(), equals: new Map(), unknown: new Map() }

  const addUndirected = (bucket, a, b) => {
    const [x, y] = a < b ? [a, b] : [b, a]
    bucket.set(`${x}|${y}`, { source: x, target: y })
  }

  for (const id of nodeIds) {
    const nd = graph.nodes[id]
    if (!nd) continue
    for (const [key, targets] of Object.entries(nd.o || {})) {
      const idx = key.indexOf(DOT1_MARK)
      if (idx < 0 || key.slice(0, idx) !== baseProp) continue
      const value = key.slice(idx + DOT1_MARK.length)
      const cls = classify(value)
      for (const tgt of targets) {
        if (!idSet.has(tgt) || tgt === id) continue
        if (cls === 'lower') {
          rankPairs.set(`${id}|${tgt}`, { source: id, target: tgt })
        } else if (cls === 'higher') {
          rankPairs.set(`${tgt}|${id}`, { source: tgt, target: id })
        } else {
          addUndirected(buckets[cls], id, tgt)
        }
      }
    }
  }

  return {
    rankEdges: [...rankPairs.values()],
    sameRankEdges: [...buckets['same-rank'].values()],
    equalsEdges: [...buckets.equals.values()],
    unknownEdges: [...buckets.unknown.values()],
  }
}
