// timelineLanes.js
//
// Swimlane grouping for the Zeitstrahl: one lane per value of a chosen
// property. Every find of SE 2001 in the first lane, every find of SE 2002 in
// the second, and so on -- which turns the timeline from a heap of bars into a
// comparison: how does the dating of one stratigraphic unit sit against the
// next one's?
//
// A lane value comes from the SAME property list the Charts tab offers
// (lib/chartData.js): edges grouped by the label of the node they lead to, and
// literal attributes grouped by their value, in ONE list. The property wanted
// here is usually an edge -- a find's SE, its material, its type are all
// relations, not literals -- so a grouping over attributes alone would miss
// exactly the case this exists for.
//
// This module decides WHICH events belong to which lane, not how they are
// drawn. Inside a lane the timeline tab stacks them into as many sub-rows as
// it takes to keep them from overlapping: two datings printed on top of each
// other cannot be told apart, and a lane that shows nothing is worth no rows
// at all.
//
// Pure and UI-free like the rest of lib/ -- see tests/fixtures/run-lib-checks.mjs.

import { typeLabel } from './schema'
import { listChartProperties, dimForProperty, groupAndCount, sortBuckets, NO_VALUE } from './chartData'

/** Most lanes a grouping may produce. Generous on purpose: 86 stratigraphic
    units are 86 readable lanes, they just scroll -- unlike 86 bars in a chart,
    which would not. */
export const MAX_LANES = 200

export const LANE_SORTS = [
  { id: 'label', label: 'label' },
  { id: 'count', label: 'count' },
  { id: 'time', label: 'time' },
]

/**
 * The groupings offered for the rows: none, node type, then every property of
 * the dated nodes that can actually carry rows.
 *   { id, kind: 'none'|'type'|'connection'|'attr', label, key?, values, prop? }
 * `id` is the Charts tab's stable `c:`/`a:` handle, so an edge and an attribute
 * of the same name stay distinguishable.
 */
export function getLaneOptions(graph, events, schema) {
  const options = [{ id: '', kind: 'none', label: 'No grouping' }]
  if (!graph || !events || !events.length) return options

  const types = new Set(events.map((e) => e.type))
  if (types.size > 1) options.push({ id: 'type', kind: 'type', label: 'Node type', values: types.size })

  for (const p of listChartProperties(graph, events.map((e) => e.nodeId), schema)) {
    // One row for everything groups nothing; one row per node is just the
    // ungrouped view with extra captions. Both are left out, as is anything
    // beyond what a screen can still be scrolled through.
    if (p.distinct < 2 || p.distinct > MAX_LANES) continue
    if (p.poorGrouping || p.distinct >= p.coverage) continue
    options.push({ id: p.id, kind: p.kind, key: p.key, label: p.label, values: p.distinct, coverage: p.coverage, prop: p })
  }
  return options
}

/**
 * The rows to draw: [{ key, label, count, events }] -- events sorted
 * chronologically within each row, rows ordered by `sortMode`
 * ('label' | 'count' | 'time'). A node with several values for the property
 * (a find recorded in two units) appears in every row it belongs to, and one
 * row collects everything without a value.
 */
export function buildLanes(graph, events, option, sortMode = 'label', schema = null) {
  if (!option || option.kind === 'none' || !events.length) {
    return [{ key: '', label: '', count: events.length, events }]
  }
  const byId = new Map(events.map((e) => [e.nodeId, e]))
  const bucketSort = sortMode === 'count' ? 'count' : 'label'

  let rows
  if (option.kind === 'type') {
    const m = new Map()
    for (const e of events) {
      let r = m.get(e.type)
      if (!r) m.set(e.type, (r = { key: e.type, label: typeLabel(schema, e.type) || NO_VALUE, ids: [] }))
      r.ids.push(e.nodeId)
    }
    rows = sortBuckets([...m.values()].map((r) => ({ ...r, count: r.ids.length })), bucketSort)
  } else {
    // No date bucketing for lanes: a row is a value, and the Zeitstrahl's own
    // axis is where time belongs.
    rows = groupAndCount(graph, [...byId.keys()], dimForProperty(option.prop, ''), { sort: bucketSort })
  }

  const lanes = rows.map((r) => ({
    key: r.key ?? r.label,
    label: r.label,
    count: r.count,
    events: r.ids
      .map((id) => byId.get(id))
      .filter(Boolean)
      .sort((a, b) => a.start - b.start || a.end - b.end),
  }))

  if (sortMode === 'time') {
    // Earliest row first -- reads like a seriation, and puts the rows whose
    // dating actually differs next to each other.
    lanes.sort((a, b) => {
      const na = a.label === NO_VALUE, nb = b.label === NO_VALUE
      if (na !== nb) return na ? 1 : -1
      return (a.events[0]?.start ?? Infinity) - (b.events[0]?.start ?? Infinity)
    })
  }
  return lanes
}
