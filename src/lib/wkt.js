// Minimal WKT (Well-Known Text) parser -- handles the geometry types
// commonly produced by GIS exports: POINT, LINESTRING, POLYGON,
// MULTIPOINT, MULTILINESTRING, MULTIPOLYGON, with an optional Z/M/ZM
// dimensionality marker ("MultiPolygon Z (((...". Z/M ordinates are
// parsed but dropped -- the map only needs [x, y].
//
// Output uses GeoJSON-shaped { type, coordinates } so downstream code
// (Leaflet rendering) can use the same coordinate-array conventions.

const WKT_TYPE_RE = /^\s*(POINT|LINESTRING|POLYGON|MULTIPOINT|MULTILINESTRING|MULTIPOLYGON)\s*(Z|M|ZM)?\s*\(/i
const WKT_FULL_RE = /^\s*([A-Za-z]+)\s*(?:Z|M|ZM)?\s*\(([\s\S]*)\)\s*$/i

// A geometry value has to be ONE complete expression: the parenthesis opened
// after the type name must close at the very end. Without this, a value that
// merely BEGINS with a geometry -- "POINT(1 2) · POINT(3 4)" as it arises when
// collapsing a node type merges several geometries into one field, or a
// trailing remark after the coordinates -- would silently be read as its first
// geometry alone and put the node on the map at a position that is only half
// the truth. Dropping it is the honest answer; the raw value stays visible in
// the Explorer either way.
function isSingleExpression(s) {
  const open = s.indexOf('(')
  if (open < 0) return false
  let depth = 0
  for (let i = open; i < s.length; i++) {
    const c = s[i]
    if (c === '(') depth++
    else if (c === ')' && --depth === 0) return s.slice(i + 1).trim() === ''
  }
  return false
}

export function looksLikeWkt(value) {
  return typeof value === 'string' && WKT_TYPE_RE.test(value) && isSingleExpression(value)
}

function splitTopLevel(str) {
  const parts = []
  let depth = 0
  let start = 0
  for (let i = 0; i < str.length; i++) {
    const c = str[i]
    if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === ',' && depth === 0) {
      parts.push(str.slice(start, i))
      start = i + 1
    }
  }
  parts.push(str.slice(start))
  return parts
}

function parseCoordList(str) {
  return str
    .trim()
    .split(',')
    .map((pair) => {
      const nums = pair.trim().split(/\s+/).map(Number)
      return [nums[0], nums[1]] // drop Z/M
    })
}

function parseNested(str) {
  str = str.trim()
  if (!str.includes('(')) return parseCoordList(str)
  return splitTopLevel(str).map((g) => {
    g = g.trim()
    if (g.startsWith('(') && g.endsWith(')')) return parseNested(g.slice(1, -1))
    return parseCoordList(g)
  })
}

/** Parse a WKT string into { type, coordinates } (GeoJSON coordinate shape), or null if unrecognised. */
export function parseWkt(wkt) {
  const m = WKT_FULL_RE.exec(wkt)
  if (!m) return null
  const type = m[1].toUpperCase()
  const body = m[2]

  switch (type) {
    case 'POINT': {
      const [pt] = parseCoordList(body)
      return pt ? { type: 'Point', coordinates: pt } : null
    }
    case 'LINESTRING':
      return { type: 'LineString', coordinates: parseCoordList(body) }
    case 'POLYGON':
      return { type: 'Polygon', coordinates: parseNested(body) }
    case 'MULTIPOINT': {
      const nested = parseNested(body)
      // Accepts both "MULTIPOINT (1 2, 3 4)" and "MULTIPOINT ((1 2), (3 4))"
      const coords = nested.map((item) => (Array.isArray(item[0]) ? item[0] : item))
      return { type: 'MultiPoint', coordinates: coords }
    }
    case 'MULTILINESTRING':
      return { type: 'MultiLineString', coordinates: parseNested(body) }
    case 'MULTIPOLYGON':
      return { type: 'MultiPolygon', coordinates: parseNested(body) }
    default:
      return null
  }
}
