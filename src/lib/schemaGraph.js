import { typeLabel, typeColor } from './schema'

/** Aggregates instance-level edges into a schema-level "type graph": one
    node per node TYPE, one edge per (sourceType, targetType) pair actually
    observed among instances -- a structural summary of how the data model
    hangs together, derived from the loaded data itself, not a separate
    ontology file.

    Only walks each node's OUTGOING (`o`) edges -- `i` is just the
    auto-derived inverse view of the same relations (see backend/main.py's
    two-pass o/i dedup), so counting both would double every relation.

    Two type-pairs connected by several different properties still collapse
    into ONE graph edge (with all property keys kept in `props`) rather than
    rendering overlapping parallel edges between the same two type nodes. */
export function buildTypeGraph(graph, schema) {
  const nodeTypes = Object.keys(graph.node_types || {})
  const nodes = nodeTypes.map((t) => ({
    id: t,
    label: typeLabel(schema, t) || t,
    color: typeColor(schema, t),
    count: graph.node_types[t] || 0,
  }))

  const edgeMap = new Map() // "srcType|tgtType" -> { source, target, props: Set, count }
  for (const nd of Object.values(graph.nodes || {})) {
    const srcType = nd.t
    if (!srcType) continue
    for (const [propKey, targets] of Object.entries(nd.o || {})) {
      for (const tid of targets) {
        const tgtType = graph.nodes[tid]?.t
        if (!tgtType) continue
        const key = srcType + '|' + tgtType
        if (!edgeMap.has(key)) edgeMap.set(key, { source: srcType, target: tgtType, props: new Set(), count: 0 })
        const e = edgeMap.get(key)
        e.props.add(propKey)
        e.count++
      }
    }
  }

  const edges = [...edgeMap.entries()].map(([key, e]) => ({
    id: key,
    source: e.source,
    target: e.target,
    props: [...e.props],
    count: e.count,
  }))

  return { nodes, edges }
}
