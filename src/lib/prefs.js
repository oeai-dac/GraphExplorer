// User customizations (type colors, attribute order) persisted client-side
// for now, since the Graph Explorer has no backend of its own yet. Kept in
// this one small, versioned shape so a later move to a real backend (e.g.
// folding it into OntoCartographer Studio's project files) is just swapping
// this module's implementation for API calls -- the shape and call sites
// elsewhere don't need to change.

const STORAGE_KEY = 'ge:explorerPrefs:v1'

const EMPTY_PREFS = { typeColors: {}, nodeColors: {}, attrOrder: {}, connOrder: {}, dashboard: null }

export function loadPrefs() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...EMPTY_PREFS }
    const parsed = JSON.parse(raw)
    return {
      typeColors: parsed.typeColors || {},
      // Colors given to single nodes (node id -> hex), which win over their
      // type's color -- see lib/schema.js nodeColor().
      nodeColors: parsed.nodeColors || {},
      attrOrder: parsed.attrOrder || {},
      connOrder: parsed.connOrder || {},
      // Dashboard split-tree; never trusted as-is, the store runs it through
      // sanitizeLayout() before use (see lib/dashboardLayout.js).
      dashboard: parsed.dashboard || null,
    }
  } catch {
    return { ...EMPTY_PREFS }
  }
}

export function savePrefs(prefs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // localStorage unavailable (private browsing / quota) -- customizations
    // just won't survive a reload, not worth surfacing an error for.
  }
}

// Same thing, but coalesced: dragging a Dashboard splitter produces a new
// layout on every pointer move, and writing each one straight through would
// mean a JSON serialization per frame for no gain.
let pendingSave = null
export function savePrefsSoon(prefs) {
  clearTimeout(pendingSave)
  pendingSave = setTimeout(() => savePrefs(prefs), 400)
}
