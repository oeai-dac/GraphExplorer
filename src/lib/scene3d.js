// The data side of the 3D view -- everything that can be decided without
// three.js, so it can be checked in Node (tests/fixtures/run-scene3d-check.mjs).
//
// Two sources feed the scene, both optional:
//   - WKT attributes with a Z ordinate, straight from the graph
//   - a Wavefront OBJ loaded next to it, whose objects are matched to nodes
//     by name -- the same convention as the Blender and CloudCompare links:
//     OBJ object name = node label.
//
// Both have to end up in ONE metric frame. WKT is often stored in degrees
// (EPSG:4326), which is no good for a 3D view whose heights are metres, so a
// geographic CRS is projected to the WGS84 UTM zone of the data. A projected
// CRS is taken as it is. The OBJ is then placed in that frame by an origin
// (easting, northing, height) the user can set -- an OBJ has no CRS of its own.

import proj4 from 'proj4'
import { epsgToProj4, detectGeoAttributes } from './geo.js'
import { parseWkt } from './wkt.js'

const WGS84_DEF = '+proj=longlat +datum=WGS84 +no_defs'

function isGeographic(def) {
  return /\+proj=(longlat|latlong|lonlat|latlon)\b/.test(def)
}

// Every coordinate tuple of a GeoJSON-shaped coordinate tree.
function eachTuple(coords, fn) {
  if (Array.isArray(coords) && typeof coords[0] === 'number') fn(coords)
  else if (Array.isArray(coords)) coords.forEach((c) => eachTuple(c, fn))
}

function mapTuples(coords, fn) {
  if (Array.isArray(coords) && typeof coords[0] === 'number') return fn(coords)
  return coords.map((c) => mapTuples(c, fn))
}

/** WGS84 UTM zone for a lon/lat position, as { def, label }. */
export function utmZoneFor(lon, lat) {
  const zone = Math.min(60, Math.max(1, Math.floor((lon + 180) / 6) + 1))
  const south = lat < 0
  return {
    def: `+proj=utm +zone=${zone} +datum=WGS84 +units=m +no_defs${south ? ' +south' : ''}`,
    label: `EPSG:${(south ? 32700 : 32600) + zone}`,
  }
}

/**
 * Every WKT geometry of the graph that carries heights, in a metric frame.
 * Returns null if `epsgInput` doesn't resolve, otherwise
 *   features   - [{ nodeId, attrKey, type, coordinates ([x, y, z]-shaped) }]
 *   frame      - label of the metric CRS the coordinates are in
 *   flatCount  - geometries without Z (not shown: they have no height to sit at)
 *   failedCount, totalCount - as in buildGeoFeatures
 */
export function buildScene3dFeatures(graph, epsgInput) {
  const fromDef = epsgToProj4(epsgInput)
  if (!fromDef) return null

  const attrs = detectGeoAttributes(graph)
  const parsed = []
  let flatCount = 0
  let failedCount = 0
  for (const { nodeId, attrKey, wkt } of attrs) {
    const g = parseWkt(wkt, { keepZ: true })
    if (!g) {
      failedCount++
      continue
    }
    let hasZ = true
    let any = false
    let bad = false
    eachTuple(g.coordinates, (t) => {
      any = true
      if (!Number.isFinite(t[0]) || !Number.isFinite(t[1])) bad = true
      if (t.length < 3 || !Number.isFinite(t[2])) hasZ = false
    })
    if (!any || bad) {
      failedCount++
      continue
    }
    if (!hasZ) {
      flatCount++
      continue
    }
    parsed.push({ nodeId, attrKey, type: g.type, coordinates: g.coordinates })
  }

  // Pick the frame. For degrees: the UTM zone of the data's mean position.
  let toDef = fromDef
  let frame = String(epsgInput).startsWith('+proj=') ? 'own projection' : 'EPSG:' + String(epsgInput).replace(/^EPSG:/i, '')
  if (isGeographic(fromDef) && parsed.length) {
    const toWgs = proj4(fromDef, WGS84_DEF)
    let sx = 0, sy = 0, n = 0
    for (const f of parsed) {
      eachTuple(f.coordinates, (t) => {
        const [lon, lat] = toWgs.forward([t[0], t[1]])
        if (Number.isFinite(lon) && Number.isFinite(lat)) { sx += lon; sy += lat; n++ }
      })
    }
    if (n) {
      const utm = utmZoneFor(sx / n, sy / n)
      toDef = utm.def
      frame = utm.label
    }
  }

  const transformer = toDef === fromDef ? null : proj4(fromDef, toDef)
  const features = []
  for (const f of parsed) {
    try {
      let ok = true
      const coordinates = mapTuples(f.coordinates, (t) => {
        const [x, y] = transformer ? transformer.forward([t[0], t[1]]) : [t[0], t[1]]
        if (!Number.isFinite(x) || !Number.isFinite(y)) ok = false
        return [x, y, t[2]]
      })
      if (ok) features.push({ ...f, coordinates })
      else failedCount++
    } catch {
      failedCount++
    }
  }

  return { features, frame, flatCount, failedCount, totalCount: attrs.length }
}

/** [[minX, minY, minZ], [maxX, maxY, maxZ]] over features, or null. */
export function featureBounds3d(features) {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const f of features) {
    eachTuple(f.coordinates, (t) => {
      for (let i = 0; i < 3; i++) {
        if (t[i] < min[i]) min[i] = t[i]
        if (t[i] > max[i]) max[i] = t[i]
      }
    })
  }
  return Number.isFinite(min[0]) ? [min, max] : null
}

// --- OBJ object names -> nodes -----------------------------------------------

// Same comparison as the "Tolerant" mode of the QGIS/Blender/CloudCompare
// links: case and runs of whitespace don't count.
function looseKey(text) {
  const k = String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
  return k || null
}

/** Lookup table for matchObjectName: loose label (and id) -> node ids. */
export function buildNameIndex(graph) {
  const byLabel = new Map()
  for (const [id, nd] of Object.entries(graph?.nodes || {})) {
    const k = looseKey(nd.l)
    if (!k) continue
    if (!byLabel.has(k)) byLabel.set(k, [])
    byLabel.get(k).push(id)
  }
  return { byLabel, nodes: graph?.nodes || {} }
}

/**
 * Which node an OBJ object stands for. Tries the name as a node label, then
 * as a node id, then without Blender's duplicate suffix ("SU1001.001").
 * Returns { nodeId, ambiguous } -- ambiguous when several nodes share that
 * label (the first one is taken, the view reports how often that happened)
 * -- or null if nothing matches.
 */
export function matchObjectName(index, name) {
  const raw = String(name ?? '').trim()
  if (!raw) return null
  const candidates = [raw]
  const stripped = raw.replace(/\.\d{3}$/, '')
  if (stripped !== raw) candidates.push(stripped)
  for (const c of candidates) {
    const ids = index.byLabel.get(looseKey(c))
    if (ids?.length) return { nodeId: ids[0], ambiguous: ids.length > 1 }
    if (index.nodes[c]) return { nodeId: c, ambiguous: false }
  }
  return null
}

/**
 * An OBJ has no CRS, but exporters often say in a header comment where its
 * origin is ("x = metres east of E 605211, -z = metres north of N 5339827").
 * Reads "E <number>" and "N <number>" from the leading comment lines and
 * returns { e, n }, or null unless both are there -- half an origin would put
 * the model somewhere plausible-looking but wrong.
 */
export function parseOriginHint(objText) {
  const comments = []
  for (const line of String(objText || '').split(/\r?\n/, 200)) {
    const t = line.trim()
    if (!t) continue
    if (!t.startsWith('#')) break
    comments.push(t)
  }
  const text = comments.join('\n')
  const num = '(-?\\d+(?:\\.\\d+)?)'
  const e = new RegExp('\\bE\\s*[:=]?\\s*' + num).exec(text)
  const n = new RegExp('\\bN\\s*[:=]?\\s*' + num).exec(text)
  if (!e || !n) return null
  return { e: Number(e[1]), n: Number(n[1]) }
}
