// collapse.js
//
// "Pass-through node collapsing" (graph node contraction). CIDOC-style event
// modelling inserts intermediate nodes everywhere -- e.g. a stratigraphic unit
// isn't linked to a find directly but via an Embedding / Position-Determination
// event node. Those event nodes are structurally necessary in RDF but often
// carry no analytical value of their own, inflate the graph (21 000 finds ->
// 21 000 embeddings) and hide the real SE<->Fund relationship.
//
// collapseTypes() removes every node of the chosen type(s) and reconnects the
// surrounding non-collapsed nodes directly. The result is the SAME graph-JSON
// shape as a freshly loaded graph, so the rest of the app needs no changes.
//
// Reconnection is COMPONENT-BASED and direction-agnostic, which is the key
// point: a collapsed node's "arms" are reconnected regardless of which way the
// original edges pointed. CIDOC relators often have BOTH edges pointing out of
// the event node, e.g.
//     Fund <--AP18-- Embedding --AP19--> SE
// A naive "predecessor -> successor" rule would find no predecessor here and
// silently drop the SE<->Fund link. Instead we:
//   * union every connected blob of collapsed nodes into one component,
//   * collect its "ports" = the non-collapsed nodes attached to that blob,
//     tagged as IN (port --> blob) or OUT (blob --> port),
//   * then link the ports:
//       - IN x OUT   (the classic SE --> event --> Fund path), else
//       - OUT pairwise (both arms point out: Fund <-- event --> SE), else
//       - IN pairwise  (both arms point in).
//
// New edge key = "<propA>»<propB>", label = "<A> › <B>", so both original
// relations stay readable.
//
// Every edge carries TWO names, one per direction: a Studio graph writes
// "Hat POIs" into the place's `o` and "Ist POI von" into the POI's `i`, and
// the detail view shows the second one on the incoming side. The collapse
// therefore never DERIVES `i` from `o` -- that would print the forward
// wording in both directions. Surviving edges keep their incoming names
// verbatim, and a bypass edge is built as two readings of the same path
// (see toBlob/fromBlob below).
//
// The collapsed nodes' ATTRIBUTES are carried over to the surviving neighbours
// (see mergeAttrValue). Without that, collapsing a node whose only content is
// literal -- the CIDOC case being an E52 Time-Span holding nothing but a begin
// and an end year -- would silently destroy the dating: such a node is a LEAF
// (one single arm), so there is no second port to reconnect it to and nothing
// at all would remain of it. Carrying the literals over is what makes a
// literal-only pass-through collapsible in the first place: the year lands
// directly on the find.

const BYPASS_SEP = '»'
const MERGE_SEP = ' · '
const MERGE_MORE = '…'
const MAX_MERGED_VALUES = 6

function humaniseKey(k) {
  const local = k.includes('#') ? k.split('#').pop() : k.split('/').pop()
  return local.replace(/_/g, ' ')
}

// Put ONE attribute value of a collapsed node onto a surviving neighbour.
// A free key simply takes the value (type preserved -- values may be numbers
// or arrays). An occupied key APPENDS instead of overwriting: a node can be
// the port of many collapsed components at once (one stratigraphic unit with
// 3 000 finds sees 3 000 embeddings), and neither the neighbour's own value
// nor the first one carried over may be lost. The cap keeps such a hub node
// from collecting thousands of values in a single field.
function mergeAttrValue(target, key, value) {
  const cur = target[key]
  if (cur == null || cur === '') { target[key] = value; return }
  const parts = String(cur).split(MERGE_SEP)
  if (parts[parts.length - 1] === MERGE_MORE) return
  const v = String(value)
  if (parts.includes(v)) return
  target[key] = String(cur) + MERGE_SEP + (parts.length >= MAX_MERGED_VALUES ? MERGE_MORE : v)
}

/** How many nodes of the given type(s) would be removed (for a UI hint). */
export function collapsePreview(graph, typeKeys) {
  const set = new Set(typeKeys)
  let n = 0
  for (const nd of Object.values(graph.nodes || {})) if (set.has(nd.t)) n++
  return n
}

/**
 * Return a NEW graph-JSON object with every node whose type is in `typeKeys`
 * removed and the surrounding non-collapsed nodes reconnected. `graph` is left
 * untouched. Works on the outgoing (`o`) adjacency, which the RDF importer and
 * the backend both populate for every relationship.
 */
export function collapseTypes(graph, typeKeys) {
  const typeSet = new Set(typeKeys)
  if (!typeSet.size) return graph

  const nodes = graph.nodes || {}
  const isCollapsed = (id) => nodes[id] != null && typeSet.has(nodes[id].t)
  const origEdgeLabels = graph.schema?.edgeLabels || {}
  const edgeLabelOf = (k) => origEdgeLabels[k] || humaniseKey(k)

  // ── union-find over connected collapsed nodes (a "blob") ─────────────────
  const parent = new Map()
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x) } return x }
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb) }
  for (const id in nodes) if (isCollapsed(id)) parent.set(id, id)
  for (const [id, nd] of Object.entries(nodes)) {
    if (!isCollapsed(id)) continue
    for (const tgts of Object.values(nd.o || {})) for (const t of tgts) if (isCollapsed(t)) union(id, t)
  }

  // ── the literals each collapsed component carries ────────────────────────
  // Collected per component (not per node) so a chain of collapsed nodes hands
  // its combined content to the ports of the chain as a whole.
  const blobAttrs = new Map() // root -> [[key, value], ...]
  for (const [id, nd] of Object.entries(nodes)) {
    if (!isCollapsed(id)) continue
    const root = find(id)
    for (const [k, v] of Object.entries(nd.a || {})) {
      if (v == null || v === '') continue
      const list = blobAttrs.get(root)
      if (list) list.push([k, v])
      else blobAttrs.set(root, [[k, v]])
    }
  }

  // ── collect ports per collapsed component ────────────────────────────────
  // inPorts[root]:  non-collapsed A with  A --prop--> (blob)
  // outPorts[root]: non-collapsed B with  (blob) --prop--> B
  //
  // Alongside the key the port itself uses (from `o`) we remember the key the
  // FAR end of that same edge uses (from `i`) -- the inverse wording. Pairing
  // is per blob and port node, so a port attached to one blob under several
  // different keys can't be resolved; it is marked null and simply reuses its
  // forward key, which is what the collapse did everywhere before.
  const inPorts = new Map(), outPorts = new Map()
  const portMap = (m, root) => m.get(root) || (m.set(root, new Map()), m.get(root))
  const portKeys = new Map()          // root -> Map(portNode -> { o, i })
  const notePortKey = (root, node, side, key) => {
    const m = portKeys.get(root) || (portKeys.set(root, new Map()), portKeys.get(root))
    const rec = m.get(node) || (m.set(node, {}), m.get(node))
    rec[side] = !(side in rec) || rec[side] === key ? key : null
  }
  const farKey = (root, node, own) => {
    const rec = portKeys.get(root)?.get(node)
    return rec && rec.o && rec.i ? rec.i : own
  }
  for (const [id, nd] of Object.entries(nodes)) {
    const sC = isCollapsed(id)
    for (const [key, tgts] of Object.entries(nd.o || {})) {
      for (const t of tgts) {
        const tC = isCollapsed(t)
        if (!sC && tC) { const r = find(t); portMap(inPorts, r).set(id + '\n' + key, { node: id, prop: key }); notePortKey(r, id, 'o', key) }
        else if (sC && !tC) { const r = find(id); portMap(outPorts, r).set(t + '\n' + key, { node: t, prop: key }); notePortKey(r, t, 'o', key) }
      }
    }
    // The same edges seen from their other end, where `i` names them inversely.
    for (const [key, srcs] of Object.entries(nd.i || {})) {
      for (const s of srcs) {
        const srcC = isCollapsed(s)
        if (sC && !srcC) notePortKey(find(id), s, 'i', key)       // in-port, as the blob names it
        else if (!sC && srcC) notePortKey(find(s), id, 'i', key)  // out-port, as the port names it
      }
    }
  }

  // ── output nodes (non-collapsed only), attrs kept, adjacency rebuilt ─────
  const out = {}
  for (const [id, nd] of Object.entries(nodes)) {
    if (isCollapsed(id)) continue
    out[id] = { l: nd.l, t: nd.t, a: { ...nd.a }, o: {}, i: {} }
  }

  const edgeCounts = {}
  const bypassLabels = {}
  // One hop's reading, stitched to the next one's: "<A>»<B>" / "<A> › <B>".
  const bypassKey = (k1, k2) => {
    const key = k1 + BYPASS_SEP + k2
    if (!(key in bypassLabels)) bypassLabels[key] = edgeLabelOf(k1) + ' › ' + edgeLabelOf(k2)
    return key
  }
  const addEdge = (s, key, t) => {
    if (s === t || !out[s] || !out[t]) return false
    ;(out[s].o[key] || (out[s].o[key] = new Set())).add(t)
    edgeCounts[key] = (edgeCounts[key] || 0) + 1
    return true
  }
  const addIn = (t, key, s) => { (out[t].i[key] || (out[t].i[key] = new Set())).add(s) }

  // 1) keep ordinary edges (both endpoints survive). The incoming side is
  //    COPIED, never derived from the outgoing one: it carries the inverse
  //    wording ("Ist POI von" for an outgoing "Hat POIs") and rebuilding it
  //    from `o` would show the forward reading in both directions.
  for (const [id, nd] of Object.entries(nodes)) {
    if (isCollapsed(id)) continue
    for (const [key, tgts] of Object.entries(nd.o || {})) {
      for (const t of tgts) if (!isCollapsed(t)) addEdge(id, key, t)
    }
    for (const [key, srcs] of Object.entries(nd.i || {})) {
      for (const s of srcs) if (s !== id && !isCollapsed(s) && out[s]) addIn(id, key, s)
    }
  }

  // 2) reconnect the ports of each collapsed component, and hand its literals
  //    to every port -- a one-armed component (a Time-Span leaf) has nothing
  //    to reconnect but still has something to say.
  //
  //    Each port gets both readings of its own hop: `to` = how it reads when
  //    walking port -> blob, `from` = how it reads walking blob -> port. A
  //    bypass edge P1 -> P2 is then "P1.to › P2.from", and the same path read
  //    backwards -- what P2 shows as its incoming group -- is "P2.to › P1.from".
  //    Without inverse names in the source graph both collapse to the old
  //    forward-only key.
  const roots = new Set([...inPorts.keys(), ...outPorts.keys()])
  for (const r of roots) {
    const ins = [...(inPorts.get(r)?.values() || [])].map((p) => ({ node: p.node, to: p.prop, from: farKey(r, p.node, p.prop) }))
    const outs = [...(outPorts.get(r)?.values() || [])].map((p) => ({ node: p.node, to: farKey(r, p.node, p.prop), from: p.prop }))

    const carried = blobAttrs.get(r)
    if (carried) {
      for (const port of new Set([...ins, ...outs].map((p) => p.node))) {
        const t = out[port]
        if (t) for (const [k, v] of carried) mergeAttrValue(t.a, k, v)
      }
    }

    const link = (a, b) => {
      if (addEdge(a.node, bypassKey(a.to, b.from), b.node)) addIn(b.node, bypassKey(b.to, a.from), a.node)
    }
    if (ins.length && outs.length) {
      for (const a of ins) for (const b of outs) link(a, b)
    } else if (outs.length >= 2) {
      for (let i = 0; i < outs.length; i++) for (let j = i + 1; j < outs.length; j++) link(outs[i], outs[j])
    } else if (ins.length >= 2) {
      for (let i = 0; i < ins.length; i++) for (let j = i + 1; j < ins.length; j++) link(ins[i], ins[j])
    }
  }

  // ── Sets -> arrays (both directions were filled while adding edges) ──────
  for (const nd of Object.values(out)) {
    for (const [key, set] of Object.entries(nd.o)) nd.o[key] = [...set]
    for (const [key, set] of Object.entries(nd.i)) nd.i[key] = [...set]
  }

  // ── node_types recount + schema (surviving types + bypass edge labels) ───
  const nodeTypes = {}
  for (const nd of Object.values(out)) if (nd.t) nodeTypes[nd.t] = (nodeTypes[nd.t] || 0) + 1

  const oldSchema = graph.schema || {}
  const typeColors = {}, typeLabels = {}
  for (const t of Object.keys(nodeTypes)) {
    if (oldSchema.typeColors?.[t] != null) typeColors[t] = oldSchema.typeColors[t]
    if (oldSchema.typeLabels?.[t] != null) typeLabels[t] = oldSchema.typeLabels[t]
  }
  const edgeLabels = {}
  for (const k of Object.keys(edgeCounts)) edgeLabels[k] = origEdgeLabels[k] || bypassLabels[k] || humaniseKey(k)
  Object.assign(edgeLabels, bypassLabels)
  // Incoming keys are their own vocabulary ("Ist POI von") and never show up
  // in edge_types -- their labels have to survive the collapse all the same.
  for (const nd of Object.values(out)) {
    for (const k in nd.i) if (!(k in edgeLabels)) edgeLabels[k] = origEdgeLabels[k] || humaniseKey(k)
  }

  const totalEdges = Object.values(edgeCounts).reduce((a, b) => a + b, 0)
  return {
    meta: {
      ...(graph.meta || {}),
      node_count: Object.keys(out).length,
      edge_count: totalEdges,
      collapsed_types: [...typeSet],
    },
    nodes: out,
    node_types: nodeTypes,
    edge_types: edgeCounts,
    schema: { typeColors, typeLabels, edgeLabels, mainAttrs: oldSchema.mainAttrs || {} },
  }
}
