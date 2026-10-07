// Compact summary of a node for the hover quick-info card: the same material
// the Explorer's detail view shows, cut down to what fits in a small floating
// card that can't be scrolled.
//
// Pure and UI-free like the rest of lib/ -- see
// tests/fixtures/run-node-preview-check.mjs.

import { isImageKey, isImageUrl, isUrl } from './links'

export const MAX_ATTRS = 6
export const MAX_CONN_GROUPS = 5
export const MAX_CONN_SAMPLE = 3
export const MAX_VALUE_LEN = 70

// Attribute keys in display order: the type's mainAttrs first, in the order
// the schema gives them (which already carries the user's saved override),
// then everything else alphabetically. Shared with the Explorer's detail view
// so the card and the full view can't drift apart on what comes first.
export function orderedAttrKeys(schema, nd) {
  const attrs = nd?.a || {}
  const nonEmpty = Object.keys(attrs).filter((k) => attrs[k] != null && attrs[k] !== '')
  const main = schema?.mainAttrs?.[nd?.t] || []
  const out = []
  const seen = new Set()
  main.forEach((k) => {
    if (nonEmpty.includes(k) && !seen.has(k)) {
      out.push(k)
      seen.add(k)
    }
  })
  nonEmpty
    .slice()
    .sort()
    .forEach((k) => {
      if (!seen.has(k)) {
        out.push(k)
        seen.add(k)
      }
    })
  return out
}

export function truncate(value, max = MAX_VALUE_LEN) {
  const s = String(value).replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s
}

// The one image worth putting in the card, using the same signals as the
// detail view: the node id IS an image URL, or an attribute holds one, or an
// attribute is named like an image and at least holds a URL.
function previewImage(nodeId, nd) {
  if (isImageUrl(nodeId)) return nodeId
  for (const [k, v] of Object.entries(nd.a || {})) {
    if (isImageUrl(v) || (isImageKey(k) && isUrl(v))) return String(v)
  }
  return null
}

// Connection groups in the detail view's order: the user's saved per-type
// order first, then outgoing before incoming, each alphabetical by label.
function orderedConnGroups(nd, connOrder) {
  const groups = [
    ...Object.entries(nd.o || {}).map(([etype, ids]) => ({ key: 'o:' + etype, etype, dir: 'o', ids })),
    ...Object.entries(nd.i || {}).map(([etype, ids]) => ({ key: 'i:' + etype, etype, dir: 'i', ids })),
  ]
  const saved = connOrder || []
  const seen = new Set()
  const out = []
  saved.forEach((key) => {
    const g = groups.find((x) => x.key === key)
    if (g && !seen.has(key)) {
      out.push(g)
      seen.add(key)
    }
  })
  groups
    .filter((g) => !seen.has(g.key))
    .sort((a, b) => (a.dir === b.dir ? a.etype.localeCompare(b.etype) : a.dir === 'o' ? -1 : 1))
    .forEach((g) => out.push(g))
  return out
}

/**
 * Everything the hover card renders, or null if the id isn't in the graph
 * (adjacency can name a node the graph doesn't carry).
 *
 * `connOrder` is the user's saved connection order for this node's type
 * (prefs.connOrder[type]); passing it keeps the card consistent with the
 * detail view, leaving it out just falls back to the default order.
 */
export function buildNodePreview(graph, schema, nodeId, { connOrder } = {}) {
  const nd = graph?.nodes?.[nodeId]
  if (!nd) return null

  const image = previewImage(nodeId, nd)
  // The image is rendered as a thumbnail, so repeating its URL as a text row
  // would only take up space the card doesn't have.
  const keys = orderedAttrKeys(schema, nd).filter((k) => String(nd.a[k]) !== image)

  const groups = orderedConnGroups(nd, connOrder)
  const totalConnections = groups.reduce((sum, g) => sum + g.ids.length, 0)

  return {
    id: nodeId,
    label: nd.l ?? nodeId,
    type: nd.t,
    attrs: keys.slice(0, MAX_ATTRS).map((k) => ({ key: k, value: truncate(nd.a[k]) })),
    moreAttrs: Math.max(0, keys.length - MAX_ATTRS),
    image,
    connections: groups.slice(0, MAX_CONN_GROUPS).map((g) => ({
      etype: g.etype,
      dir: g.dir,
      count: g.ids.length,
      sample: g.ids.slice(0, MAX_CONN_SAMPLE).map((id) => graph.nodes[id]?.l ?? id),
    })),
    moreConnections: Math.max(0, groups.length - MAX_CONN_GROUPS),
    totalConnections,
  }
}
