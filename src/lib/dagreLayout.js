import dagre from 'dagre'

const NODE_WIDTH = 130
const NODE_HEIGHT = 36
const CLUSTER_GAP = 10

/**
 * Layered (Sugiyama-style) layout for the Harris Matrix, enforcing:
 *
 *   1. rankEdges are already deduplicated by buildSequence() -- each real
 *      relation is drawn exactly once regardless of which side ("über" or
 *      "unter") it was recorded from.
 *   2. rankEdges are directed "physically lower -> physically higher".
 *      With rankdir 'BT', dagre places edge sources below their targets,
 *      so earlier/lower units sink towards the bottom and later/higher
 *      units rise towards the top -- the conventional Harris Matrix
 *      reading direction.
 *   3. sameRankEdges (zeitgleich) and equalsEdges (entspricht) force their
 *      endpoints onto the IDENTICAL rank: both are collapsed into one
 *      union-find cluster *before* layout, laid out as a single wide dagre
 *      node, then expanded back into individual boxes at that node's rank.
 *      dagre has no native "same rank" edge constraint, so this collapse/
 *      expand approach is what actually guarantees the same height instead
 *      of just hoping the ranking algorithm happens to agree.
 *   4. Within a cluster, "entspricht" partners are ordered to sit directly
 *      next to each other (nearest possible); plain "zeitgleich" members
 *      fill the remaining slots without that adjacency preference.
 */
export function layoutHarrisMatrix(nodeIds, rankEdges, sameRankEdges = [], equalsEdges = []) {
  // --- Union-Find over same-rank + equals pairs -----------------------
  const parent = new Map(nodeIds.map((id) => [id, id]))
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)))
      x = parent.get(x)
    }
    return x
  }
  const union = (a, b) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  for (const e of sameRankEdges) union(e.source, e.target)
  for (const e of equalsEdges) union(e.source, e.target)

  // --- Group members by cluster root -----------------------------------
  const rawClusters = new Map() // root -> [memberIds]
  for (const id of nodeIds) {
    const root = find(id)
    if (!rawClusters.has(root)) rawClusters.set(root, [])
    rawClusters.get(root).push(id)
  }

  // Order members within a cluster so "entspricht" partners end up
  // adjacent: walk the equals-subgraph restricted to this cluster's
  // members depth-first, which naturally groups connected members
  // consecutively; anything left over (only zeitgleich-linked, no
  // entspricht partner) is appended in its original order.
  function orderClusterMembers(members) {
    if (members.length <= 1) return members
    const memberSet = new Set(members)
    const adj = new Map(members.map((m) => [m, []]))
    for (const e of equalsEdges) {
      if (memberSet.has(e.source) && memberSet.has(e.target)) {
        adj.get(e.source).push(e.target)
        adj.get(e.target).push(e.source)
      }
    }
    const visited = new Set()
    const order = []
    for (const start of members) {
      if (visited.has(start)) continue
      const stack = [start]
      while (stack.length) {
        const cur = stack.pop()
        if (visited.has(cur)) continue
        visited.add(cur)
        order.push(cur)
        for (const nb of adj.get(cur)) if (!visited.has(nb)) stack.push(nb)
      }
    }
    return order
  }

  const clusterMembers = new Map() // root -> ordered member ids
  const clusterWidth = new Map()   // root -> total pixel width
  for (const [root, members] of rawClusters) {
    const ordered = orderClusterMembers(members)
    clusterMembers.set(root, ordered)
    clusterWidth.set(root, ordered.length * NODE_WIDTH + (ordered.length - 1) * CLUSTER_GAP)
  }

  // --- Collapsed dagre graph: one node per cluster ----------------------
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'BT', nodesep: 24, ranksep: 70, marginx: 20, marginy: 20 })
  g.setDefaultEdgeLabel(() => ({}))

  for (const [root] of clusterMembers) {
    g.setNode(root, { width: clusterWidth.get(root), height: NODE_HEIGHT })
  }

  // Redirect rank edges through cluster roots; a rank edge whose two ends
  // land in the SAME cluster after collapsing means the source data has a
  // contradiction (e.g. "A über B" alongside "A zeitgleich B") -- drop it
  // here rather than create a self-loop, the contradiction itself is a
  // data-quality issue outside this layout step's job to resolve.
  const collapsedEdges = new Map()
  for (const e of rankEdges) {
    const rs = find(e.source)
    const rt = find(e.target)
    if (rs === rt) continue
    collapsedEdges.set(`${rs}|${rt}`, { source: rs, target: rt })
  }
  for (const e of collapsedEdges.values()) g.setEdge(e.source, e.target)

  dagre.layout(g)

  // --- Expand clusters back into individual node positions --------------
  const positions = {}
  for (const [root, members] of clusterMembers) {
    const gn = g.node(root)
    const totalW = clusterWidth.get(root)
    let curX = gn.x - totalW / 2
    for (const m of members) {
      positions[m] = { x: curX, y: gn.y - NODE_HEIGHT / 2 }
      curX += NODE_WIDTH + CLUSTER_GAP
    }
  }
  for (const id of nodeIds) {
    if (!positions[id]) positions[id] = { x: 0, y: 0 }
  }

  return { positions, width: NODE_WIDTH, height: NODE_HEIGHT }
}
