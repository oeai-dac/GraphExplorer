// Which node the hover quick-info card is currently showing, kept in a tiny
// module-level store rather than in the app store or a context.
//
// The reason is re-rendering: hovering happens constantly, and every node
// list in the app would re-render on each hover if this lived anywhere the
// lists subscribe to. Here, only <NodeHoverCard> subscribes, so moving the
// mouse across a 50-row list re-renders exactly one component.

import { useSyncExternalStore } from 'react'

// Long enough that sweeping the mouse across a list doesn't flash cards,
// short enough to feel immediate when you actually stop on a row.
const SHOW_DELAY = 320

let target = null // { nodeId, rect }
let timer = 0
const listeners = new Set()

function emit() {
  for (const l of listeners) l()
}

function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot() {
  return target
}

function open(nodeId, rect) {
  if (!rect) return
  target = { nodeId, rect }
  emit()
}

/** Show the card next to `el` after the hover delay. */
export function scheduleNodeHover(nodeId, el) {
  if (!nodeId || !el) return
  clearTimeout(timer)
  timer = setTimeout(() => {
    const r = el.getBoundingClientRect?.()
    // A zero-size box means the element left the layout while we were
    // waiting (list re-rendered, pane closed) -- nothing to anchor to.
    if (!r || (!r.width && !r.height)) return
    open(nodeId, { top: r.top, left: r.left, right: r.right, bottom: r.bottom })
  }, SHOW_DELAY)
}

/** Show the card next to a point instead of an element -- for hovers that
    have no DOM element of their own, like Leaflet's canvas geometries. */
export function scheduleNodeHoverAt(nodeId, x, y) {
  if (!nodeId || !Number.isFinite(x) || !Number.isFinite(y)) return
  clearTimeout(timer)
  timer = setTimeout(() => open(nodeId, { top: y - 8, left: x - 8, right: x + 8, bottom: y + 8 }), SHOW_DELAY)
}

export function hideNodeHover() {
  clearTimeout(timer)
  timer = 0
  if (target) {
    target = null
    emit()
  }
}

/**
 * Props to spread onto any element that stands for a node:
 *
 *   <div className="li" {...nodeHoverProps(id)} onClick={...}>
 *
 * Deliberately a plain function, not a hook: node rows are rendered inside
 * .map() callbacks whose length changes with paging and filtering, where a
 * hook would break the rules of hooks. Recreating two handler closures per
 * row is far cheaper than restructuring every list into subcomponents.
 *
 * `enabled` turns it into a no-op for rows that have nothing to preview
 * (an id the graph doesn't actually carry, an image thumbnail).
 */
export function nodeHoverProps(nodeId, enabled = true) {
  if (!enabled || !nodeId) return {}
  return {
    onMouseEnter: (e) => {
      // React clears currentTarget once the handler returns, so it has to be
      // read now -- the timeout below runs long after that.
      scheduleNodeHover(nodeId, e.currentTarget)
    },
    onMouseLeave: hideNodeHover,
  }
}

export function useHoverTarget() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
