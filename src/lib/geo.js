import proj4 from 'proj4'
import { looksLikeWkt, parseWkt } from './wkt.js'
import { connectedIds } from './filters.js'

const WGS84_DEF = '+proj=longlat +datum=WGS84 +no_defs'

// A small set of very common CRS, plus two *formulaic* families (WGS84 UTM
// and ETRS89 UTM) that cover the overwhelming majority of real-world survey
// data without needing a full EPSG database bundled into the app. Anything
// else can still be supplied by pasting a raw proj4 definition string
// directly into the EPSG field (it's detected by the "+proj=" prefix) --
// copyable from epsg.io for any CRS this table doesn't know about.
const KNOWN_EPSG = {
  4326: WGS84_DEF,
  3857: '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs',
  31287: '+proj=lcc +lat_1=49 +lat_2=46 +lat_0=47.5 +lon_0=13.33333333333333 +x_0=400000 +y_0=400000 +ellps=bessel +towgs84=577.326,90.129,463.919,5.137,1.474,5.297,2.4232 +units=m +no_defs', // MGI / Austria Lambert
  4258: '+proj=longlat +ellps=GRS80 +no_defs', // ETRS89
  3035: '+proj=laea +lat_0=52 +lon_0=10 +x_0=4321000 +y_0=3210000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs', // ETRS89-LAEA Europe
}

function utmProj4(zone, south) {
  return `+proj=utm +zone=${zone} +datum=WGS84 +units=m +no_defs${south ? ' +south' : ''}`
}

/** Resolve a user-supplied EPSG code (or a raw pasted proj4 def string) to a proj4 definition. */
export function epsgToProj4(input) {
  const s = String(input || '').trim()
  if (!s) return null
  if (s.startsWith('+proj=')) return s // raw proj4 string pasted directly
  const code = parseInt(s.replace(/^EPSG:/i, ''), 10)
  if (!Number.isFinite(code)) return null
  if (KNOWN_EPSG[code]) return KNOWN_EPSG[code]
  if (code >= 32601 && code <= 32660) return utmProj4(code - 32600, false) // WGS84 UTM north
  if (code >= 32701 && code <= 32760) return utmProj4(code - 32700, true)  // WGS84 UTM south
  if (code >= 25828 && code <= 25838) {
    return `+proj=utm +zone=${code - 25800} +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs` // ETRS89 UTM north
  }
  return null
}

/** All { nodeId, attrKey, wkt } triples across the graph whose attribute value looks like WKT. */
export function detectGeoAttributes(graph) {
  const found = []
  for (const [nodeId, nd] of Object.entries(graph.nodes || {})) {
    for (const [attrKey, value] of Object.entries(nd.a || {})) {
      if (looksLikeWkt(value)) found.push({ nodeId, attrKey, wkt: value })
    }
  }
  return found
}

/** One-hop neighbor node ids of `nodeId` (both outgoing and incoming edges).
    Used to highlight/find geometries linked via an intermediate node (e.g. a
    SE's several Position-Determination children) when the SE itself is
    selected, without hardcoding any specific property. */
export function neighborNodeIds(graph, nodeId) {
  const ids = new Set()
  const nd = graph?.nodes?.[nodeId]
  if (!nd) return ids
  for (const targets of Object.values(nd.o || {})) targets.forEach((t) => ids.add(t))
  for (const sources of Object.values(nd.i || {})) sources.forEach((s) => ids.add(s))
  return ids
}

// A value like "Münze" (a Material/Typ node's label) usually isn't itself
// a candidate map node -- it's reached via a couple of hops, e.g.
// geometry <- Position-Determination <- Fund -type-> "Münze". Searching
// only a candidate's own text would never find it. Instead, look at each
// map candidate's nearby neighborhood -- itself plus everything within
// `radius` hops -- so the search box can match a query against anything
// connected nearby, not just the candidate's own fields, while still
// selecting/highlighting the actual map-relevant node.
//
// Both a frontier cap and an entries cap are needed: the frontier cap
// bounds the BFS traversal itself (a hub node -- a Material shared by
// hundreds of Funds, say -- can otherwise put thousands of nodes in reach
// well before the entries cap even applies), the entries cap bounds how
// much text gets collected per candidate. TEXT_TRUNCATE keeps individual
// long free-text fields (a multi-paragraph "Befundbeschreibung") from
// blowing up memory on their own -- collecting the full text of every
// nearby long-text field for EVERY one of thousands of candidates that
// happen to share a hub neighbor turned out to need several GB in a real
// dataset (a plain OOM crash, not just slow). A prefix is enough to decide
// "does this field contain the query" for realistic search terms.
const MAX_ENTRIES_PER_CANDIDATE = 150
const MAX_FRONTIER_PER_HOP = 200
const TEXT_TRUNCATE = 200

function collectNearbyEntries(graph, id, radius) {
  const entries = []
  // `visited` bounds the BFS frontier and MUST be marked for every node the
  // traversal reaches, regardless of whether the entries cap has already
  // been hit -- otherwise, once capped, nodes near a hub never get marked
  // seen and keep getting re-added to the frontier every remaining hop, so
  // the frontier balloons combinatorially instead of shrinking.
  const visited = new Set([id])
  const addEntry = (nid) => {
    if (entries.length >= MAX_ENTRIES_PER_CANDIDATE) return
    const nnd = graph.nodes[nid]
    if (!nnd) return
    const texts = [nid, nnd.l, ...Object.values(nnd.a || {}).map((v) => String(v).slice(0, TEXT_TRUNCATE))]
    entries.push({ id: nid, label: nnd.l, texts })
  }
  addEntry(id)
  let frontier = [id]
  for (let hop = 0; hop < radius; hop++) {
    if (entries.length >= MAX_ENTRIES_PER_CANDIDATE) break
    const next = []
    outer: for (const cur of frontier) {
      for (const n of neighborNodeIds(graph, cur)) {
        if (visited.has(n)) continue
        visited.add(n)
        next.push(n)
        if (next.length >= MAX_FRONTIER_PER_HOP) break outer
      }
    }
    for (const n of next) {
      if (entries.length >= MAX_ENTRIES_PER_CANDIDATE) break
      addEntry(n)
    }
    frontier = next
  }
  return entries
}

// Filtering candidateIds on every keystroke needs to be cheap even with
// thousands of candidates -- a nested "for each candidate, for each nearby
// entry, for each text field" scan turned out to take 1-2 seconds per
// keystroke on a real dataset once the query got specific enough that most
// candidates had to be scanned in full. This precomputes one flat
// lowercase blob per candidate (once per dataset, not per keystroke) so
// per-keystroke filtering is a single String.includes() per candidate.
// Deliberately does NOT keep the structured entries around afterwards --
// retaining "up to 150 nearby text fields" for EVERY candidate
// simultaneously (thousands of them) is what caused the OOM crash above;
// the entries are cheap to recompute on-demand for the handful of ids that
// actually match (see findMatchedEntry).
export function buildMapSearchIndex(graph, candidateIds, radius = 2) {
  const index = new Map()
  for (const id of candidateIds) {
    const entries = collectNearbyEntries(graph, id, radius)
    const blob = entries.map((e) => e.texts.join(' ␟ ')).join(' ␟ ').toLowerCase()
    index.set(id, blob)
  }
  return index
}

/** For a candidate id that already matched buildMapSearchIndex's blob,
    find which specific nearby entry actually contains the query (for the
    search result's "via" subtitle). Recomputes that one candidate's
    neighborhood on demand -- only meant to be called on the small number
    of ids that already matched, not on the full candidate pool. */
export function findMatchedEntry(graph, id, radius, queryLower) {
  const entries = collectNearbyEntries(graph, id, radius)
  return entries.find((e) => e.texts.some((t) => t.toLowerCase().includes(queryLower))) || null
}

// A geometry-bearing node's category property (Material, Fundtyp, "found
// in SE", ...) often doesn't sit on that node itself but one hop further
// out -- e.g. a find's geometry lives on a dedicated "Einmessung Fund"
// node, which connects to the Fund object, which is what actually carries
// the Material/Fundtyp connection. Checks the node itself first, falling
// back to each one-hop neighbor, and returns the first label found (a
// node with several distinct values for the property, e.g. two recorded
// materials, is placed in only the first one found -- multi-membership
// would mean drawing the same marker on the map more than once). Returns
// null if nothing connects via propKey within that radius.
export function resolveFeatureCategory(graph, nodeId, propKey) {
  const nd = graph.nodes[nodeId]
  if (!nd) return null
  const ownLabel = connectedIds(nd, propKey).map((tid) => graph.nodes[tid]?.l).find(Boolean)
  if (ownLabel) return ownLabel
  for (const nId of neighborNodeIds(graph, nodeId)) {
    const nnd = graph.nodes[nId]
    if (!nnd) continue
    const label = connectedIds(nnd, propKey).map((tid) => graph.nodes[tid]?.l).find(Boolean)
    if (label) return label
  }
  return null
}

export function hasGeoData(graph) {
  if (!graph) return false
  for (const nd of Object.values(graph.nodes || {})) {
    for (const value of Object.values(nd.a || {})) {
      if (looksLikeWkt(value)) return true
    }
  }
  return false
}

function isCoordPair(x) {
  return Array.isArray(x) && x.length === 2 && typeof x[0] === 'number' && typeof x[1] === 'number'
}

/** Recursively reproject every [x,y] leaf in a GeoJSON-shaped coordinate tree to Leaflet [lat,lng] pairs. */
function deepReproject(coords, transformer) {
  if (isCoordPair(coords)) {
    const [lon, lat] = transformer.forward(coords)
    return [lat, lon]
  }
  return coords.map((c) => deepReproject(c, transformer))
}

/**
 * Parse + reproject every WKT attribute in the graph using the given source
 * EPSG code (or raw proj4 string). Returns:
 *   features - [{ nodeId, attrKey, type, coordinates (Leaflet [lat,lng]-shaped) }]
 *   failedCount - WKT values that failed to parse (malformed/truncated source data)
 * Returns null if epsgInput doesn't resolve to a usable projection.
 */
export function buildGeoFeatures(graph, epsgInput) {
  const fromDef = epsgToProj4(epsgInput)
  if (!fromDef) return null

  const transformer = proj4(fromDef, WGS84_DEF)
  const attrs = detectGeoAttributes(graph)
  const features = []
  let failedCount = 0

  for (const { nodeId, attrKey, wkt } of attrs) {
    const parsed = parseWkt(wkt)
    if (!parsed) {
      failedCount++
      continue
    }
    try {
      features.push({
        nodeId,
        attrKey,
        type: parsed.type,
        coordinates: deepReproject(parsed.coordinates, transformer),
      })
    } catch {
      failedCount++
    }
  }

  return { features, failedCount, totalCount: attrs.length }
}
