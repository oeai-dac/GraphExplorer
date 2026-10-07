// temporal.js
//
// Timeline support for the Graph Explorer -- entirely additive, mirrors how
// lib/geo.js gates the Map tab: the Zeitstrahl tab only appears when the
// loaded graph actually contains datable values (see hasTemporalData). A
// dataset without any chronology is completely unaffected -- the tab never
// even renders.
//
// The core idea: every datable attribute value is parsed into a uniform
// interval { start, end } in *years* (fractional for sub-year precision),
// plus a `precision`. The precision decides point-vs-bar in the UI:
//   * day / month / (single) year  -> a POINT (start ~= end)
//   * decade / century / range     -> a BAR spanning [start, end]
// so exact datings show as markers and fuzzy/spanned datings as bars, with
// no need to normalise the source data first.
//
// Supported value forms (all optional, detected leniently):
//   1892-07-14        ISO date            -> point
//   1892-07           ISO year-month      -> point
//   1885 / "1885"     plain year          -> point
//   -320 / 320 v.Chr. / 150 BC            -> point (BCE = negative year)
//   1890er / 1890s    decade              -> bar [1890,1900)
//   18. Jh. / 18th century               -> bar [1700,1800)
//   1880/1895 · 1880 bis 1895 · 1880–95  range               -> bar
//   von=1880 + bis=1895 (two attributes) -> bar (see FROM_TO_MARKERS)
//   first_attestation=-1292 + last_attestation=324 -> bar (PREFIX_FROM_TO_MARKERS)

import { humaniseKey } from './schema'

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

// Approximate fractional year for a Y-M(-D) date, good enough for axis
// positioning across a range that can span millennia (leap years ignored on
// purpose -- a fraction of a day never matters at this scale).
function dateToYear(y, mo, da) {
  let doy = da ? da - 1 : 14 // mid-month when no day given
  for (let i = 0; i < mo - 1; i++) doy += DAYS_IN_MONTH[i]
  return y + doy / 365
}

// Reflect an interval across year 0 for BCE values, keeping start <= end.
function applySign(sign, iv) {
  if (sign === -1) return { ...iv, start: -iv.end, end: -iv.start }
  return iv
}

// Parse ONE endpoint (no range separators) into an interval, or null.
function parseEndpoint(input) {
  let s = String(input).trim()
  if (!s) return null
  // Approximation qualifiers don't change the value, only the confidence.
  s = s.replace(/^(?:ca\.?|circa|um|etwa|approx\.?|around|~|±)\s*/i, '').trim()

  let sign = 1
  let strong = false // "strong" = explicit temporal syntax present (see accept())
  const eraNeg = /(?:^|\s)(?:v\.?\s*chr\.?|vor\s*christ(?:us|i)?|bce|bc|b\.\s*c\.)(?=\s|\.|$)/i
  const eraPos = /(?:^|\s)(?:n\.?\s*chr\.?|nach\s*christ(?:us|i)?|ce|ad|a\.\s*d\.)(?=\s|\.|$)/i
  if (eraNeg.test(s)) { sign = -1; strong = true; s = s.replace(eraNeg, ' ') }
  else if (eraPos.test(s)) { strong = true; s = s.replace(eraPos, ' ') }
  s = s.replace(/\s+/g, ' ').trim().replace(/[.,;]+$/, '').trim()
  if (!s) return null

  // Century: "18. Jh", "18 Jahrhundert", "18th century"
  let m =
    s.match(/^(\d{1,2})\s*\.?\s*(?:jh\.?|jhdt?\.?|jahrh\w*|century)$/i) ||
    s.match(/^(\d{1,2})(?:st|nd|rd|th)\s*century$/i)
  if (m) {
    const c = parseInt(m[1], 10)
    const startYr = (c - 1) * 100
    return applySign(sign, { start: startYr, end: startYr + 100, precision: 'century', strong: true })
  }
  // Decade: "1890er", "1890s", "1890er Jahre"
  m = s.match(/^(\d{3,4})\s*(?:er|s)(?:\s*jahre)?$/i)
  if (m) {
    const d = parseInt(m[1], 10)
    return applySign(sign, { start: d, end: d + 10, precision: 'decade', strong: true })
  }
  // ISO date
  m = s.match(/^(\d{1,6})-(\d{2})-(\d{2})(?:[T ].*)?$/)
  if (m) {
    const y = +m[1], mo = +m[2], da = +m[3]
    if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) {
      const yr = dateToYear(y, mo, da)
      return applySign(sign, { start: yr, end: yr, precision: 'day', strong: true })
    }
  }
  // ISO year-month
  m = s.match(/^(\d{1,6})-(\d{2})$/)
  if (m) {
    const y = +m[1], mo = +m[2]
    if (mo >= 1 && mo <= 12) {
      const yr = dateToYear(y, mo, null)
      return applySign(sign, { start: yr, end: yr, precision: 'month', strong: true })
    }
  }
  // Plain year (a leading "-" is an explicit BCE year on its own)
  m = s.match(/^(-?\d{1,6})$/)
  if (m) {
    const y = parseInt(m[1], 10)
    return applySign(y < 0 ? 1 : sign, { start: y, end: y, precision: 'year', strong })
  }
  return null
}

// Split a range expression into its two endpoints, or null if not a range.
function splitRange(s) {
  // Safe separators (never collide with an ISO date's internal "-").
  let m = s.match(/^(.*?\S)\s*(?:\/|–|—|\bbis\b|\bto\b|\bund\b)\s*(\S.*)$/i)
  if (m) return [m[1], m[2]]
  // Bare hyphen only between two 3-4 digit years ("1830-1860").
  m = s.match(/^\s*(-?\d{3,4}(?:\s*(?:er|s))?)\s*-\s*(-?\d{3,4}(?:\s*(?:er|s))?)\s*$/i)
  if (m) return [m[1], m[2]]
  // Century range with a hyphen ("18.-19. Jh").
  m = s.match(/^(\d{1,2}\.?\s*(?:jh\w*|jahrh\w*))\s*-\s*(\d{1,2}\.?\s*(?:jh\w*|jahrh\w*).*)$/i)
  if (m) return [m[1], m[2]]
  return null
}

/** Parse a single scalar value into { start, end, precision, strong, raw }, or null. */
export function parseTemporal(raw) {
  if (raw == null) return null
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null
    return { start: raw, end: raw, precision: 'year', strong: false, raw: String(raw) }
  }
  const s = String(raw).trim()
  if (!s || !/\d/.test(s)) return null // cheap guard: no digit -> never temporal

  // An ISO date/month must not be mistaken for a range because of its "-".
  const isIso = /^-?\d{1,6}-\d{2}(?:-\d{2})?(?:[T ].*)?$/.test(s)
  if (!isIso) {
    const parts = splitRange(s)
    if (parts) {
      const a = parseEndpoint(parts[0])
      const b = parseEndpoint(parts[1])
      if (a && b) return { start: Math.min(a.start, b.start), end: Math.max(a.end, b.end), precision: 'range', strong: true, raw: s }
      if (a) return { ...a, raw: s }
      if (b) return { ...b, raw: s }
    }
  }
  const one = parseEndpoint(s)
  return one ? { ...one, raw: s } : null
}

// Attribute-key names that clearly denote a time (used to accept bare years,
// which on their own are indistinguishable from any other integer).
const TEMPORAL_KEY_RE =
  /dat(e|ier|um)|jahr|year|zeit|time|period|epoch|phase|chronolog|jahrhundert|century|saeculum|\bage\b|alter|\bvon\b|\bbis\b|\bfrom\b|\bto\b|beginn|ende|anfang|start|finish|attest|beleg/i

export function isTemporalKey(key) {
  return TEMPORAL_KEY_RE.test(String(key))
}

// Accept a parsed value as a real timeline event. Explicit temporal syntax
// (ISO date, decade, century, range, era marker) is always accepted; a bare
// year is only accepted when its attribute *name* looks temporal AND it falls
// in a plausible historical window -- this is what stops ordinary numeric
// fields (inventory numbers, counts, coordinates) from spawning junk events
// or a spurious tab.
function accept(iv, key) {
  if (!iv) return false
  if (iv.strong) return true
  return isTemporalKey(key) && iv.start >= -10000 && iv.end <= 3000
}

/** True if `value`, sitting under attribute name `key`, counts as a real
    date by the same rule the Zeitstrahl applies. Exported so the Charts tab
    can decide whether to offer a Jahr/Jahrzehnt/Jahrhundert resolution for a
    property without re-deriving (and eventually contradicting) that rule. */
export function isTemporalValue(value, key) {
  return accept(parseTemporal(value), key)
}

// ── from/to attribute pairs (a span split across two attributes) ────────────
const FROM_TO_MARKERS = [
  ['von', 'bis'], ['from', 'to'], ['beginn', 'ende'], ['anfang', 'ende'],
  ['start', 'ende'], ['start', 'end'], ['starts', 'finishes'], ['start', 'finish'],
  ['ab', 'bis'],
  ['frühestens', 'spätestens'], ['fruehestens', 'spaetestens'],
  ['earliest', 'latest'], ['tpq', 'taq'],
]

// Markers that sit at the FRONT of a key rather than its end: "first_attestation"
// / "last_attestation", "von_jahr" / "bis_jahr". The suffix-matched pairs above
// cannot see these -- there the shared part is the prefix and the marker ends the
// key, here it is the other way round and the REST of the key is what names the
// span ("Attestation"), which is also why this needs its own marker list: "ende"
// is a plausible suffix but "ab" is only ever a prefix.
const PREFIX_FROM_TO_MARKERS = [
  ['first', 'last'], ['earliest', 'latest'], ['erst', 'letzt'],
  ['fruehest', 'spaetest'], ['frühest', 'spätest'],
  ['von', 'bis'], ['ab', 'bis'], ['from', 'to'],
  ['beginn', 'ende'], ['anfang', 'ende'], ['start', 'end'], ['start', 'ende'],
  ['tpq', 'taq'],
]

// "Whole-key" start/end markers for the cross-prefix fallback below. Unlike the
// prefix-matched pairs above, these pair a start-ish key with an end-ish key on
// the same node even when their prefixes DIFFER -- needed for CIDOC start/finish
// properties (AP24_starts / AP23_finishes) whose property numbers never match.
const START_WORDS = ['starts', 'start', 'startet', 'begins', 'begin', 'beginnt', 'beginn']
const END_WORDS = ['finishes', 'finish', 'ends', 'end', 'endet', 'ende']

// If `key` ends with `marker` (exact, or after a _ - . : / space separator),
// return the prefix before it (original casing); otherwise null.
function keyPrefix(key, marker) {
  const lk = key.toLowerCase()
  if (lk === marker) return ''
  if (lk.endsWith(marker)) {
    const before = key.slice(0, key.length - marker.length)
    if (before === '' || /[ _\-.:/]$/.test(before)) return before
  }
  return null
}

// Mirror of keyPrefix() for a marker at the front: if `key` starts with
// `marker` (exact, or followed by a _ - . : / space separator or a camelCase
// hump), return the rest after it; otherwise null. The boundary is what keeps
// "erstellungsdatum" from reading as "erst" + "ellungsdatum".
function keyRest(key, marker) {
  const lk = key.toLowerCase()
  if (lk === marker) return ''
  if (!lk.startsWith(marker)) return null
  const after = key.slice(marker.length)
  if (/^[ _.:/-]/.test(after)) return after.replace(/^[ _.:/-]+/, '')
  if (/^[A-Z]/.test(after)) return after          // camelCase: firstAttestation
  return null
}

function findPairs(keys) {
  const pairs = []
  const used = new Set()
  for (const fk of keys) {
    if (used.has(fk)) continue
    for (const [fm, tm] of FROM_TO_MARKERS) {
      const pfx = keyPrefix(fk, fm)
      if (pfx === null) continue
      const tk = keys.find((k) => {
        if (used.has(k) || k === fk) return false
        const p2 = keyPrefix(k, tm)
        return p2 !== null && p2.toLowerCase() === pfx.toLowerCase()
      })
      if (tk) {
        const label = pfx.replace(/[ _\-.:/]+$/, '').trim()
        pairs.push({ fromKey: fk, toKey: tk, prefix: pfx, label: label || 'Time span' })
        used.add(fk); used.add(tk)
        break
      }
    }
  }
  // Prefix-marked pairs, e.g. first_attestation / last_attestation: the earliest
  // and the latest evidence for a word, which together ARE its dating -- as two
  // separate point dimensions they would say nothing about the span between them.
  for (const fk of keys) {
    if (used.has(fk)) continue
    for (const [fm, tm] of PREFIX_FROM_TO_MARKERS) {
      const rest = keyRest(fk, fm)
      if (rest === null) continue
      const tk = keys.find((k) => {
        if (used.has(k) || k === fk) return false
        const r2 = keyRest(k, tm)
        return r2 !== null && r2.toLowerCase() === rest.toLowerCase()
      })
      // "first"/"last" head all sorts of non-temporal ranges -- first_page /
      // last_page would otherwise turn a citation's pages into a dating of the
      // years 12 to 45, and spawn the very tab this module keeps hidden for
      // graphs without a chronology. So one of the two keys must also READ as
      // temporal, which is the same bar a single bare year has to clear.
      if (tk && (isTemporalKey(fk) || isTemporalKey(tk))) {
        const label = rest.replace(/[ _.:/-]+/g, ' ').trim()
        // `prefix` is the option's stable id -- here the shared rest, not the marker.
        pairs.push({ fromKey: fk, toKey: tk, prefix: rest || fk, label: label || 'Time span' })
        used.add(fk); used.add(tk)
        break
      }
    }
  }

  // Cross-prefix fallback for CIDOC-style start/finish spans (e.g. AP24_starts /
  // AP23_finishes): if, among the still-unused keys, exactly one looks like a
  // "start" and exactly one like an "end", pair those two regardless of prefix.
  // The "exactly one each" guard keeps this from mis-pairing when several
  // start/end-ish fields coexist.
  const startLeft = keys.filter((k) => !used.has(k) && START_WORDS.some((m) => keyPrefix(k, m) !== null))
  const endLeft = keys.filter((k) => !used.has(k) && END_WORDS.some((m) => keyPrefix(k, m) !== null))
  if (startLeft.length === 1 && endLeft.length === 1 && startLeft[0] !== endLeft[0]) {
    const fk = startLeft[0], tk = endLeft[0]
    pairs.push({ fromKey: fk, toKey: tk, prefix: fk, label: 'Time span' })
    used.add(fk); used.add(tk)
  }
  return pairs
}

function pairInterval(attrs, p) {
  const from = parseTemporal(attrs[p.fromKey])
  const to = parseTemporal(attrs[p.toKey])
  if (from && to) {
    return { start: Math.min(from.start, to.start), end: Math.max(from.end, to.end), precision: 'range', strong: true, raw: `${attrs[p.fromKey]} – ${attrs[p.toKey]}` }
  }
  if (from) return { ...from, raw: String(attrs[p.fromKey]) }
  if (to) return { ...to, raw: String(attrs[p.toKey]) }
  return null
}

// The single best datable interval for one node: a from/to span if it has one,
// otherwise its first acceptable temporal attribute. Backs the combined "Alle
// Datierungen" view (one event per node, mixing spans and points).
function nodeBestInterval(attrs) {
  const keys = Object.keys(attrs)
  for (const p of findPairs(keys)) {
    const iv = pairInterval(attrs, p)
    if (iv) return iv
  }
  for (const k of keys) {
    const parsed = parseTemporal(attrs[k])
    if (accept(parsed, k)) return parsed
  }
  return null
}

/** True if the graph has at least one datable value -- gates the Zeitstrahl tab. */
export function hasTemporalData(graph) {
  if (!graph) return false
  for (const nd of Object.values(graph.nodes || {})) {
    const a = nd.a || {}
    // A from/to pair is temporal even if each half is only a bare year.
    for (const p of findPairs(Object.keys(a))) {
      if (pairInterval(a, p)) return true
    }
    for (const [k, v] of Object.entries(a)) {
      if (accept(parseTemporal(v), k)) return true
    }
  }
  return false
}

/**
 * The list of selectable "time dimensions" in the graph, most-used first:
 *   { id, kind: 'attr'|'pair', label, count, key? | fromKey?+toKey? }
 * -- an attribute whose values parse as dates, or a from/to attribute pair.
 * The Timeline tab defaults to the first (highest coverage) entry.
 */
export function getTemporalOptions(graph) {
  if (!graph) return []
  const attrCounts = new Map()
  const pairInfo = new Map() // prefixLower -> { fromKey, toKey, label, count }
  let anyCount = 0           // nodes with at least one datable value (for "Alle")
  for (const nd of Object.values(graph.nodes || {})) {
    const a = nd.a || {}
    const keys = Object.keys(a)
    const pairs = findPairs(keys)
    const consumed = new Set()
    let nodeHasAny = false
    for (const p of pairs) {
      if (!pairInterval(a, p)) continue
      consumed.add(p.fromKey); consumed.add(p.toKey)
      nodeHasAny = true
      const id = p.prefix.toLowerCase()
      const cur = pairInfo.get(id) || { fromKey: p.fromKey, toKey: p.toKey, label: p.label, count: 0 }
      cur.count++
      pairInfo.set(id, cur)
    }
    for (const k of keys) {
      if (consumed.has(k)) continue
      if (accept(parseTemporal(a[k]), k)) { attrCounts.set(k, (attrCounts.get(k) || 0) + 1); nodeHasAny = true }
    }
    if (nodeHasAny) anyCount++
  }
  const options = []
  for (const [id, p] of pairInfo) {
    options.push({ id: 'pair::' + id, kind: 'pair', fromKey: p.fromKey, toKey: p.toKey, label: `${p.label} (from–to)`, count: p.count })
  }
  for (const [key, count] of attrCounts) {
    options.push({ id: 'attr::' + key, kind: 'attr', key, label: humaniseKey(key), count })
  }
  options.sort((a, b) => b.count - a.count)
  // A combined view is only meaningful when there are ≥2 distinct dimensions
  // (e.g. a start/finish span AND a took_place_in_year point). Put it first so
  // it becomes the default -- the whole chronology on one axis.
  if (pairInfo.size + attrCounts.size >= 2) {
    options.unshift({ id: 'all', kind: 'all', label: 'All dates', count: anyCount })
  }
  return options
}

/** Build the timeline events for a chosen option: [{ nodeId, label, type, start, end, precision, isSpan, raw }]. */
export function buildTimelineEvents(graph, option) {
  if (!graph || !option) return []
  const events = []
  for (const [nodeId, nd] of Object.entries(graph.nodes || {})) {
    let iv = null
    if (option.kind === 'all') {
      iv = nodeBestInterval(nd.a || {})
    } else if (option.kind === 'pair') {
      iv = pairInterval(nd.a || {}, option)
    } else {
      const parsed = parseTemporal(nd.a?.[option.key])
      if (accept(parsed, option.key)) iv = parsed
    }
    if (!iv) continue
    events.push({
      nodeId,
      label: nd.l || nodeId,
      type: nd.t || '',
      start: iv.start,
      end: iv.end,
      precision: iv.precision,
      isSpan: iv.end - iv.start >= 1,
      raw: iv.raw != null ? iv.raw : '',
    })
  }
  return events
}

/**
 * Events overlapping the year window [from, to] -- either bound may be null
 * (open). `to` is inclusive of the whole year: "bis 1850" keeps 1850-07-14.
 * A span reaching into the window counts, so filtering never hides a dating
 * that was running at the time asked about. Reversed bounds are swapped
 * rather than yielding nothing.
 */
export function filterEventsByYear(events, from, to) {
  if (from == null && to == null) return events
  let lo = from, hi = to
  if (lo != null && hi != null && lo > hi) { const t = lo; lo = hi; hi = t }
  const min = lo == null ? -Infinity : lo
  const max = hi == null ? Infinity : hi + 1
  return events.filter((e) => e.end >= min && e.start < max)
}

/** Format a (possibly negative) year for axis labels / tooltips. */
export function formatYear(y) {
  const yr = Math.round(y)
  if (yr < 0) return `${-yr} BCE`
  return String(yr)
}

/** "Nice" evenly-spaced tick years covering [min, max] (~target ticks). */
export function niceTicks(min, max, target = 8) {
  const span = max - min || 1
  const rawStep = span / Math.max(1, target)
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)))
  const norm = rawStep / mag
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag
  const first = Math.ceil(min / step) * step
  const ticks = []
  for (let t = first; t <= max + 1e-6; t += step) ticks.push(Math.round(t))
  return { ticks, step }
}
