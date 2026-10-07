import { create } from 'zustand'
import { deriveSchema, withPaletteColors } from './lib/schema'
import { collapseTypes } from './lib/collapse'
import { loadPrefs, savePrefs, savePrefsSoon } from './lib/prefs'
import { defaultLayout, sanitizeLayout } from './lib/dashboardLayout'

const TRAIL_MAX = 30

const initialPrefs = loadPrefs()

// Vorbelegung fuer das Koordinatensystem der Geometrien.
//
// Die App fragt bewusst nach, statt zu raten: rohes WKT traegt hier keine SRID,
// und eine falsche Annahme wuerde Geometrien still an den falschen Ort setzen.
// Wer den Datensatz aber kennt, kann die Frage vorab beantworten -- der
// Standalone-Build tut das (siehe scripts/build-standalone.mjs), weil dort
// feststeht, welche Daten mitgeschickt werden. Ohne Vorgabe bleibt es beim
// Nachfragen, und aendern laesst sie sich in beiden Faellen weiterhin ueber
// "EPSG ... ändern" im Karten-Tab.
const DEFAULT_GEO_EPSG =
  (typeof window !== 'undefined' && window.__GRAPH_EXPLORER_EPSG__) || null

// Derive the read-model the whole app consumes (schema, node index) from a
// display graph. Shared by loadGraph and the collapse toggle so both paths
// stay in sync.
function deriveGraphState(graph, prefs) {
  const baseSchema = deriveSchema(graph)
  const nodeIds = Object.keys(graph.nodes)
  const typeIndex = {}
  nodeIds.forEach((id) => {
    const t = graph.nodes[id].t
    if (!typeIndex[t]) typeIndex[t] = []
    typeIndex[t].push(id)
  })
  return { graph, baseSchema, schema: mergeSchema(baseSchema, prefs), nodeIds, typeIndex }
}

// `schema` (used everywhere else in the app) is always the graph's own
// derived/embedded schema with the user's saved color/attribute-order
// overrides layered on top -- so every existing typeColor()/mainAttrs
// call site picks up customizations automatically, with no changes needed
// beyond where the overrides are actually set.
// Where an "open this in the Explorer" action should land. The Dashboard
// shows the Explorer next to the view that was clicked and shares this very
// state with it, so switching tabs there would tear down the arrangement the
// user just built -- stay put and let their Explorer pane, if they have one,
// pick the selection up.
function explorerTab(get) {
  return get().activeTab === 'dashboard' ? 'dashboard' : 'explore'
}

function mergeSchema(baseSchema, prefs) {
  if (!baseSchema) return null
  return {
    ...baseSchema,
    typeColors: { ...baseSchema.typeColors, ...prefs.typeColors },
    // Purely a user layer -- a graph never brings per-node colors along, they
    // exist so a single node ("Bronze/Kupfer") can be picked out of its type.
    nodeColors: prefs.nodeColors,
    mainAttrs: { ...baseSchema.mainAttrs, ...prefs.attrOrder },
  }
}

export const useStore = create((set, get) => ({
  // -- Graph data --
  graph: null,       // the DISPLAY graph (baseGraph, optionally with types collapsed)
  baseGraph: null,   // the originally loaded graph, kept intact for collapse toggling
  collapsedTypes: [], // node type keys currently collapsed/bypassed (see lib/collapse.js)
  baseSchema: null, // schema as derived from the loaded graph, before overrides
  schema: null,      // baseSchema + prefs overrides -- what the rest of the app reads
  nodeIds: [],
  typeIndex: {},
  loadError: '',

  // User customizations (type colors, attribute display order, dashboard
  // arrangement), persisted to localStorage for now -- see lib/prefs.js.
  prefs: initialPrefs,

  // -- UI state --
  activeTab: 'overview',

  // Dashboard tab: the split tree of panes (lib/dashboardLayout.js). Restored
  // from prefs, but only after sanitizing -- it comes from localStorage.
  // Views the current graph can't show are handled per pane at render time,
  // not by rewriting the layout, so they come back when a graph that does
  // support them is loaded.
  dashboardLayout: sanitizeLayout(initialPrefs.dashboard) || defaultLayout(),

  // Explorer tab
  explorerQuery: '',
  explorerType: '',
  explorerConditions: [], // advanced FilterBuilder conditions, see lib/filters.js
  explorerPage: 0,
  trail: [], // [{ id, label, type }]
  selectedId: null,

  // Map tab: CRS of the loaded dataset's WKT geometries, set once per
  // dataset by the user (EPSG code or a raw proj4 definition string) since
  // it can't be inferred from the WKT text itself.
  geoEpsg: DEFAULT_GEO_EPSG,

  loadGraph(data) {
    if (!data || !data.nodes) {
      set({ loadError: 'No nodes found (expected { nodes: {...}, ... })' })
      return
    }
    data = withPaletteColors(data)
    set({
      baseGraph: data,
      collapsedTypes: [],
      ...deriveGraphState(data, get().prefs),
      loadError: '',
      activeTab: 'overview',
      explorerQuery: '',
      explorerType: '',
      explorerConditions: [],
      explorerPage: 0,
      trail: [],
      selectedId: null,
      geoEpsg: DEFAULT_GEO_EPSG,
    })
  },

  // Collapse ("bypass") or re-expand a pass-through node type: removes those
  // nodes and links their neighbours directly (lib/collapse.js). The display
  // graph is always rebuilt from the untouched baseGraph, so toggling is free
  // and reversible. Node ids change, so navigation/paging is reset.
  toggleCollapseType(type) {
    const { baseGraph, collapsedTypes, prefs } = get()
    if (!baseGraph) return
    const next = collapsedTypes.includes(type)
      ? collapsedTypes.filter((x) => x !== type)
      : [...collapsedTypes, type]
    const display = next.length ? collapseTypes(baseGraph, next) : baseGraph
    set({
      collapsedTypes: next,
      ...deriveGraphState(display, prefs),
      explorerPage: 0,
      trail: [],
      selectedId: null,
    })
  },

  setLoadError(msg) {
    set({ loadError: msg })
  },

  setGeoEpsg(epsg) {
    set({ geoEpsg: epsg })
  },

  reset() {
    set({
      graph: null, baseGraph: null, collapsedTypes: [], baseSchema: null, schema: null,
      nodeIds: [], typeIndex: {}, loadError: '',
      activeTab: 'overview', explorerQuery: '', explorerType: '', explorerConditions: [], explorerPage: 0,
      trail: [], selectedId: null, geoEpsg: DEFAULT_GEO_EPSG,
    })
  },

  // -- User preference overrides (colors, attribute order) --
  setTypeColor(type, color) {
    const prefs = { ...get().prefs, typeColors: { ...get().prefs.typeColors, [type]: color } }
    savePrefs(prefs)
    set({ prefs, schema: mergeSchema(get().baseSchema, prefs) })
  },
  resetTypeColor(type) {
    const typeColors = { ...get().prefs.typeColors }
    delete typeColors[type]
    const prefs = { ...get().prefs, typeColors }
    savePrefs(prefs)
    set({ prefs, schema: mergeSchema(get().baseSchema, prefs) })
  },
  // Same, but for one single node: a color set here beats its type's color
  // wherever that node is drawn (list dots, hover card, Matrix, Zeitstrahl,
  // Karte). Node ids are stable across datasets only if the datasets share
  // them -- an override for an id the current graph doesn't have simply
  // never applies, so nothing has to be cleaned up on load.
  setNodeColor(id, color) {
    const prefs = { ...get().prefs, nodeColors: { ...(get().prefs.nodeColors || {}), [id]: color } }
    savePrefs(prefs)
    set({ prefs, schema: mergeSchema(get().baseSchema, prefs) })
  },
  resetNodeColor(id) {
    const nodeColors = { ...get().prefs.nodeColors }
    delete nodeColors[id]
    const prefs = { ...get().prefs, nodeColors }
    savePrefs(prefs)
    set({ prefs, schema: mergeSchema(get().baseSchema, prefs) })
  },
  setAttrOrder(type, orderedKeys) {
    const prefs = { ...get().prefs, attrOrder: { ...get().prefs.attrOrder, [type]: orderedKeys } }
    savePrefs(prefs)
    set({ prefs, schema: mergeSchema(get().baseSchema, prefs) })
  },
  resetAttrOrder(type) {
    const attrOrder = { ...get().prefs.attrOrder }
    delete attrOrder[type]
    const prefs = { ...get().prefs, attrOrder }
    savePrefs(prefs)
    set({ prefs, schema: mergeSchema(get().baseSchema, prefs) })
  },
  // Connection/neighbor-group order isn't read through the merged schema
  // (only NodeDetail uses it), so these just update prefs directly.
  setConnOrder(type, orderedKeys) {
    const prefs = { ...get().prefs, connOrder: { ...get().prefs.connOrder, [type]: orderedKeys } }
    savePrefs(prefs)
    set({ prefs })
  },
  resetConnOrder(type) {
    const connOrder = { ...get().prefs.connOrder }
    delete connOrder[type]
    const prefs = { ...get().prefs, connOrder }
    savePrefs(prefs)
    set({ prefs })
  },

  // Dashboard arrangement. Kept in prefs so it survives a reload and a new
  // import -- it describes how the user likes to work, not the data. The
  // write itself is coalesced because splitter drags update this on every
  // pointer move.
  setDashboardLayout(layout) {
    const prefs = { ...get().prefs, dashboard: layout }
    savePrefsSoon(prefs)
    set({ prefs, dashboardLayout: layout })
  },

  setActiveTab(tab) {
    set({ activeTab: tab })
  },

  setExplorerQuery(q) {
    set({ explorerQuery: q, explorerPage: 0 })
  },
  setExplorerType(t) {
    set({ explorerType: t, explorerPage: 0 })
  },
  setExplorerConditions(conditions) {
    set({ explorerConditions: conditions, explorerPage: 0 })
  },
  setExplorerPage(p) {
    set({ explorerPage: p })
  },

  // Jump to the Explorer tab, pre-filtered by node type (from Overview clicks)
  openExplorerFiltered(type) {
    set({ activeTab: explorerTab(get), explorerType: type || '', explorerQuery: '', explorerConditions: [], explorerPage: 0 })
  },

  // Jump to the Explorer tab with a full type + advanced-filter scope (from
  // a Charts tab bar click) -- re-expresses the bar's grouping as an
  // explicit condition so the two features close the loop: chart -> filter.
  openExplorerWithFilter(type, conditions) {
    set({ activeTab: explorerTab(get), explorerType: type || '', explorerQuery: '', explorerConditions: conditions || [], explorerPage: 0 })
  },

  // Jump to the Explorer tab and select a specific node (from Overview/Search clicks)
  openInExplorer(id) {
    set({ activeTab: explorerTab(get), explorerType: '', explorerQuery: '', explorerConditions: [], explorerPage: 0 })
    get().navigateTo(id, true)
  },

  navigateTo(nodeId, addTrail) {
    const { graph, trail } = get()
    if (addTrail) {
      const nd = graph?.nodes?.[nodeId]
      if (nd) {
        let nextTrail = trail
        if (!trail.length || trail[trail.length - 1].id !== nodeId) {
          nextTrail = [...trail, { id: nodeId, label: nd.l, type: nd.t }]
          if (nextTrail.length > TRAIL_MAX) nextTrail = nextTrail.slice(-TRAIL_MAX)
        }
        set({ trail: nextTrail })
      }
    }
    set({ selectedId: nodeId })
  },

  navigateBack() {
    const { trail } = get()
    if (trail.length <= 1) return
    const nextTrail = trail.slice(0, -1)
    const prev = nextTrail[nextTrail.length - 1]
    set({ trail: nextTrail, selectedId: prev.id })
  },

  // Breadcrumb chip click: truncate the trail at that point
  navigateToTrailIndex(idx) {
    const { trail } = get()
    const nextTrail = trail.slice(0, idx + 1)
    set({ trail: nextTrail, selectedId: nextTrail[nextTrail.length - 1].id })
  },
}))
