// Layout tree behind the Dashboard tab: Blender-style recursive binary
// splits, where every area can be split again, resized at its edge and
// merged back into its sibling.
//
// Deliberately free of React and the DOM -- data in, data out -- so the whole
// thing can be exercised straight from Node
// (tests/fixtures/run-dashboard-layout-check.mjs).
//
// A node is either
//   { id, type: 'pane',  view: 'map' }
//   { id, type: 'split', dir: 'row' | 'col', ratio: 0..1, a: node, b: node }
//
// 'row' places `a` LEFT of `b`, 'col' places `a` ABOVE `b`. `ratio` is the
// share of the parent taken by `a`.
//
// Every operation returns a NEW tree but reuses untouched branches by
// reference. That structural sharing is what lets the pane components skip
// re-rendering while a splitter is being dragged -- without it, every mouse
// move would re-render each open map and matrix.

// Panes narrower than this are useless, so a splitter can't be dragged past it.
export const MIN_RATIO = 0.12
export const MAX_RATIO = 0.88

// Guard rails for restored/hand-edited layouts. Each open pane is a full view
// (a Leaflet map, a ReactFlow canvas, ...), so an unbounded arrangement is a
// performance trap rather than a feature.
export const MAX_PANES = 12
const MAX_DEPTH = 10

let idCounter = 0
function nextId() {
  return 'n' + ++idCounter
}

export function clampRatio(r) {
  if (!Number.isFinite(r)) return 0.5
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, r))
}

export function pane(view) {
  return { id: nextId(), type: 'pane', view }
}

export function split(dir, a, b, ratio = 0.5) {
  return { id: nextId(), type: 'split', dir: dir === 'col' ? 'col' : 'row', ratio: clampRatio(ratio), a, b }
}

export function defaultLayout() {
  return pane('explore')
}

// -- queries ----------------------------------------------------------------

export function listPanes(tree) {
  const out = []
  const walk = (n) => {
    if (!n) return
    if (n.type === 'pane') out.push(n)
    else {
      walk(n.a)
      walk(n.b)
    }
  }
  walk(tree)
  return out
}

export function countPanes(tree) {
  return listPanes(tree).length
}

// -- transformations --------------------------------------------------------

// Bottom-up rewrite: `fn` sees every node after its children were rewritten.
// A node whose children are unchanged is returned as-is, which is where the
// structural sharing comes from.
function rewrite(node, fn) {
  let n = node
  if (n.type === 'split') {
    const a = rewrite(n.a, fn)
    const b = rewrite(n.b, fn)
    if (a !== n.a || b !== n.b) n = { ...n, a, b }
  }
  return fn(n)
}

export function setPaneView(tree, paneId, view) {
  return rewrite(tree, (n) => (n.type === 'pane' && n.id === paneId && n.view !== view ? { ...n, view } : n))
}

export function setSplitRatio(tree, splitId, ratio) {
  const r = clampRatio(ratio)
  return rewrite(tree, (n) => (n.type === 'split' && n.id === splitId && n.ratio !== r ? { ...n, ratio: r } : n))
}

// Split `paneId` in two. The existing pane keeps its view and its position
// (left/top), the new one starts on the same view unless told otherwise --
// mirroring Blender, where a fresh area is a copy you then switch over.
export function splitPane(tree, paneId, dir, newView) {
  if (countPanes(tree) >= MAX_PANES) return tree
  return rewrite(tree, (n) => {
    if (n.type !== 'pane' || n.id !== paneId) return n
    return split(dir, n, pane(newView || n.view))
  })
}

function removePane(node, paneId) {
  if (node.type === 'pane') return node.id === paneId ? null : node
  const a = removePane(node.a, paneId)
  const b = removePane(node.b, paneId)
  if (a === node.a && b === node.b) return node
  // The surviving sibling takes over the space the split occupied.
  if (!a) return b
  if (!b) return a
  return { ...node, a, b }
}

// Closing the only remaining pane would leave an empty dashboard, so that
// one request is ignored rather than handled.
export function closePane(tree, paneId) {
  return removePane(tree, paneId) || tree
}

// -- persistence ------------------------------------------------------------

// Rebuild a layout from untrusted input (localStorage, an older version of
// this file, a hand-edited value). Anything unrecognized is dropped rather
// than trusted; panes on views the current graph can't show are dropped too
// when `allowedViews` is given. Returns null if nothing usable is left, in
// which case the caller falls back to defaultLayout().
//
// Every node gets a fresh id on the way through, so a restored layout can
// never collide with ids handed out earlier in this session.
export function sanitizeLayout(raw, allowedViews) {
  const viewOk = (v) => typeof v === 'string' && (!allowedViews || allowedViews.includes(v))
  // Nesting past MAX_DEPTH means the value isn't something this app wrote.
  // Truncating it would silently hand back an arrangement nobody asked for,
  // so the whole input is rejected and the caller starts from the default.
  let tooDeep = false

  const walk = (n, depth) => {
    if (!n || typeof n !== 'object') return null
    if (depth > MAX_DEPTH) {
      tooDeep = true
      return null
    }
    if (n.type === 'pane') return viewOk(n.view) ? pane(n.view) : null
    if (n.type === 'split') {
      const a = walk(n.a, depth + 1)
      const b = walk(n.b, depth + 1)
      // A pane dropped for an unavailable view leaves its sibling in place --
      // that half of the arrangement is still exactly what the user built.
      if (!a) return b
      if (!b) return a
      return split(n.dir, a, b, n.ratio)
    }
    return null
  }

  const tree = walk(raw, 0)
  if (!tree || tooDeep || countPanes(tree) > MAX_PANES) return null
  return tree
}

// -- presets ----------------------------------------------------------------

// Ready-made arrangements offered in the Dashboard toolbar. `v` resolves a
// wanted view against what the loaded graph actually supports, so a preset
// never lands the user on a dead pane.
export const PRESETS = [
  {
    key: 'single',
    label: 'One pane',
    build: (v) => pane(v('explore')),
  },
  {
    key: 'side',
    label: 'Explorer │ Map',
    build: (v) => split('row', pane(v('explore')), pane(v('map'))),
  },
  {
    key: 'triple',
    label: 'Explorer │ Map ╱ Matrix',
    build: (v) => split('col', split('row', pane(v('explore')), pane(v('map'))), pane(v('matrix')), 0.62),
  },
  {
    key: 'quad',
    label: 'Four panes',
    build: (v) => split('col', split('row', pane(v('explore')), pane(v('map'))), split('row', pane(v('matrix')), pane(v('charts')))),
  },
]

export function buildPreset(key, allowedViews) {
  const preset = PRESETS.find((p) => p.key === key)
  if (!preset) return null
  const fallback = allowedViews?.[0] || 'overview'
  const v = (want) => (!allowedViews || allowedViews.includes(want) ? want : fallback)
  return preset.build(v)
}
