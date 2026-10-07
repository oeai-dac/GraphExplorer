import { connectedIds } from './filters'
import { edgeLabel, humaniseKey, PALETTE } from './schema'
import { formatYear, isTemporalValue, parseTemporal } from './temporal'

export const NO_VALUE = '(no value)'

// For categories that get no color of their own: the nodes without a value,
// and everything past the palette. Light enough for the dark box label.
export const NEUTRAL_CATEGORY_COLOR = '#cfd8db'

// How many values of an attribute to look at before deciding whether it is a
// date property. Enough to be sure, cheap enough to run over every attribute
// of a large graph.
const TEMPORAL_SAMPLE = 200
// Share of sampled values that must parse as dates. Not 100%, because real
// datasets carry the odd "unbekannt" or typo in an otherwise clean date field.
const TEMPORAL_SHARE = 0.6

// Past this many distinct values, counting stops: a property with 2000
// categories cannot produce a readable chart whatever the exact number is, so
// the precise figure has no use and paying for it would be waste. Reaching
// the cap is itself the answer, which is why `distinctCapped` is reported --
// treating a capped count as if it were exact once put a property with 2541
// distinct values on top of the list as "well groupable".
const DISTINCT_CAP = 2000
// A property with nearly one value per node -- a WKT geometry, an inventory
// number, a per-object material instance -- produces a chart of one-high
// bars. It stays selectable (someone may want exactly that), but it sinks to
// the bottom of the list and the UI warns before it is charted.
const NEAR_UNIQUE_MIN = 20
const NEAR_UNIQUE_SHARE = 0.9

/** Date granularities offered for date-like properties. Grouping raw date
    strings is close to useless -- "1989-07-14" and "1989-07-15" become two
    categories of one -- so anything recognised as a date defaults to being
    bucketed instead. */
export const DATE_BUCKETS = [
  { key: 'year', label: 'per year' },
  { key: 'decade', label: 'per decade' },
  { key: 'century', label: 'per century' },
  { key: '', label: 'single values' },
]

export const DEFAULT_DATE_BUCKET = 'decade'

const BUCKET_SIZE = { year: 1, decade: 10, century: 100 }

const NO_VALUE_BUCKET = { label: NO_VALUE, key: NO_VALUE }

// ── the property list behind the group-by picker ────────────────────────────

/**
 * Every property the given nodes actually use, as ONE list: edges (grouped by
 * the label of the node they lead to) and literal attributes (grouped by the
 * value itself), side by side.
 *
 * They are deliberately not separated in the UI: in RDF both ARE properties,
 * one with a resource as its object and one with a literal. The split into
 * `o`/`i` and `a` is an artifact of this app's storage format, not a
 * distinction a user should have to make before they can pick anything.
 *
 * Sorted by coverage, so the properties that actually say something about the
 * nodes in scope come first, and a property that only two nodes carry doesn't
 * sit at the top just because its name starts with "A".
 *
 * Returns [{ id, kind, key, label, coverage, distinct, nearUnique, temporal }],
 * where `id` is a stable `c:`/`a:` prefixed handle -- an edge and an attribute
 * are allowed to share a name (the real CIDOC data has "P3 has note" as both),
 * so the kind has to be part of the identity.
 */
export function listChartProperties(graph, ids, schema) {
  const connCount = new Map()
  const connValues = new Map()
  const attrCount = new Map()
  const attrValues = new Map()
  const attrSamples = new Map()

  const track = (map, key, value) => {
    let set = map.get(key)
    if (!set) map.set(key, (set = new Set()))
    if (set.size < DISTINCT_CAP) set.add(value)
  }

  for (const id of ids) {
    const nd = graph?.nodes?.[id]
    if (!nd) continue

    // Per node, count a property once even when it has both an outgoing and
    // an incoming edge of that name -- coverage means "how many nodes have
    // this property at all".
    const seen = new Set()
    for (const [k, arr] of Object.entries(nd.o || {})) if (arr?.length) seen.add(k)
    for (const [k, arr] of Object.entries(nd.i || {})) if (arr?.length) seen.add(k)
    for (const k of seen) {
      connCount.set(k, (connCount.get(k) || 0) + 1)
      for (const tid of connectedIds(nd, k)) {
        const l = graph.nodes[tid]?.l
        if (l) track(connValues, k, l)
      }
    }

    for (const [k, v] of Object.entries(nd.a || {})) {
      if (v == null || v === '') continue
      attrCount.set(k, (attrCount.get(k) || 0) + 1)
      track(attrValues, k, String(v))
      const sample = attrSamples.get(k)
      if (!sample) attrSamples.set(k, [v])
      else if (sample.length < TEMPORAL_SAMPLE) sample.push(v)
    }
  }

  const entry = (id, kind, key, label, coverage, distinct, temporal) => {
    const distinctCapped = distinct >= DISTINCT_CAP
    return {
      id, kind, key, label, coverage, distinct, distinctCapped, temporal,
      // Two ways to be unchartable: a value per node, or simply more
      // categories than any chart can show.
      poorGrouping: distinctCapped || (coverage >= NEAR_UNIQUE_MIN && distinct >= coverage * NEAR_UNIQUE_SHARE),
    }
  }

  const out = []
  for (const [key, coverage] of connCount) {
    out.push(entry('c:' + key, 'connection', key, edgeLabel(schema, key), coverage, connValues.get(key)?.size || 0, false))
  }
  for (const [key, coverage] of attrCount) {
    out.push(entry('a:' + key, 'attr', key, humaniseKey(key), coverage, attrValues.get(key)?.size || 0,
      looksTemporal(key, attrSamples.get(key))))
  }

  // Coverage decides the order, except that properties which can't produce a
  // readable chart sink below the ones that can -- otherwise a WKT geometry
  // column sits near the top purely because every node has one. A date
  // property is exempt: bucketing turns its unique values into real
  // categories.
  const sinks = (p) => p.poorGrouping && !p.temporal
  return out.sort((a, b) => (sinks(a) ? 1 : 0) - (sinks(b) ? 1 : 0) || b.coverage - a.coverage || a.label.localeCompare(b.label))
}

// A property is treated as dates only when most of its values parse as such
// by the Zeitstrahl's own rule -- so an inventory number that happens to read
// like a year doesn't grow a Jahr/Jahrzehnt/Jahrhundert selector.
function looksTemporal(key, samples) {
  if (!samples?.length) return false
  let hits = 0
  for (const v of samples) if (isTemporalValue(v, key)) hits++
  return hits / samples.length >= TEMPORAL_SHARE
}

/** The dimension a picked property stands for.
    dim: { kind: 'connection', key } | { kind: 'attr', key, bucket } */
export function dimForProperty(prop, bucket) {
  if (!prop) return null
  if (prop.kind === 'connection') return { kind: 'connection', key: prop.key }
  return { kind: 'attr', key: prop.key, bucket: prop.temporal ? bucket || '' : '' }
}

// ── grouping ────────────────────────────────────────────────────────────────

function dateBucket(value, key, bucket) {
  const iv = parseTemporal(value)
  if (!iv || !isTemporalValue(value, key)) return NO_VALUE_BUCKET
  const size = BUCKET_SIZE[bucket] || 1
  // Math.floor, not truncation: -1985 belongs to the decade starting -1990,
  // not -1980.
  const start = Math.floor(Math.round(iv.start) / size) * size
  const label = size === 1 ? formatYear(start) : `${formatYear(start)}–${formatYear(start + size - 1)}`
  // `sort` carries the raw year so a "by category" sort reads chronologically
  // instead of alphabetically, where "800 v. Chr." would land after "1500".
  return { label, key: String(start), sort: start }
}

/** The value(s) a single node contributes for a dimension. A node can
    contribute several (a Fund recorded with two materials shows up under
    both) -- callers count it once per value, which is the deliberate
    "counted in each bucket it belongs to" behavior below. */
function valuesForDim(graph, nd, dim) {
  if (dim.kind === 'connection') {
    const labels = [...new Set(connectedIds(nd, dim.key).map((tid) => graph.nodes[tid]?.l).filter(Boolean))]
    return labels.length ? labels.map((l) => ({ label: l, key: l })) : [NO_VALUE_BUCKET]
  }
  if (dim.kind === 'attr') {
    const v = nd.a?.[dim.key]
    if (v == null || v === '') return [NO_VALUE_BUCKET]
    if (dim.bucket) return [dateBucket(v, dim.key, dim.bucket)]
    const label = String(v)
    return [{ label, key: label }]
  }
  return [NO_VALUE_BUCKET]
}

/**
 * Order buckets either by size ('count', the default -- "what is there most
 * of?") or by the category itself ('label'), which is what makes a date axis
 * read chronologically rather than by popularity. Date buckets carry a
 * numeric `sort`, which wins over their text; everything else compares
 * naturally, so "SE 2" precedes "SE 10". "(kein Wert)" always goes last: it
 * isn't a category, it's the absence of one.
 */
export function sortBuckets(rows, mode) {
  if (mode !== 'label') {
    return rows.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
  }
  return rows.sort((a, b) => {
    if (a.label === NO_VALUE) return b.label === NO_VALUE ? 0 : 1
    if (b.label === NO_VALUE) return -1
    if (a.sort != null && b.sort != null) return a.sort - b.sort
    return a.label.localeCompare(b.label, undefined, { numeric: true })
  })
}

/** Groups `ids` by one dimension and counts them. Nodes with no value land in
    a "(kein Wert)" bucket instead of being silently dropped. Returns
    [{ label, key, sort, count, ids }]. */
export function groupAndCount(graph, ids, groupBy, opts = {}) {
  const buckets = new Map() // label -> { key, sort, ids: Set }
  for (const id of ids) {
    const nd = graph.nodes[id]
    if (!nd) continue
    for (const { label, key, sort } of valuesForDim(graph, nd, groupBy)) {
      if (!buckets.has(label)) buckets.set(label, { key, sort, ids: new Set() })
      buckets.get(label).ids.add(id)
    }
  }
  const rows = [...buckets.entries()].map(([label, b]) => ({
    label, key: b.key, sort: b.sort, count: b.ids.size, ids: [...b.ids],
  }))
  return sortBuckets(rows, opts.sort)
}

/**
 * Turn grouped categories into colors: one color per category, and from that
 * one color per node -- what "color the units by their interpretation" needs.
 *
 * `rows` is groupAndCount()'s result, biggest category first. Two deliberate
 * rules:
 *
 *  * Only the first PALETTE.length categories get a color of their own.
 *    Cycling the palette would give two categories the SAME color, and a
 *    legend that says two different things about one color is worse than
 *    admitting that the long tail isn't distinguishable. Those, and the
 *    "(kein Wert)" group, come back marked `plain` so the UI can fold them
 *    into a single legend entry.
 *  * A node that carries several values (a unit with two interpretations)
 *    is counted in every bucket but can only be drawn in one color -- it
 *    gets its LARGEST category's, which is simply the first row it appears
 *    in. Deterministic, and it keeps the biggest groups visually intact.
 *
 * Returns { legend: [...rows, { color, plain }], colorOf(id), plainCount },
 * where `plainCount` counts NODES drawn neutral -- not the sum of the plain
 * categories' counts, which double-counts every multi-valued node and can
 * exceed the number of nodes altogether.
 */
export function assignCategoryColors(rows) {
  const byId = new Map()
  let used = 0
  const legend = rows.map((row) => {
    const plain = row.label === NO_VALUE || used >= PALETTE.length
    const color = plain ? NEUTRAL_CATEGORY_COLOR : PALETTE[used++]
    for (const id of row.ids || []) if (!byId.has(id)) byId.set(id, color)
    return { ...row, color, plain }
  })
  let plainCount = 0
  for (const c of byId.values()) if (c === NEUTRAL_CATEGORY_COLOR) plainCount++
  return { legend, plainCount, colorOf: (id) => byId.get(id) || NEUTRAL_CATEGORY_COLOR }
}

/**
 * Cross-tabulates `ids` by TWO dimensions -- a node contributes to every
 * (row value, column value) pair among its own values (a Fund found in SE2001
 * with materials Bronze and Iron lands in both (SE2001, Bronze) and
 * (SE2001, Iron)).
 *
 * Row and column totals count unique nodes, not the sum of their cells: a
 * node counted in two cells of the same row still counts once for that row.
 */
export function pivotCount(graph, ids, rowBy, colBy, opts = {}) {
  const cellIds = new Map() // "row col" -> Set(ids)
  const rowIdSets = new Map()
  const colIdSets = new Map()
  const rowSort = new Map()
  const colSort = new Map()

  for (const id of ids) {
    const nd = graph.nodes[id]
    if (!nd) continue
    const rows = valuesForDim(graph, nd, rowBy)
    const cols = valuesForDim(graph, nd, colBy)
    for (const { label: r, sort: rs } of rows) {
      if (rs != null) rowSort.set(r, rs)
      if (!rowIdSets.has(r)) rowIdSets.set(r, new Set())
      rowIdSets.get(r).add(id)
      for (const { label: c, sort: cs } of cols) {
        if (cs != null) colSort.set(c, cs)
        if (!colIdSets.has(c)) colIdSets.set(c, new Set())
        colIdSets.get(c).add(id)
        const k = r + ' ' + c
        if (!cellIds.has(k)) cellIds.set(k, new Set())
        cellIds.get(k).add(id)
      }
    }
  }

  // Reuses the bar chart's ordering so both views answer "by size" or "by
  // category" the same way.
  const order = (sets, sorts) =>
    sortBuckets(
      [...sets.entries()].map(([label, set]) => ({ label, count: set.size, sort: sorts.get(label) })),
      opts.sort
    ).map((r) => r.label)

  return {
    rowLabels: order(rowIdSets, rowSort),
    colLabels: order(colIdSets, colSort),
    getCell: (r, c) => cellIds.get(r + ' ' + c)?.size || 0,
    getCellIds: (r, c) => [...(cellIds.get(r + ' ' + c) || [])],
    rowTotal: (r) => rowIdSets.get(r)?.size || 0,
    colTotal: (c) => colIdSets.get(c)?.size || 0,
    grandTotal: ids.length,
  }
}

/**
 * Re-expresses one chart category as an Explorer filter condition, so
 * clicking a bar or a cell lands on exactly the nodes it counted.
 *
 * A bucketed date needs the concrete values rather than a range: the raw
 * strings can be written any number of ways ("1989-07-14", "14.07.1989",
 * "um 1989"), and a range comparison over those would quietly return the
 * wrong nodes. `bucketIds` are the ids the bucket counted, from which the
 * literal values are read back.
 */
export function conditionForCategory(graph, dim, label, bucketIds) {
  if (label === NO_VALUE) return null // "no value" has no positive equivalent
  if (dim.kind === 'connection') return { kind: 'connection', propKey: dim.key, matchLabels: [label] }
  if (dim.kind !== 'attr') return null
  if (!dim.bucket) return { kind: 'attr', key: dim.key, op: 'equals', value: label }

  const values = new Set()
  for (const id of bucketIds || []) {
    const v = graph.nodes[id]?.a?.[dim.key]
    if (v != null && v !== '') values.add(String(v))
  }
  if (!values.size) return null
  return { kind: 'attr', key: dim.key, op: 'in', values: [...values] }
}
