// Ported 1:1 from graph-explorer.html's schema derivation + label helpers.

// One palette for everything that is coloured by category: node types, map
// layers, chart and timeline categories. Ordered so that neighbours differ in
// hue -- the first entries go to the most frequent types, so they must be the
// easiest to tell apart. Three rounds of the same eight hue families: medium,
// light, dark.
export const PALETTE = [
  '#5b8fd1', '#f0a04b', '#6cb27a', '#d9707a', '#9a85cf', '#e6c84f', '#4fb0b0', '#c98a5e',
  '#8fbce6', '#f5c38e', '#a9d39a', '#eaa3ad', '#c3b5e6', '#d8d27a', '#93d1cf', '#b9a58c',
  '#3f7cad', '#c76f3b', '#4e8f5e', '#8c6bb1',
]

/**
 * Type colours from the palette, most frequent type first (ties by key, so
 * the same file always gets the same colours). Colours a producer embedded in
 * the file (e.g. the CIDOC CRM colours of an OntoCartographer Studio export)
 * are deliberately not used: they give most types of a CIDOC graph the same
 * brown or blue.
 */
export function paletteTypeColors(nodeTypes) {
  const types = Object.keys(nodeTypes || {})
    .sort((a, b) => (nodeTypes[b] || 0) - (nodeTypes[a] || 0) || (a < b ? -1 : a > b ? 1 : 0))
  const colors = {}
  types.forEach((t, i) => { colors[t] = PALETTE[i % PALETTE.length] })
  return colors
}

/**
 * The loaded graph with palette type colours written into its schema. Done
 * once at load time, not on every derivation: collapsing types recounts
 * node_types, and colours handed out by count would then shift under the
 * user's eyes. The collapse carries schema.typeColors over, so they stay put.
 */
export function withPaletteColors(graph) {
  const schema = graph.schema ? { ...graph.schema } : deriveSchema(graph)
  return { ...graph, schema: { ...schema, typeColors: paletteTypeColors(graph.node_types) } }
}

function humaniseUri(uri) {
  // Only strip a namespace when the key actually looks like a URI. A plain
  // display label that merely happens to contain "/" (e.g. a type key
  // "Straße/Ω" in a schema-less, externally produced graph) must NOT be
  // truncated to its last path segment.
  const looksLikeUri = /:\/\//.test(uri) || uri.includes('#')
  const local = looksLikeUri
    ? (uri.includes('#') ? uri.split('#').pop() : uri.split('/').pop())
    : uri
  return local.replace(/_/g, ' ')
}

export function deriveSchema(graph) {
  // If OntoCartographer Studio embedded a schema, use it (with fallbacks)
  if (graph.schema) {
    const s = graph.schema
    return {
      typeColors: s.typeColors || {},
      typeLabels: s.typeLabels || {},
      edgeLabels: s.edgeLabels || {},
      mainAttrs: s.mainAttrs || {},
    }
  }

  const typeColors = paletteTypeColors(graph.node_types)
  const typeLabels = {}
  Object.keys(graph.node_types || {}).forEach((t) => {
    typeLabels[t] = humaniseUri(t)
  })

  const edgeLabels = {}
  Object.keys(graph.edge_types || {}).forEach((e) => {
    edgeLabels[e] = humaniseUri(e)
  })

  return { typeColors, typeLabels, edgeLabels, mainAttrs: {} }
}

export function typeColor(schema, type) {
  return schema?.typeColors?.[type] || '#9c9178'
}

/** A color the user gave to this ONE node, or null. Kept separate from
    nodeColor() for the places whose default isn't the type color (the map
    colors by layer, which may be a category rather than a type). */
export function nodeColorOverride(schema, id) {
  return (id != null && schema?.nodeColors?.[id]) || null
}

/** The color a concrete node is drawn in: its own, if it was given one,
    otherwise its type's. Not every dot belongs to a single node -- a legend
    or a type bar stays on typeColor(). */
export function nodeColor(schema, id, type) {
  return nodeColorOverride(schema, id) || typeColor(schema, type)
}

function hexToRgb(hex) {
  const h = hex.replace('#', '')
  const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const num = parseInt(n, 16)
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255]
}

// Light colours (the palette's lighter round, or a pale colour the user picked)
// are fine as a small dot or fill
// swatch, but unreadable as literal text color against the light theme's
// white/near-white panels. Darken only the ones that need it, keeping the
// same hue so each type still reads as its own distinct color.
export function readableTextColor(hex) {
  if (!hex || !hex.startsWith('#')) return hex
  try {
    const [r, g, b] = hexToRgb(hex)
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
    if (luminance < 0.62) return hex
    const factor = 0.45
    return `rgb(${Math.round(r * factor)}, ${Math.round(g * factor)}, ${Math.round(b * factor)})`
  } catch {
    return hex
  }
}
export function typeLabel(schema, type) {
  return schema?.typeLabels?.[type] || type
}
export function edgeLabel(schema, etype) {
  return schema?.edgeLabels?.[etype] || etype
}

export function humaniseKey(k) {
  return k.replace(/^(crm:|rdfs:|rdf:|skos:)/, '').replace(/_/g, ' ')
}

export function fmt(n) {
  return n != null ? String(n) : '–'
}
