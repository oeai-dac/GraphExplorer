import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useStore } from '../../store'
import { nodeHoverProps } from '../shared/nodeHover'
import { typeColor, nodeColor, nodeColorOverride, typeLabel, fmt } from '../../lib/schema'
import { buildTimelineEvents, filterEventsByYear, formatYear, getTemporalOptions, niceTicks } from '../../lib/temporal'
import { buildLanes, getLaneOptions, LANE_SORTS } from '../../lib/timelineLanes'
import { assignCategoryColors, dimForProperty, groupAndCount, listChartProperties } from '../../lib/chartData'

// Layout constants (px). Kept small/local -- this tab positions everything
// itself rather than leaning on flex/grid, so it can pack events into lanes.
const AXIS_H = 34   // height reserved at the top for tick labels
const LANE_H = 26   // vertical pitch of one lane
const BAND_HDR_H = 19 // caption above a grouped row
const BAND_GAP = 6    // breathing room between two grouped rows
const DOT_R = 5     // point marker radius
const MIN_BAR_PX = 6
const CHAR_PX = 6.2 // rough label width per character, for lane packing
const LABEL_PAD = 16

// Place one group's events into sub-rows, greedily: an event goes into the
// first sub-row whose content ends before it starts, otherwise a new sub-row
// opens. Nothing is ever drawn on top of anything else -- two datings sitting
// on each other can't be told apart, which is the whole reason to stack them.
//
// What counts as "content" differs by mode, and that is the only difference:
//
//   grouped=false (no grouping): the label counts too, so every event is
//     readable by name -- there is no lane caption to identify it by.
//   grouped=true (swimlanes): only the MARK counts (bar or dot). A label is
//     roughly ten times as wide as the mark it belongs to, so letting it
//     dictate the packing would blow one stratigraphic unit up into dozens of
//     sub-rows and bury the grouping it is supposed to show. Labels are then
//     drawn wherever they still fit (see below); the rest is on hover.
//
// With a year filter set, a span may begin before / end after the visible
// window -- it is clamped to the drawing area rather than spilling out of it.
function placeEvents(events, toPx, innerW, grouped) {
  const rowEnds = [] // px extent currently used per sub-row
  const placed = events.map((e) => {
    const x0 = Math.max(0, toPx(e.start))
    const x1 = Math.min(innerW, toPx(e.end))
    const barW = e.isSpan ? Math.max(x1 - x0, MIN_BAR_PX) : 0
    const labelW = (e.label ? e.label.length : 3) * CHAR_PX + LABEL_PAD
    const inLabel = e.isSpan && barW >= labelW + 10 // label fits inside the bar
    const markStart = e.isSpan ? x0 : x0 - DOT_R
    const markEnd = x0 + (e.isSpan ? barW : DOT_R * 2)
    const claimed = grouped ? markEnd : markEnd + (inLabel ? 0 : labelW)
    let lane = rowEnds.findIndex((end) => markStart >= end + 4)
    if (lane === -1) { lane = rowEnds.length; rowEnds.push(0) }
    rowEnds[lane] = claimed
    return { ...e, x0, barW, labelW, inLabel, lane, markStart, markEnd, showLabel: true }
  })

  // Grouped: a label is shown only where it doesn't reach into the next event
  // of its own sub-row. Walking backwards gives each event the start of that
  // successor in one pass.
  if (grouped) {
    const nextStart = []
    for (let i = placed.length - 1; i >= 0; i--) {
      const p = placed[i]
      const next = nextStart[p.lane]
      p.showLabel = p.inLabel || next == null || p.markEnd + p.labelW + 4 <= next
      nextStart[p.lane] = p.markStart
    }
  }
  return placed
}

// A year bound as typed. Empty stays open; "-320" is 320 BCE.
function parseYear(s) {
  const t = String(s).trim()
  if (!t || !/^-?\d{1,6}$/.test(t)) return null
  return parseInt(t, 10)
}

// Show a search box once a list is longer than this -- below it, scanning is
// faster than typing.
const SEARCH_FROM = 12

// Multi-select over a set of values, used for both the node types and the
// swimlanes. Replaces the former single-choice type dropdown: comparing two of
// five types was impossible with it -- you could look at one or at all of them.
//
// An EMPTY selection means "all": the filter starts out showing everything,
// clearing it is always one click away, and no state can mean "show nothing".
// `items` are { key, label, count, color? }.
function MultiSelect({ items, selected, onChange, allLabel, unit, title }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    const onDown = (ev) => { if (ref.current && !ref.current.contains(ev.target)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const q = query.trim().toLowerCase()
  const shown = q ? items.filter((i) => i.label.toLowerCase().includes(q)) : items
  const label = selected.length ? `${fmt(selected.length)} of ${fmt(items.length)} ${unit}` : allLabel

  const toggle = (key) => onChange(
    selected.includes(key) ? selected.filter((x) => x !== key)
      : selected.length ? [...selected, key]
        // Unticking one while everything is shown: keep the rest.
        : items.map((i) => i.key).filter((k) => k !== key)
  )

  return (
    <span className="tl-multi" ref={ref}>
      <button className="sl tl-multi-btn" onClick={() => setOpen((o) => !o)} title={title}>
        {label} <span className="tl-multi-caret">▾</span>
      </button>
      {open && (
        <div className="tl-multi-panel">
          {items.length >= SEARCH_FROM && (
            <input
              className="sl tl-multi-search" type="search" value={query} autoFocus
              placeholder="Search…" onChange={(e) => setQuery(e.target.value)}
            />
          )}
          <div className="tl-multi-acts">
            <button className="copy-btn" disabled={!selected.length} onClick={() => onChange([])}>Show all</button>
            {/* With a couple of hundred values, ticking eight boxes by hand is
                the slow path -- searching and taking the hits is the fast one. */}
            {q && (
              <button className="copy-btn" disabled={!shown.length} onClick={() => onChange(shown.map((i) => i.key))}>
                Only matches ({fmt(shown.length)})
              </button>
            )}
          </div>
          <div className="tl-multi-list">
            {shown.map((it) => (
              <label key={it.key} className="tl-multi-row">
                <input
                  type="checkbox"
                  checked={!selected.length || selected.includes(it.key)}
                  onChange={() => toggle(it.key)}
                />
                {it.color && <span className="tl-leg-dot" style={{ background: it.color }} />}
                <span className="tl-multi-lbl" title={it.label}>{it.label}</span>
                <span className="tl-multi-cnt">{fmt(it.count)}</span>
              </label>
            ))}
            {!shown.length && <div className="tl-multi-empty">No match</div>}
          </div>
        </div>
      )}
    </span>
  )
}

export function TimelineTab({ active, domId = 'tab-timeline' }) {
  // A Dashboard pane mounts a second copy with domId={null}, so field ids come
  // from useId rather than from the tab's element id.
  const uid = useId()
  const graph = useStore((s) => s.graph)
  const schema = useStore((s) => s.schema)
  const selectedId = useStore((s) => s.selectedId)
  const openInExplorer = useStore((s) => s.openInExplorer)

  const options = useMemo(() => getTemporalOptions(graph), [graph])
  const [optionId, setOptionId] = useState('')
  const [typeSel, setTypeSel] = useState([]) // empty = all types
  const [colorPropId, setColorPropId] = useState('') // '' = color by node type
  const [catSel, setCatSel] = useState([]) // empty = all values of that property
  const [groupId, setGroupId] = useState('')
  const [laneSort, setLaneSort] = useState('label')
  const [laneSel, setLaneSel] = useState([]) // empty = all lanes
  const [fromInput, setFromInput] = useState('')
  const [toInput, setToInput] = useState('')
  const [zoom, setZoom] = useState(1)

  const option = options.find((o) => o.id === optionId) || options[0] || null
  // Reset the selection to the default (highest-coverage) option whenever the
  // available options change (e.g. after loading a different graph).
  useEffect(() => {
    if (options.length && !options.find((o) => o.id === optionId)) setOptionId(options[0].id)
  }, [options, optionId])

  const allEvents = useMemo(
    () => (graph && option ? buildTimelineEvents(graph, option) : []),
    [graph, option]
  )
  const types = useMemo(() => [...new Set(allEvents.map((e) => e.type))].sort(), [allEvents])
  const typeCounts = useMemo(() => {
    const c = {}
    for (const e of allEvents) c[e.type] = (c[e.type] || 0) + 1
    return c
  }, [allEvents])

  // The full extent of the chosen dimension -- shown as the year fields'
  // placeholder so the filter states what there is to ask for.
  const extent = useMemo(() => {
    if (!allEvents.length) return null
    let min = Infinity, max = -Infinity
    for (const e of allEvents) { if (e.start < min) min = e.start; if (e.end > max) max = e.end }
    return { min: Math.floor(min), max: Math.ceil(max) }
  }, [allEvents])

  // ── coloring by a property's value (Fundtyp, Material, ...) ───────────────
  // Independent of the swimlane grouping on purpose: rows by stratigraphic
  // unit while the colors say what KIND of find each bar is, is exactly the
  // combination that answers "was there pottery in this unit, and when".
  //
  // Derived from ALL events of the chosen dating, never from the filtered
  // ones -- otherwise hiding a value would remove it from the very list that
  // is meant to bring it back.
  const eventNodeIds = useMemo(() => [...new Set(allEvents.map((e) => e.nodeId))], [allEvents])
  const colorProps = useMemo(
    () => (graph ? listChartProperties(graph, eventNodeIds, schema) : []),
    [graph, eventNodeIds, schema]
  )
  const colorProp = colorProps.find((p) => p.id === colorPropId) || null
  const colorDim = useMemo(() => dimForProperty(colorProp, ''), [colorProp])

  const coloring = useMemo(() => {
    if (!graph || !colorDim || !eventNodeIds.length) return null
    // 'count' order is what the color assignment builds on: the biggest groups
    // get the palette (see assignCategoryColors).
    const rows = groupAndCount(graph, eventNodeIds, colorDim, { sort: 'count' })
    const { legend, colorOf, plainCount } = assignCategoryColors(rows)
    // Every value a node carries, not just the one it is drawn in: a find
    // recorded as pottery AND bronze must still show up under "only pottery".
    const byNode = new Map()
    for (const row of rows) {
      for (const id of row.ids) {
        const cur = byNode.get(id)
        if (cur) cur.push(row.label)
        else byNode.set(id, [row.label])
      }
    }
    return { legend, colorOf, plainCount, byNode }
  }, [graph, colorDim, eventNodeIds])

  // Values are only comparable within one property, so a selection made for
  // "Fundtyp" means nothing under "Material" -- dropped when that changes.
  useEffect(() => { setCatSel((s) => (s.length ? [] : s)) }, [colorProp?.id])

  const fromYear = parseYear(fromInput)
  const toYear = parseYear(toInput)

  const events = useMemo(() => {
    const sel = new Set(typeSel)
    let evs = sel.size ? allEvents.filter((e) => sel.has(e.type)) : allEvents
    if (coloring && catSel.length) {
      const cats = new Set(catSel)
      evs = evs.filter((e) => coloring.byNode.get(e.nodeId)?.some((l) => cats.has(l)))
    }
    const inRange = filterEventsByYear(evs, fromYear, toYear)
    return [...inRange].sort((a, b) => a.start - b.start || a.end - b.end)
  }, [allEvents, typeSel, coloring, catSel, fromYear, toYear])

  // Derived from ALL events of the chosen dimension, not from the filtered
  // ones: the offer of groupings shouldn't shuffle under the cursor while a
  // year is being typed, and a row that the filter emptied is worth keeping
  // selectable.
  const groupOptions = useMemo(() => getLaneOptions(graph, allEvents, schema), [graph, allEvents, schema])
  const group = groupOptions.find((g) => g.id === groupId) || groupOptions[0]
  useEffect(() => {
    if (groupId && !groupOptions.find((g) => g.id === groupId)) setGroupId('')
  }, [groupOptions, groupId])

  // One swimlane per value of the chosen property (lib/timelineLanes.js).
  const lanes = useMemo(
    () => buildLanes(graph, events, group, laneSort, schema),
    [graph, events, group, laneSort, schema]
  )
  const grouped = !!group && group.kind !== 'none'

  // Which lanes to draw. Values are only comparable within one grouping, so a
  // selection made for "SE" would be meaningless under "Material" -- it is
  // dropped whenever the grouping changes.
  // (returning the same array when already empty keeps this from causing a
  // pointless extra render on mount)
  useEffect(() => { setLaneSel((s) => (s.length ? [] : s)) }, [group?.id])
  const visibleLanes = useMemo(() => {
    if (!grouped || !laneSel.length) return lanes
    const sel = new Set(laneSel)
    return lanes.filter((l) => sel.has(l.key))
  }, [lanes, laneSel, grouped])

  // What is actually on screen -- a hidden lane must not stretch the axis or
  // be counted in the badge. A node sitting in two lanes counts once.
  const shownEvents = useMemo(() => {
    if (!grouped || visibleLanes === lanes) return events
    const seen = new Set()
    const out = []
    for (const l of visibleLanes) {
      for (const e of l.events) if (!seen.has(e.nodeId)) { seen.add(e.nodeId); out.push(e) }
    }
    return out.sort((a, b) => a.start - b.start || a.end - b.end)
  }, [grouped, visibleLanes, lanes, events])

  // Measure the scroll viewport so lane packing works in real pixels (and so
  // horizontal zoom multiplies a known base width). Attached as a callback ref
  // rather than in an effect: filtering down to zero events unmounts the
  // viewport and mounts a NEW element when the filter is cleared -- a
  // mount-once observer would keep watching the discarded one.
  const wrapRef = useRef(null)
  const roRef = useRef(null)
  const [wrapW, setWrapW] = useState(900)
  const setWrapEl = useCallback((el) => {
    wrapRef.current = el
    if (roRef.current) { roRef.current.disconnect(); roRef.current = null }
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width
      if (w) setWrapW(w)
    })
    ro.observe(el)
    roRef.current = ro
  }, [])

  // An explicit year bound IS the axis bound -- the window the user asked for
  // stays the window they get, even if no event reaches its edge. Only the
  // open sides are derived from the data (and padded).
  const domain = useMemo(() => {
    if (!shownEvents.length) return null
    let min = Infinity, max = -Infinity
    for (const e of shownEvents) { if (e.start < min) min = e.start; if (e.end > max) max = e.end }
    if (fromYear != null && toYear != null && fromYear > toYear) { min = toYear; max = fromYear + 1 }
    else {
      if (fromYear != null) min = fromYear
      if (toYear != null) max = toYear + 1
    }
    if (min >= max) { min -= 1; max += 1 }
    const span = max - min
    return {
      min: fromYear != null ? min : min - span * 0.04,
      max: toYear != null ? max : max + span * 0.04,
    }
  }, [shownEvents, fromYear, toYear])

  const layout = useMemo(() => {
    if (!domain || !shownEvents.length) return null
    const innerW = Math.max(wrapW, 200) * zoom
    const span = domain.max - domain.min || 1
    const toPx = (v) => ((v - domain.min) / span) * innerW
    const placed = []
    const drawnBands = []
    let top = AXIS_H
    visibleLanes.forEach((lane, i) => {
      const hdrH = grouped ? BAND_HDR_H : 0
      const rows = placeEvents(lane.events, toPx, innerW, grouped)
      const rowCount = rows.reduce((m, e) => Math.max(m, e.lane + 1), 1)
      // A node with several values for the property sits in several swimlanes,
      // so the node id alone is no longer a unique React key.
      for (const e of rows) placed.push({ ...e, key: lane.key + '\n' + e.nodeId, top: top + hdrH + e.lane * LANE_H })
      const height = hdrH + rowCount * LANE_H
      if (grouped) {
        drawnBands.push({
          key: lane.key, label: lane.label, count: lane.count, rows: rowCount, top, height, alt: i % 2 === 1,
          color: group.kind === 'type' ? typeColor(schema, lane.key) : null,
        })
      }
      top += height + (grouped ? BAND_GAP : 0)
    })
    return { innerW, toPx, placed, bands: drawnBands, height: top + 14 }
  }, [domain, shownEvents, visibleLanes, grouped, group, schema, wrapW, zoom])

  const ticks = useMemo(
    () => (domain ? niceTicks(domain.min, domain.max, Math.round(8 * Math.sqrt(zoom))) : null),
    [domain, zoom]
  )

  // When arriving on this tab with a node already selected elsewhere, bring it
  // into view (mirrors the Map tab's pan-to-selection).
  useEffect(() => {
    if (!active || !selectedId || !layout || !wrapRef.current) return
    const ev = layout.placed.find((e) => e.nodeId === selectedId)
    if (!ev) return
    const wrap = wrapRef.current
    wrap.scrollTo({ left: Math.max(0, ev.x0 - wrap.clientWidth / 2), behavior: 'smooth' })
  }, [active, selectedId, layout])

  if (!graph) return null

  const filtered = shownEvents.length !== allEvents.length
  const hasYearFilter = fromInput !== '' || toInput !== ''
  const laneItems = lanes.map((l) => ({
    key: l.key, label: l.label, count: l.count,
    color: group?.kind === 'type' ? typeColor(schema, l.key) : null,
  }))
  // The dropdown offers EVERY value (with search); the legend below shows the
  // ones that got a color of their own, plus one entry for the grey remainder.
  const catItems = coloring
    ? coloring.legend.map((c) => ({ key: c.label, label: c.label, count: c.count, color: c.color }))
    : []
  const namedCats = coloring ? coloring.legend.filter((c) => !c.plain) : []
  const plainCats = coloring ? coloring.legend.filter((c) => c.plain) : []
  // Legend click: the first click out of "everything" solos that value,
  // further clicks add and remove -- the same rule as the type legend.
  const toggleCat = (label) => setCatSel(
    !catSel.length ? [label]
      : catSel.includes(label) ? catSel.filter((x) => x !== label)
        : [...catSel, label]
  )

  return (
    <div className={'panel' + (active ? ' on' : '')} id={domId}>
      <div className="sec-hdr">
        <h2>Timeline</h2>
        {domain && (
          <span className="badge">
            {fmt(shownEvents.length)}{filtered ? ` of ${fmt(allEvents.length)}` : ''} events
            {grouped ? ` · ${fmt(visibleLanes.length)}${visibleLanes.length !== lanes.length ? ` of ${fmt(lanes.length)}` : ''} rows` : ''}
            &middot; {formatYear(domain.min)} – {formatYear(domain.max)}
          </span>
        )}
      </div>

      <div className="frow" style={{ alignItems: 'center' }}>
        {options.length > 1 && (
          <select className="sl" value={option?.id || ''} onChange={(e) => setOptionId(e.target.value)} title="Which date">
            {options.map((o) => (
              <option key={o.id} value={o.id}>{o.label} ({o.count})</option>
            ))}
          </select>
        )}
        {types.length > 1 && (
          <MultiSelect
            items={types.map((t) => ({ key: t, label: typeLabel(schema, t), count: typeCounts[t] || 0, color: typeColor(schema, t) }))}
            selected={typeSel} onChange={setTypeSel}
            allLabel="All types" unit="types" title="Choose node types"
          />
        )}
        {colorProps.length > 0 && (
          <select
            className="sl"
            // Falls back to the type color when the property doesn't exist for
            // the newly chosen dating -- an unmatched value would leave the
            // dropdown blank.
            value={colorProp ? colorPropId : ''}
            title="Colour bars and points by the value of a property. The number in brackets tells how many of the dated nodes have a value for this property."
            onChange={(e) => setColorPropId(e.target.value)}
          >
            <option value="">Colour by: node type</option>
            {colorProps.map((p) => (
              <option key={p.id} value={p.id}>Colour by: {p.label} ({fmt(p.coverage)})</option>
            ))}
          </select>
        )}
        {coloring && (
          <MultiSelect
            items={catItems} selected={catSel} onChange={setCatSel}
            allLabel="All values" unit="values"
            title={`Which values of “${colorProp.label}” are shown`}
          />
        )}
        {groupOptions.length > 1 && (
          <select
            className="sl" value={group?.id || ''} onChange={(e) => setGroupId(e.target.value)}
            title="One row per value of this property — e.g. one row per stratigraphic unit"
          >
            {groupOptions.map((g) => (
              <option key={g.id} value={g.id}>
                {g.kind === 'none' ? g.label : `Rows: ${g.label} (${g.values})`}
              </option>
            ))}
          </select>
        )}
        {grouped && (
          <MultiSelect
            items={laneItems} selected={laneSel} onChange={setLaneSel}
            allLabel="All rows" unit="rows"
            title={`Which ${group.label} rows are shown`}
          />
        )}
        {grouped && (
          <select className="sl" value={laneSort} onChange={(e) => setLaneSort(e.target.value)} title="Order of the rows">
            {LANE_SORTS.map((s) => (
              <option key={s.id} value={s.id}>Rows by {s.label}</option>
            ))}
          </select>
        )}
        <span className="tl-years">
          <label htmlFor={uid + '-from'}>Years</label>
          <input
            id={uid + '-from'} className="sl tl-year" type="number" inputMode="numeric"
            placeholder={extent ? String(extent.min) : 'from'} value={fromInput}
            onChange={(e) => setFromInput(e.target.value)} title="From which year (negative = BCE)"
          />
          <span className="tl-years-sep">–</span>
          <input
            id={uid + '-to'} className="sl tl-year" type="number" inputMode="numeric"
            placeholder={extent ? String(extent.max) : 'to'} value={toInput}
            onChange={(e) => setToInput(e.target.value)} title="Up to and including which year"
          />
          {hasYearFilter && (
            <button className="copy-btn" title="Reset time span" onClick={() => { setFromInput(''); setToInput('') }}>✕</button>
          )}
        </span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 4, alignItems: 'center' }}>
          <button className="sl" style={{ padding: '.3rem .6rem' }} title="Zoom out" onClick={() => setZoom((z) => Math.max(1, z / 1.5))}>−</button>
          <span style={{ fontSize: '.7rem', color: 'var(--tx3)', minWidth: 40, textAlign: 'center' }}>{Math.round(zoom * 100)}%</span>
          <button className="sl" style={{ padding: '.3rem .6rem' }} title="Zoom in" onClick={() => setZoom((z) => Math.min(60, z * 1.5))}>+</button>
        </span>
      </div>

      {/* The legend says what the colors currently MEAN, so it follows the
          coloring: values while one is chosen, node types otherwise. Filtering
          by node type stays available in the dropdown above either way. */}
      {coloring ? (
        <>
          <div className="tl-legend">
            <span className="mx-leg-lbl">{colorProp.label}:</span>
            {namedCats.map((c) => (
              <span
                key={c.label}
                className="tl-leg-item"
                style={{ opacity: catSel.length && !catSel.includes(c.label) ? 0.4 : 1 }}
                title={`${fmt(c.count)} events — click to show only this value`}
                onClick={() => toggleCat(c.label)}
              >
                <span className="tl-leg-dot" style={{ background: c.color }} />
                {c.label} <em className="tl-leg-cnt">{fmt(c.count)}</em>
              </span>
            ))}
            {plainCats.length > 0 && (
              <span
                className="tl-leg-item"
                style={{ opacity: catSel.length ? 0.4 : 1, cursor: 'default' }}
                title={
                  plainCats.length === 1
                    ? 'Events without a value'
                    : `Without a value, and ${fmt(plainCats.length)} more values too rare for a colour of their own — selectable one by one in the list above`
                }
              >
                <span className="tl-leg-dot" style={{ background: plainCats[0].color }} />
                {plainCats.length === 1 ? plainCats[0].label : 'other'} <em className="tl-leg-cnt">{fmt(coloring.plainCount)}</em>
              </span>
            )}
          </div>
          {colorProp.poorGrouping && (
            <div className="cat-note">
              “{colorProp.label}” has a value of its own for almost every node — only the most frequent get a colour.
            </div>
          )}
        </>
      ) : types.length > 1 && (
        <div className="tl-legend">
          {types.map((t) => (
            <span
              key={t}
              className="tl-leg-item"
              style={{ opacity: typeSel.length && !typeSel.includes(t) ? 0.4 : 1 }}
              // Same rule as the dropdown: the first click out of "all" solos
              // that type, further clicks add and remove.
              onClick={() => setTypeSel(
                !typeSel.length ? [t]
                  : typeSel.includes(t) ? typeSel.filter((x) => x !== t)
                    : [...typeSel, t]
              )}
            >
              <span className="tl-leg-dot" style={{ background: typeColor(schema, t) }} />
              {typeLabel(schema, t)}
            </span>
          ))}
        </div>
      )}

      {!shownEvents.length ? (
        <div className="empty">
          No datable events for this selection
          {!!catSel.length && (
            <div style={{ marginTop: 6, fontSize: '.72rem' }}>
              <button className="copy-btn" onClick={() => setCatSel([])}>↺ Show all values again</button>
            </div>
          )}
          {!!laneSel.length && (
            <div style={{ marginTop: 6, fontSize: '.72rem' }}>
              <button className="copy-btn" onClick={() => setLaneSel([])}>↺ Show all rows again</button>
            </div>
          )}
          {hasYearFilter && extent && (
            <div style={{ marginTop: 6, fontSize: '.72rem' }}>
              Available: {formatYear(extent.min)} – {formatYear(extent.max)}.
            </div>
          )}
        </div>
      ) : (
        <div className="tl-wrap" ref={setWrapEl}>
          <div className="tl-inner" style={{ width: layout?.innerW, height: layout?.height }}>
            {ticks?.ticks.map((t) => (
              <div key={t} className="tl-grid" style={{ left: layout?.toPx(t) }}>
                <span className="tl-tick">{formatYear(t)}</span>
              </div>
            ))}
            {layout?.bands.map((b) => (
              <div key={b.key} className={'tl-band' + (b.alt ? ' alt' : '')} style={{ top: b.top, height: b.height }}>
                {/* Sticky so the swimlane caption stays readable while the
                    timeline is scrolled horizontally. */}
                <span className="tl-band-lbl">
                  {b.color && <span className="tl-leg-dot" style={{ background: b.color }} />}
                  {b.label}
                  <em>{fmt(b.count)}</em>
                </span>
              </div>
            ))}
            {layout?.placed.map((e) => {
              // A color given to this one node still wins over its category's,
              // just like in the Harris matrix.
              const color = coloring
                ? nodeColorOverride(schema, e.nodeId) || coloring.colorOf(e.nodeId)
                : nodeColor(schema, e.nodeId, e.type)
              const sel = e.nodeId === selectedId
              // No `title` attribute here: the quick-info card already
              // describes the event, and a native tooltip on top of it would
              // just be a second box saying less.
              if (e.isSpan) {
                return (
                  <div
                    key={e.key}
                    className={'tl-event' + (sel ? ' sel' : '')}
                    style={{ left: e.x0, top: e.top }}
                    onClick={() => openInExplorer(e.nodeId)}
                    {...nodeHoverProps(e.nodeId)}
                  >
                    <span className="tl-bar" style={{ width: e.barW, background: color }} />
                    {/* In a grouped row events share one line; a label that
                        would land on the previous one is dropped rather than
                        overprinted. The quick-info card still names it. */}
                    {e.showLabel && (
                      <span
                        className="tl-label"
                        style={{ left: e.inLabel ? 6 : e.barW + 6, color: e.inLabel ? 'var(--tx)' : 'var(--tx2)' }}
                      >
                        {e.label}
                      </span>
                    )}
                  </div>
                )
              }
              return (
                <div
                  key={e.key}
                  className={'tl-event' + (sel ? ' sel' : '')}
                  style={{ left: e.x0 - DOT_R, top: e.top }}
                  onClick={() => openInExplorer(e.nodeId)}
                  {...nodeHoverProps(e.nodeId)}
                >
                  <span className="tl-dot" style={{ background: color }} />
                  {e.showLabel && <span className="tl-label" style={{ left: DOT_R * 2 + 4 }}>{e.label}</span>}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
