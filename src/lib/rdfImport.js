// rdfImport.js
//
// Client-side RDF -> Graph-Explorer-JSON importer. Lets the Explorer open a
// raw RDF dump (Turtle / TriG / N-Triples / N-Quads / N3, incl. RDF-star)
// directly, without going through the OntoCartographer Studio backend.
//
// This mirrors the semantics of the backend's /pipeline/graph-explorer-json
// as closely as is possible WITHOUT the ontology being available:
//   * rdf:type            -> node type (`t`)
//   * label properties     -> node label (`l`), German preferred -- rdfs:label,
//                            skos:pref/altLabel, dc/dcterms:title, foaf:name,
//                            schema:name (so a node shows its name, not its URI)
//   * literal objects      -> attributes (`a`) with the same merge/collision
//                            handling as the backend (multi-valued props are
//                            merged, cross-namespace local-name collisions get
//                            a "#2" suffix instead of silently overwriting)
//   * resource objects     -> outgoing edge (`o`) + raw inverse (`i`)
//   * << s p o >> q v       -> dot-one edge key "<p>#dot1:<canonical(v)>"
//                            (RDF-star), so the Harris-Matrix view works
//
// Deliberate first-version limitations (documented for the user):
//   * Named graphs (the quad context in TriG/N-Quads) are FLATTENED / ignored.
//   * Without the ontology, incoming edges keep the forward property name
//     (no owl:inverseOf renaming) and colours come from the neutral palette
//     (no CIDOC-anchor / superclass colouring).
//   * RDF/XML (.rdf/.owl/.xml) is not handled here (N3.js can't parse it).

import { Parser } from 'n3'
import { PALETTE } from './schema'

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
// Common "human label" properties, in priority order (lower index wins). A
// resource's display label (`l`) is taken from the best available one so a
// node shows its name rather than its URI whenever ANY of these is present --
// not just rdfs:label.
const LABEL_PREDICATES = {
  'http://www.w3.org/2000/01/rdf-schema#label': 0,
  'http://www.w3.org/2004/02/skos/core#prefLabel': 1,
  'http://purl.org/dc/terms/title': 2,
  'http://purl.org/dc/elements/1.1/title': 3,
  'http://xmlns.com/foaf/0.1/name': 4,
  'http://schema.org/name': 5,
  'https://schema.org/name': 5,
  'http://www.w3.org/2004/02/skos/core#altLabel': 6,
}
// N3.js parses RDF-star `<< s p o >> q v .` as the RDF 1.2 reification model:
//   _:reifier rdf:reifies <<( s p o )>> .   (object is a triple term / Quad)
//   _:reifier q v .                          (the qualifier)
const RDF_REIFIES = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#reifies'

// Types never worth showing as a node's display type.
const META_TYPES = new Set([
  'http://www.w3.org/2002/07/owl#NamedIndividual',
  'http://www.w3.org/2002/07/owl#Thing',
  'http://www.w3.org/2000/01/rdf-schema#Resource',
  'http://www.w3.org/2002/07/owl#Class',
  'http://www.w3.org/2000/01/rdf-schema#Class',
])

// ── Dot-one qualifier vocabulary (mirrors backend _DOT_ONE_VOCAB) ────────────
const UMLAUT = [[/ä/g, 'ae'], [/ö/g, 'oe'], [/ü/g, 'ue'], [/ß/g, 'ss']]
function canon(text) {
  let s = String(text).trim().toLowerCase()
  for (const [re, r] of UMLAUT) s = s.replace(re, r)
  if (DOT_ONE_VOCAB[s]) return s
  // Qualifier URIs minted as "<prefix>_<value>" (e.g. Relationstyp_above ->
  // "relationstyp above"): fall back to a known trailing part, mirroring
  // _dot_one_canon in the OntoCartographer backend.
  const words = s.split(/\s+/)
  for (let i = 1; i < words.length; i++) {
    const tail = words.slice(i).join(' ')
    if (DOT_ONE_VOCAB[tail]) return tail
  }
  return s
}
const DOT_ONE_VOCAB = {
  ueber: { inverse: 'unter', label: 'über' }, unter: { inverse: 'ueber', label: 'unter' },
  above: { inverse: 'below', label: 'above' }, below: { inverse: 'above', label: 'below' },
  over: { inverse: 'under', label: 'over' }, under: { inverse: 'over', label: 'under' },
  oben: { inverse: 'unten', label: 'oben' }, unten: { inverse: 'oben', label: 'unten' },
  gleichzeitig: { inverse: 'gleichzeitig', label: 'gleichzeitig' },
  zeitgleich: { inverse: 'zeitgleich', label: 'zeitgleich' },
  'same time': { inverse: 'same time', label: 'same time' },
  'contemporary with': { inverse: 'contemporary with', label: 'contemporary with' },
  entspricht: { inverse: 'entspricht', label: 'entspricht' },
  equals: { inverse: 'equals', label: 'equals' },
  'same as': { inverse: 'same as', label: 'same as' },
  'corresponds to': { inverse: 'corresponds to', label: 'corresponds to' },
}
function dotLabel(text) { const e = DOT_ONE_VOCAB[canon(text)]; return e ? e.label : String(text) }
function dotInverseLabel(text) {
  const e = DOT_ONE_VOCAB[canon(text)]
  if (!e) return String(text)          // unknown vocabulary -> unchanged (no guessing)
  const inv = DOT_ONE_VOCAB[e.inverse]
  return inv ? inv.label : e.inverse
}

function localName(uri) {
  const i = Math.max(uri.lastIndexOf('#'), uri.lastIndexOf('/'))
  return i >= 0 ? uri.slice(i + 1) : uri
}
function humanise(uri) { return localName(uri).replace(/_/g, ' ') }

const FORMAT_BY_EXT = {
  ttl: 'text/turtle', turtle: 'text/turtle',
  trig: 'application/trig',
  nt: 'application/n-triples', ntriples: 'application/n-triples',
  nq: 'application/n-quads', nquads: 'application/n-quads',
  n3: 'text/n3',
}

/** File extensions this importer can handle (RDF/XML deliberately excluded). */
export function rdfExtSupported(ext) {
  return String(ext || '').toLowerCase() in FORMAT_BY_EXT
}

/**
 * Parse an RDF text into the Explorer's internal graph-JSON model.
 * @throws if the RDF text is malformed (N3.Parser throws a descriptive error).
 */
export function rdfTextToGraph(text, ext, title = 'RDF Import') {
  const format = FORMAT_BY_EXT[String(ext || '').toLowerCase()]
  const parser = new Parser(format ? { format } : {})
  const quads = parser.parse(text)   // synchronous; throws on malformed input

  const nodes = {}                   // id -> { l, t, a, o, i }  (o/i are Sets during build)
  const typeCandidates = {}          // nodeId -> Set(typeUri)
  const labelRank = {}               // nodeId -> { prio, isDe } for the best label chosen
  const attrSource = {}              // nodeId -> { attrKey -> predicateUri }
  const edgeCounts = {}              // edgeKey -> count (forward only)
  const dotOneEdgeLabels = {}        // dot1 edgeKey -> "base (value)" label
  const resourceLabel = {}           // any resource uri -> label (for type/edge labels)

  const ensure = (id) => (nodes[id] || (nodes[id] = { l: '', t: '', a: {}, o: {}, i: {} }))
  const termId = (t) => (t.termType === 'BlankNode' ? '_:' + t.value : t.value)

  // Adjacency lists are built as Sets (O(1) dedup) and converted to arrays at
  // the very end. Array.includes()-based dedup was O(degree^2) per node, which
  // is a real freeze on hub nodes (e.g. one context linked to thousands of
  // finds) -- the main reason importing a large RDF file felt slow.
  const addOut = (s, key, o, count = true) => {
    const nd = ensure(s)
    ;(nd.o[key] || (nd.o[key] = new Set())).add(o)
    if (count) edgeCounts[key] = (edgeCounts[key] || 0) + 1
  }
  const addIn = (o, key, s) => {
    const nd = ensure(o)
    ;(nd.i[key] || (nd.i[key] = new Set())).add(s)
  }
  const addAttr = (id, predUri, value) => {
    const nd = ensure(id)
    const base = localName(predUri) || 'value'
    const src = attrSource[id] || (attrSource[id] = {})
    let key = base, n = 2
    while (key in nd.a && src[key] !== predUri) { key = base + '#' + n; n++ }
    if (!(key in nd.a)) { nd.a[key] = value; src[key] = predUri }
    else {                                        // same predicate again -> merge values
      const parts = String(nd.a[key]).split('; ')
      if (!parts.includes(value)) nd.a[key] = nd.a[key] + '; ' + value
    }
  }

  // ── emit one dot-one edge (both directions) for a reified base triple ────
  // The qualifier value may be a literal ("above") or a resource -- CIDOC's
  // AP11.1_has_type in particular points at an E55_Type individual such as
  // hme:Relationstyp_above. Humanising that URI would yield "Relationstyp
  // above", which matches no dot-one vocabulary entry and would silently
  // demote every stratigraphic relation to "unklare Beziehung" (flat matrix),
  // so the resource's own label wins whenever it has one.
  const emitDotOne = (bs, bp, bo, valueTerm) => {
    const rawText = valueTerm.termType === 'Literal'
      ? valueTerm.value
      : (resourceLabel[valueTerm.value] || humanise(valueTerm.value))
    ensure(bs); ensure(bo)
    const outKey = bp + '#dot1:' + canon(rawText)
    const inKey = bp + '#dot1:' + canon(dotInverseLabel(rawText))
    const baseLbl = resourceLabel[bp] || humanise(bp)
    dotOneEdgeLabels[outKey] = baseLbl + ' (' + dotLabel(rawText) + ')'
    addOut(bs, outKey, bo)
    dotOneEdgeLabels[inKey] = baseLbl + ' (' + dotInverseLabel(rawText) + ')'
    addOut(bo, inKey, bs, false)                  // derived reverse side, not counted
  }

  // Pass 1: map every reifier node to the base triple it reifies. Reifier
  // nodes (and the triple terms) are structural -- they never become graph
  // nodes themselves. `reifiedTriples` lets pass 2 skip the plain base edge
  // when the relation is already shown as a dot-one edge (avoids a duplicate).
  const tripleKey = (s, p, o) => s + '\n' + p + '\n' + o
  const reifierBase = {}                          // reifierId -> { s, p, o }
  const reifiedTriples = new Set()
  for (const q of quads) {
    if (q.predicate.value === RDF_REIFIES && q.object.termType === 'Quad') {
      const b = q.object
      const bs = termId(b.subject), bp = b.predicate.value, bo = termId(b.object)
      reifierBase[termId(q.subject)] = { s: bs, p: bp, o: bo }
      reifiedTriples.add(tripleKey(bs, bp, bo))
    }
  }

  // Pass 2: everything else. Dot-one edges are only *collected* here and
  // emitted afterwards: emitDotOne() resolves the qualifier resource's label,
  // and Turtle gives no ordering guarantee that the rdfs:label of that type
  // was already seen when its annotation is reached.
  const pendingDotOne = []
  for (const q of quads) {
    const p = q.predicate.value
    if (p === RDF_REIFIES) continue               // structural, handled in pass 1
    const s = termId(q.subject)

    // Qualifier on a reified triple -> dot-one edge.
    if (reifierBase[s]) {
      const b = reifierBase[s]
      pendingDotOne.push([b.s, b.p, b.o, q.object])
      continue
    }

    // Legacy: some parsers expose `<< s p o >>` as a quoted-triple subject.
    if (q.subject.termType === 'Quad') {
      const b = q.subject
      pendingDotOne.push([termId(b.subject), b.predicate.value, termId(b.object), q.object])
      continue
    }

    const o = q.object
    if (o.termType === 'Quad') continue           // stray triple-term object

    const labelPrio = o.termType === 'Literal' ? LABEL_PREDICATES[p] : undefined

    if (p === RDF_TYPE && o.termType !== 'Literal') {
      ensure(s);
      (typeCandidates[s] || (typeCandidates[s] = new Set())).add(o.value)
    } else if (labelPrio !== undefined) {
      // Recognised label property -> node label (`l`). Keep the best one:
      // highest-priority predicate, German preferred within the same predicate.
      ensure(s)
      const isDe = o.language === 'de'
      const cur = labelRank[s]
      if (!cur || labelPrio < cur.prio || (labelPrio === cur.prio && isDe && !cur.isDe)) {
        nodes[s].l = o.value
        resourceLabel[s] = o.value
        labelRank[s] = { prio: labelPrio, isDe }
      }
    } else if (o.termType === 'Literal') {
      addAttr(s, p, o.value)
    } else {                                              // resource-valued -> edge
      const oid = termId(o)
      ensure(s); ensure(oid)
      // Skip the plain base edge when this exact triple is already reified:
      // it is shown as a dot-one edge instead, so keeping it too would draw
      // the same relation twice.
      if (!reifiedTriples.has(tripleKey(s, p, oid))) {
        addOut(s, p, oid)
        addIn(oid, p, s)
      }
    }
  }

  // ── now that every label is known, emit the collected dot-one edges ─────
  for (const [bs, bp, bo, valueTerm] of pendingDotOne) emitDotOne(bs, bp, bo, valueTerm)

  // ── pick one display type per node ──────────────────────────────────────
  for (const [id, set] of Object.entries(typeCandidates)) {
    const nonMeta = [...set].filter((t) => !META_TYPES.has(t))
    const chosen = (nonMeta.length ? nonMeta : [...set]).sort()[0]
    if (chosen) nodes[id].t = chosen
  }

  // ── convert adjacency Sets -> arrays (the app expects arrays) ────────────
  for (const nd of Object.values(nodes)) {
    for (const k in nd.o) nd.o[k] = [...nd.o[k]]
    for (const k in nd.i) nd.i[k] = [...nd.i[k]]
  }

  // ── labels + type counts ────────────────────────────────────────────────
  const typeCounts = {}
  for (const [id, nd] of Object.entries(nodes)) {
    if (!nd.l) nd.l = localName(id)
    if (nd.t) typeCounts[nd.t] = (typeCounts[nd.t] || 0) + 1
  }

  // ── schema: palette colours + data/humanised labels ─────────────────────
  const typeColors = {}, typeLabels = {}, edgeLabels = {}
  Object.keys(typeCounts).sort().forEach((t, i) => {
    typeColors[t] = PALETTE[i % PALETTE.length]
    typeLabels[t] = resourceLabel[t] || humanise(t)
  })
  const edgeKeys = new Set(Object.keys(edgeCounts))
  for (const nd of Object.values(nodes)) {
    Object.keys(nd.o).forEach((k) => edgeKeys.add(k))
    Object.keys(nd.i).forEach((k) => edgeKeys.add(k))
  }
  for (const k of edgeKeys) edgeLabels[k] = resourceLabel[k] || humanise(k)
  Object.assign(edgeLabels, dotOneEdgeLabels)

  const totalEdges = Object.values(edgeCounts).reduce((a, b) => a + b, 0)
  return {
    meta: {
      title,
      node_count: Object.keys(nodes).length,
      edge_count: totalEdges,
      generated_by: 'RDF import (GraphExplorer)',
    },
    nodes,
    node_types: typeCounts,
    edge_types: edgeCounts,
    schema: { typeColors, typeLabels, edgeLabels, mainAttrs: {} },
  }
}
