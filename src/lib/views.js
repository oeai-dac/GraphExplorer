// Central registry of the content views the app can show. Both the classic
// tab bar and the Dashboard's per-pane view picker read from here, so a view
// -- and the data it needs before it may be offered at all -- is declared in
// exactly one place.

import { hasDotOneData } from './harrisMatrix'
import { hasGeoData } from './geo'
import { hasTemporalData } from './temporal'

// `tabLabel` is what the classic tab bar shows (unchanged wording), `label`
// the shorter name used in the Dashboard's pane dropdown, where horizontal
// space is scarce.
export const VIEWS = [
  { key: 'overview', icon: '◈', tabLabel: 'Overview', label: 'Overview' },
  { key: 'explore', icon: '⬤', tabLabel: 'Explorer', label: 'Explorer' },
  { key: 'graph', icon: '⁂', tabLabel: 'Graph', label: 'Graph' },
  { key: 'matrix', icon: '⬍', tabLabel: 'Matrix', label: 'Harris Matrix' },
  { key: 'map', icon: '⚑', tabLabel: 'Map', label: 'Map' },
  { key: 'timeline', icon: '⧗', tabLabel: 'Timeline', label: 'Timeline' },
  { key: 'charts', icon: '▤', tabLabel: 'Charts', label: 'Charts' },
  { key: 'search', icon: '⌕', tabLabel: 'Search', label: 'Search' },
]

export const VIEW_KEYS = VIEWS.map((v) => v.key)

// Views that only make sense for graphs carrying the right kind of data.
// Everything not listed here is always available.
const REQUIRES = {
  matrix: hasDotOneData,
  map: hasGeoData,
  timeline: hasTemporalData,
}

export function isViewAvailable(graph, key) {
  if (!VIEW_KEYS.includes(key)) return false
  const req = REQUIRES[key]
  return req ? req(graph) : true
}

export function availableViews(graph) {
  return VIEWS.filter((v) => isViewAvailable(graph, v.key))
}

export function availableViewKeys(graph) {
  return availableViews(graph).map((v) => v.key)
}

export function viewLabel(key) {
  return VIEWS.find((v) => v.key === key)?.label || key
}
