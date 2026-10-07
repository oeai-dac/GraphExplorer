// Structured filtering shared between the Explorer tab's advanced filter
// panel and the Charts tab's scope filter + group-by picker -- both are
// the same underlying idea (pick a property, pick/derive a value per
// node), so one engine serves both instead of duplicating the logic.
//
// Condition shapes (AND-combined across the conditions array; each
// condition's own multi-value list, where present, is OR-combined):
//   { kind: 'idLabel',    field: 'id'|'label', op: 'contains'|'equals'|'between'|'in', value, valueTo, values }
//   { kind: 'attr',       key, op: 'contains'|'equals'|'between'|'in', value, valueTo, values }
//   { kind: 'connection', propKey, matchLabels: string[] }

/** Natural-order comparison: splits into digit/non-digit chunks and
    compares numeric chunks as numbers, text chunks as strings. Lets a
    "between" filter on ids/labels like "SE2".."SE10" work correctly
    without any prefix-parsing special-casing -- plain string comparison
    would put "SE10" before "SE2". */
export function naturalCompare(a, b) {
  const re = /(\d+)|(\D+)/g
  const chunksA = String(a).match(re) || []
  const chunksB = String(b).match(re) || []
  const len = Math.max(chunksA.length, chunksB.length)
  for (let i = 0; i < len; i++) {
    const ca = chunksA[i] ?? ''
    const cb = chunksB[i] ?? ''
    const na = /^\d+$/.test(ca) ? parseInt(ca, 10) : null
    const nb = /^\d+$/.test(cb) ? parseInt(cb, 10) : null
    if (na != null && nb != null) {
      if (na !== nb) return na - nb
    } else {
      const cmp = ca.localeCompare(cb)
      if (cmp !== 0) return cmp
    }
  }
  return 0
}

function matchTextOrRange(value, c) {
  if (c.op === 'in') return (c.values || []).some((v) => value.toLowerCase() === String(v).toLowerCase())
  if (c.op === 'between') {
    if (c.value && naturalCompare(value, c.value) < 0) return false
    if (c.valueTo && naturalCompare(value, c.valueTo) > 0) return false
    return true
  }
  if (c.op === 'equals') return value.toLowerCase() === String(c.value || '').toLowerCase()
  return value.toLowerCase().includes(String(c.value || '').toLowerCase())
}

/** Ids reachable from `nd` via `propKey`, in either direction -- a filter
    like "Material = Bronze" means "connected via this property", the
    direction (o vs i) is an implementation detail the user shouldn't have
    to think about. Exported for reuse by chartData.js's group-by. */
export function connectedIds(nd, propKey) {
  const out = nd.o?.[propKey] || []
  const inc = nd.i?.[propKey] || []
  return out.length || inc.length ? [...out, ...inc] : []
}

function matchesCondition(graph, nd, id, c) {
  switch (c.kind) {
    case 'idLabel': {
      const value = c.field === 'id' ? id : (nd.l || '')
      return matchTextOrRange(value, c)
    }
    case 'attr': {
      const value = nd.a?.[c.key]
      if (value == null || value === '') return false
      return matchTextOrRange(String(value), c)
    }
    case 'connection': {
      const targets = connectedIds(nd, c.propKey)
      const targetLabels = targets.map((tid) => graph.nodes[tid]?.l)
      // matchLabels is always an array (OR within this one condition) --
      // even a single-value connection condition is just a length-1 array,
      // so there's no separate single/multi code path to keep in sync.
      return (c.matchLabels || []).some((ml) => targetLabels.includes(ml))
    }
    default:
      return true
  }
}

/** Filters `ids` down to those matching every condition (AND-combined). */
export function applyConditions(graph, ids, conditions) {
  if (!conditions || !conditions.length) return ids
  return ids.filter((id) => {
    const nd = graph.nodes[id]
    return nd ? conditions.every((c) => matchesCondition(graph, nd, id, c)) : false
  })
}

/** Distinct labels reachable via `propKey` from any of `ids` -- populates
    a connection condition's value dropdown so the user picks an exact
    existing value instead of free-typing something that might not match. */
export function distinctConnectionTargets(graph, ids, propKey) {
  const labels = new Set()
  for (const id of ids) {
    const nd = graph.nodes[id]
    if (!nd) continue
    for (const tid of connectedIds(nd, propKey)) {
      const l = graph.nodes[tid]?.l
      if (l) labels.add(l)
    }
  }
  return [...labels].sort()
}

/** Distinct values of attribute `key` across `ids`. */
export function distinctAttrValues(graph, ids, key) {
  const values = new Set()
  for (const id of ids) {
    const v = graph.nodes[id]?.a?.[key]
    if (v != null && v !== '') values.add(String(v))
  }
  return [...values].sort()
}
