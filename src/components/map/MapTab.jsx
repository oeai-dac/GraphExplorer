import { useEffect, useMemo, useRef, useState } from 'react'
import { MapContainer, TileLayer, CircleMarker, Polyline, Polygon, useMap, LayerGroup } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { useStore } from '../../store'
import { hideNodeHover, scheduleNodeHoverAt } from '../shared/nodeHover'
import { typeColor, nodeColorOverride, typeLabel, edgeLabel, fmt, PALETTE } from '../../lib/schema'
import { buildGeoFeatures, neighborNodeIds, resolveFeatureCategory } from '../../lib/geo'
import { nextTileDepth } from '../../lib/tileDepth'
import { EpsgPrompt } from './EpsgPrompt'
import { MapSearch } from './MapSearch'
import { LayerControlPanel } from './LayerControlPanel'
import { IS_WEB } from '../../lib/webBuild'

// Wie tief man hineinzoomen kann. Bei 48° Breite entspricht Stufe 24 etwa
// 0,6 cm pro Bildschirmpunkt -- fein genug, um an einen einzelnen Befund
// heranzugehen. Hoeher wird nicht empfohlen: Leaflet rechnet Kartenpositionen
// in Pixeln der Gesamtwelt, und jenseits von etwa Stufe 25 wird diese Zahl so
// gross, dass beim Zusammensetzen der Ebenen Rundungsfehler sichtbar werden.
// Online-Anbieter liefern nur bis zu ihrer eigenen Tiefe (maxNativeZoom unten);
// darueber vergroessert Leaflet die letzte echte Kachel.
const MAX_ZOOM = 24

// Startansicht nicht tiefer als das. Der Ausschnitt wird auf die vorhandenen
// Geometrien gefittet, und bei genau einer Geometrie ist dieser Rahmen ein
// Punkt -- Leaflet ginge dann sofort auf MAX_ZOOM. Das zeigt nichts Brauchbares
// und laesst bei einem eigenen Kachelraster die erste Ansicht ins Leere laufen,
// weil kaum jemand bis Stufe 24 exportiert. Von Hand bleibt jede Stufe bis
// MAX_ZOOM erreichbar.
const INITIAL_FIT_MAX_ZOOM = 19

// Kachelquellen fuer den Kartenhintergrund.
//
// Entscheidend beim Weitergeben als einzelne HTML-Datei: eine per Doppelklick
// geoeffnete Seite laeuft unter file:// und sendet deshalb keinen Referer.
// Genau den verlangt die Tile Usage Policy von OpenStreetMap -- die Server
// antworten sonst mit einem "Access blocked"-Bild, und zwar mit HTTP 200. Fuer
// Leaflet sieht diese Kachel gueltig aus, der Hinweis landet also sichtbar auf
// der Karte. Alle Quellen hier ausser OSM liefern ohne Referer aus und
// funktionieren daher auch aus einer lokalen Datei heraus.
//
// maxNativeZoom = tiefste Stufe, die es beim Anbieter wirklich gibt; darueber
// skaliert Leaflet die vorhandene Kachel hoch, statt ins Leere zu laden.
const ALL_BASEMAPS = [
  {
    // CARTO's light basemap used to sit here; it now answers every
    // request without an API key with an "API KEY REQUIRED" tile.
    id: 'esri-light',
    label: 'Light grey (worldwide)',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; <a href="https://www.esri.com/">Esri</a> et al.',
    maxNativeZoom: 16,
  },
  {
    id: 'esri-ortho',
    label: 'Satellite (worldwide)',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; <a href="https://www.esri.com/">Esri</a> et al.',
    maxNativeZoom: 19,
  },
  {
    id: 'basemap-at',
    label: 'basemap.at (Austria only)',
    url: 'https://mapsneu.wien.gv.at/basemap/geolandbasemap/normal/google3857/{z}/{y}/{x}.png',
    attribution: 'Datenquelle: <a href="https://www.basemap.at/">basemap.at</a>',
    maxNativeZoom: 19,
  },
  {
    id: 'basemap-at-grau',
    label: 'basemap.at grey (Austria only)',
    url: 'https://mapsneu.wien.gv.at/basemap/bmapgrau/normal/google3857/{z}/{y}/{x}.png',
    attribution: 'Datenquelle: <a href="https://www.basemap.at/">basemap.at</a>',
    maxNativeZoom: 19,
  },
  {
    id: 'basemap-at-ortho',
    label: 'Orthophoto Austria',
    url: 'https://mapsneu.wien.gv.at/basemap/bmaporthofoto30cm/normal/google3857/{z}/{y}/{x}.jpeg',
    attribution: 'Datenquelle: <a href="https://www.basemap.at/">basemap.at</a>',
    maxNativeZoom: 19,
  },
  {
    // Eigenes Kachelraster neben der HTML-Datei, z.B. aus QGIS
    // (Verarbeitung -> "XYZ-Kacheln erzeugen (Verzeichnis)") oder gdal2tiles.
    // Der relative Pfad loest gegen den Ort der HTML-Datei auf und funktioniert
    // auch unter file://, weil Leaflet Kacheln als <img> laedt und dafuer keine
    // CORS-Pruefung greift.
    id: 'local',
    label: 'Own tiles (folder "tiles" next to it)',
    url: './tiles/{z}/{x}/{y}.png',
    attribution: 'Own tile set',
    // Wie tief ein selbst erzeugtes Kachelraster reicht, haengt davon ab, was
    // beim Export gewaehlt wurde -- deshalb kein fester Wert, sondern
    // Selbstjustierung zur Laufzeit (siehe useTileDepth weiter unten).
    adaptiveNativeZoom: true,
    maxNativeZoom: MAX_ZOOM,
  },
  {
    id: 'osm',
    label: 'OpenStreetMap (not with a local file)',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxNativeZoom: 19,
  },
  { id: 'none', label: 'No background', url: null, attribution: '', maxNativeZoom: 19 },
]
// Online gibt es kein "neben der HTML-Datei" -- dort entfällt das eigene Raster.
const BASEMAPS = IS_WEB ? ALL_BASEMAPS.filter((b) => b.id !== 'local') : ALL_BASEMAPS
const HIGHLIGHT_COLOR = '#1f8da6' // matches --gold; hardcoded so Leaflet's SVG
                                   // attribute path always resolves it (a CSS
                                   // var() reference isn't guaranteed to)
const NO_CATEGORY = '(no value)'

/**
 * Beobachtet ein selbst erzeugtes Kachelraster und meldet, bis zu welcher Stufe
 * es reicht. Die Entscheidungsregel steht in lib/tileDepth.js und wird dort
 * auch geprueft; hier bleibt nur das Mitschreiben.
 */
function useTileDepth(resetKey) {
  const loadedZooms = useRef(new Set())
  const [depth, setDepth] = useState(MAX_ZOOM)

  useEffect(() => {
    loadedZooms.current = new Set()
    setDepth(MAX_ZOOM)
  }, [resetKey])

  const handlers = useMemo(
    () => ({
      tileload(e) {
        const z = e?.coords?.z
        if (typeof z === 'number') loadedZooms.current.add(z)
      },
      tileerror(e) {
        setDepth((current) =>
          nextTileDepth({ current, errorZoom: e?.coords?.z, loadedZooms: loadedZooms.current }),
        )
      },
    }),
    [],
  )

  return [depth, handlers]
}

function featureBounds(features) {
  let minLat = Infinity, minLng = Infinity, maxLat = -Infinity, maxLng = -Infinity
  const walk = (c) => {
    if (Array.isArray(c) && typeof c[0] === 'number') {
      const [lat, lng] = c
      if (lat < minLat) minLat = lat
      if (lat > maxLat) maxLat = lat
      if (lng < minLng) minLng = lng
      if (lng > maxLng) maxLng = lng
      return
    }
    c.forEach(walk)
  }
  for (const f of features) walk(f.coordinates)
  if (!isFinite(minLat)) return null
  return [[minLat, minLng], [maxLat, maxLng]]
}

// Geometries carry no label of their own any more: hovering one opens the
// same quick-info card the rest of the app uses (see components/shared/
// nodeHover.js), which says what the feature IS -- type, attributes,
// connections -- instead of only repeating its label.
function renderFeature(feature, style, highlightStyle, isHighlighted, eventHandlers) {
  const pathOptions = isHighlighted ? highlightStyle : style
  // Including isHighlighted in the key forces a clean remount (instead of
  // relying on react-leaflet to push a pathOptions update into the already
  // -mounted Leaflet layer) whenever selection changes -- simple and
  // reliable for the handful of geometries typical here.
  const key = `${feature.nodeId}::${feature.attrKey}::${isHighlighted}`

  switch (feature.type) {
    case 'Point':
      return (
        <CircleMarker key={key} center={feature.coordinates} radius={isHighlighted ? 8 : 5} pathOptions={pathOptions} eventHandlers={eventHandlers} />
      )
    case 'MultiPoint':
      return feature.coordinates.map((c, i) => (
        <CircleMarker key={`${key}::${i}`} center={c} radius={isHighlighted ? 8 : 5} pathOptions={pathOptions} eventHandlers={eventHandlers} />
      ))
    case 'LineString':
    case 'MultiLineString':
      return (
        <Polyline key={key} positions={feature.coordinates} pathOptions={pathOptions} eventHandlers={eventHandlers} />
      )
    case 'Polygon':
    case 'MultiPolygon':
      return (
        <Polygon key={key} positions={feature.coordinates} pathOptions={pathOptions} eventHandlers={eventHandlers} />
      )
    default:
      return null
  }
}

// Smoothly brings the currently Explorer-selected feature(s) into view
// whenever the selection changes (or the Map tab becomes the active one
// with a selection already made elsewhere) -- a highlight the user has to
// go hunt for on the map isn't much of a highlight. Fits bounds around
// EVERY currently-highlighted feature (see highlightIds in MapTab), not
// just an exact node match, so panning also works when a SE with several
// linked Position-Determination geometries is selected.
function PanToSelection({ features, highlightIds, active }) {
  const map = useMap()
  useEffect(() => {
    if (!active || !highlightIds || !highlightIds.size) return
    const matched = features.filter((f) => highlightIds.has(f.nodeId))
    if (!matched.length) return
    const bounds = featureBounds(matched)
    if (!bounds) return

    // Careful with the map's SIZE here. While another tab was on top, this
    // panel was display:none, so Leaflet's cached size is 0x0 -- and deriving
    // a zoom from a zero-sized viewport gives NaN, at which point flyToBounds
    // throws "Invalid LatLng object: (NaN, NaN)". That exception used to take
    // the whole app down (blank page, graph gone) on the very ordinary path
    // "pick a node in the Explorer, switch to the map".
    //
    // So: wait one frame for the panel to actually be laid out, re-measure,
    // and only fly once there is a viewport to fly in.
    const frame = requestAnimationFrame(() => {
      map.invalidateSize({ animate: false })
      const size = map.getSize()
      if (!size.x || !size.y) return
      const zoom = map.getZoom()
      map.flyToBounds(bounds, {
        maxZoom: Number.isFinite(zoom) ? Math.max(zoom, 18) : 18,
        padding: [60, 60],
        duration: 0.6,
      })
    })
    return () => cancelAnimationFrame(frame)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightIds, active])
  return null
}

// Leaflet caches its container's size and only recomputes it when told to.
// In a Dashboard pane that cache goes stale on every splitter drag (and on
// every window resize), leaving the map drawn at its old size with grey gaps
// and click targets offset from what's on screen. Watching the container
// itself catches all of those, including the pane simply being shown again.
function InvalidateSizeOnResize() {
  const map = useMap()
  useEffect(() => {
    const el = map.getContainer()
    let frame = 0
    const ro = new ResizeObserver(() => {
      // Coalesce to one call per frame: a drag fires this continuously, and
      // resizing from inside the observer's own callback is what provokes
      // the browser's "ResizeObserver loop" warning.
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => map.invalidateSize({ animate: false }))
    })
    ro.observe(el)
    return () => {
      cancelAnimationFrame(frame)
      ro.disconnect()
    }
  }, [map])
  return null
}

export function MapTab({ active, domId = 'tab-map' }) {
  const graph = useStore((s) => s.graph)
  const schema = useStore((s) => s.schema)
  const geoEpsg = useStore((s) => s.geoEpsg)
  const setGeoEpsg = useStore((s) => s.setGeoEpsg)
  const selectedId = useStore((s) => s.selectedId)
  const openInExplorer = useStore((s) => s.openInExplorer)

  // All current search hits, when the user chose "Alle markieren" instead
  // of picking a single result -- takes priority over the normal
  // single-selection highlight below until cleared or a single result is
  // picked instead (see MapSearch's onHighlightAll/pick).
  const [multiHighlightIds, setMultiHighlightIds] = useState(null)

  // Per-layer categorization override: typeUri -> propKey. Each base-type
  // layer (Einmessung Fund, Einmessung SE, ...) independently defaults to
  // its own type color; picking a connection property for a given layer
  // (Material, Fundtyp, "found in SE", ...) via resolveFeatureCategory
  // instead splits JUST that layer into sub-layers by the resolved value,
  // e.g. coloring finds by material while SE geometries stay untouched.
  const [layerCategoryProp, setLayerCategoryProp] = useState({})

  // Which leaf layer keys are currently hidden (custom LayerControlPanel
  // manages its own visibility instead of react-leaflet's built-in
  // LayersControl, which can't group categorized sub-layers under their
  // parent type).
  const [hiddenKeys, setHiddenKeys] = useState(new Set())
  const [basemapId, setBasemapId] = useState(BASEMAPS[0].id)
  const [tileDepth, tileDepthHandlers] = useTileDepth(basemapId)

  const result = useMemo(() => {
    if (!graph || !geoEpsg) return null
    return buildGeoFeatures(graph, geoEpsg)
  }, [graph, geoEpsg])

  // Either every id from an active "Alle markieren" search selection, or
  // the single selected node -- each expanded with its own one-hop
  // neighbors, so selecting a SE that links to several Position-
  // Determination nodes (each carrying its own geometry) highlights all of
  // them, not just an exact node match. Generic by construction: a
  // neighbor without a geometry simply never appears in `features` below,
  // so it can't get spuriously highlighted.
  const highlightIds = useMemo(() => {
    if (!graph) return new Set()
    const seedIds = multiHighlightIds && multiHighlightIds.length ? multiHighlightIds : (selectedId ? [selectedId] : [])
    if (!seedIds.length) return new Set()
    const ids = new Set()
    for (const id of seedIds) {
      ids.add(id)
      neighborNodeIds(graph, id).forEach((n) => ids.add(n))
    }
    return ids
  }, [graph, selectedId, multiHighlightIds])

  // Search candidate pool: every geometry-bearing node plus its one-hop
  // neighbors (so a SE is findable by its own label even though the
  // geometry itself lives on its Position-Determination children).
  const candidateIds = useMemo(() => {
    if (!graph || !result) return []
    const ids = new Set()
    for (const f of result.features) {
      ids.add(f.nodeId)
      neighborNodeIds(graph, f.nodeId).forEach((n) => ids.add(n))
    }
    return [...ids]
  }, [graph, result])

  // Per base-type: which node ids are in scope for that type's own
  // categorization picker (its own geometry nodes plus their one-hop
  // neighbors, e.g. a Fund's Material sits one hop beyond its "Einmessung
  // Fund" geometry node), and which connection properties are available
  // there. Scoped per type so each layer's dropdown only offers properties
  // that are actually meaningful for ITS nodes, not a mix of every type's.
  const typeConnectionProps = useMemo(() => {
    if (!graph || !result) return new Map()
    const idsByType = new Map()
    for (const f of result.features) {
      const t = graph.nodes[f.nodeId]?.t || ''
      if (!idsByType.has(t)) idsByType.set(t, new Set())
      idsByType.get(t).add(f.nodeId)
      neighborNodeIds(graph, f.nodeId).forEach((n) => idsByType.get(t).add(n))
    }
    const propsByType = new Map()
    for (const [t, ids] of idsByType) {
      const keys = new Set()
      for (const id of ids) {
        const nd = graph.nodes[id]
        if (!nd) continue
        Object.keys(nd.o || {}).forEach((k) => keys.add(k))
        Object.keys(nd.i || {}).forEach((k) => keys.add(k))
      }
      propsByType.set(t, [...keys].sort((a, b) => edgeLabel(schema, a).localeCompare(edgeLabel(schema, b))))
    }
    return propsByType
  }, [graph, result, schema])

  if (!graph) return null

  if (!geoEpsg) {
    return (
      <div className={'panel' + (active ? ' on' : '')} id={domId}>
        <div className="sec-hdr">
          <h2>Map</h2>
        </div>
        <EpsgPrompt onSubmit={setGeoEpsg} />
      </div>
    )
  }

  if (!result) {
    return (
      <div className={'panel' + (active ? ' on' : '')} id={domId}>
        <div className="sec-hdr">
          <h2>Map</h2>
        </div>
        <EpsgPrompt onSubmit={setGeoEpsg} error={`"${geoEpsg}" was not recognised. Please enter a valid EPSG code or a proj4 definition (starting with "+proj=").`} />
      </div>
    )
  }

  const { features, failedCount, totalCount } = result
  const bounds = featureBounds(features)
  // Render highlighted features last so they draw on top of overlapping
  // neighbours instead of potentially being hidden underneath them.
  const orderedFeatures = [...features].sort((a, b) => (highlightIds.has(a.nodeId) ? 1 : 0) - (highlightIds.has(b.nodeId) ? 1 : 0))

  // Base layer per node type first (each canvas node's "Explorer-Name"
  // already gives these a distinct, readable identity even when several
  // share the same underlying CIDOC class, see typeLabel/typeColor), then
  // expand any type that has a per-layer categorization override into
  // sub-layers by the resolved connection value instead -- only that type
  // splits, every other layer is untouched.
  const baseGroups = new Map() // typeUri -> features[]
  for (const f of orderedFeatures) {
    const t = graph.nodes[f.nodeId]?.t || ''
    if (!baseGroups.has(t)) baseGroups.set(t, [])
    baseGroups.get(t).push(f)
  }
  const sortedTypeKeys = [...baseGroups.keys()].sort((a, b) => typeLabel(schema, a).localeCompare(typeLabel(schema, b)))

  // layerTree: one entry per base type, either a plain leaf (default color,
  // no children) or a parent whose `children` are its sub-category leaves
  // -- this nesting is exactly what LayerControlPanel groups in the UI, so
  // "Einmessung Fund" lists its materials underneath instead of each
  // material showing up as an unrelated flat entry.
  const layerTree = sortedTypeKeys.map((t) => {
    const feats = baseGroups.get(t)
    const label = typeLabel(schema, t) || '(no type)'
    const prop = layerCategoryProp[t]
    if (!prop) {
      return { key: t, label, color: typeColor(schema, t), count: feats.length, features: feats, children: null }
    }
    const byCat = new Map()
    for (const f of feats) {
      const cat = resolveFeatureCategory(graph, f.nodeId, prop) || NO_CATEGORY
      if (!byCat.has(cat)) byCat.set(cat, [])
      byCat.get(cat).push(f)
    }
    const sortedCats = [...byCat.keys()].sort((a, b) => byCat.get(b).length - byCat.get(a).length)
    const children = sortedCats.map((cat, i) => ({
      key: t + '::' + cat,
      label: cat,
      color: PALETTE[i % PALETTE.length],
      count: byCat.get(cat).length,
      features: byCat.get(cat),
    }))
    return { key: t, label, count: feats.length, children }
  })
  // Flat leaf list for actually rendering map layers -- a categorized
  // type contributes its children, an uncategorized one contributes itself.
  const flatLayers = layerTree.flatMap((g) => g.children || [g])

  function toggleLayer(key) {
    setHiddenKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  function toggleGroup(group) {
    const allVisible = group.children.every((c) => !hiddenKeys.has(c.key))
    setHiddenKeys((prev) => {
      const next = new Set(prev)
      for (const c of group.children) {
        if (allVisible) next.add(c.key)
        else next.delete(c.key)
      }
      return next
    })
  }

  const basemap = BASEMAPS.find((b) => b.id === basemapId) || BASEMAPS[0]
  const nativeZoom = basemap.adaptiveNativeZoom ? tileDepth : basemap.maxNativeZoom

  return (
    <div className={'panel' + (active ? ' on' : '')} id={domId}>
      <div className="sec-hdr">
        <h2>Map</h2>
        <span className="badge">{fmt(features.length)} geometries</span>
        <span
          style={{ fontSize: '.7rem', color: 'var(--tx3)', cursor: 'pointer', textDecoration: 'underline dotted' }}
          onClick={() => setGeoEpsg(null)}
          title="Use a different coordinate system"
        >
          Change EPSG {geoEpsg}
        </span>
        {failedCount > 0 && (
          <span className="badge" style={{ color: '#c94052', borderColor: '#c9405266' }}>
            {failedCount} of {totalCount} geometries not readable
          </span>
        )}
        {multiHighlightIds && multiHighlightIds.length > 0 && (
          <span className="badge" style={{ color: 'var(--gold)', borderColor: 'rgba(31,141,166,.4)', cursor: 'pointer' }} onClick={() => setMultiHighlightIds(null)}>
            {fmt(multiHighlightIds.length)} matches marked &middot; reset
          </span>
        )}
      </div>

      <div className="frow" style={{ alignItems: 'center' }}>
        <MapSearch
          graph={graph}
          schema={schema}
          candidateIds={candidateIds}
          onHighlightAll={setMultiHighlightIds}
        />
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 'auto' }}>
          <span style={{ fontSize: '.68rem', color: 'var(--tx3)', flexShrink: 0 }}>Background:</span>
          <select
            className="sl"
            style={{ fontSize: '.68rem', padding: '2px 6px', minHeight: 0, width: 'auto' }}
            value={basemapId}
            onChange={(e) => setBasemapId(e.target.value)}
            title="Change the map background"
          >
            {BASEMAPS.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
          </select>
        </span>
      </div>

      <div className="frow" style={{ alignItems: 'center', rowGap: 4 }}>
        <span style={{ fontSize: '.68rem', color: 'var(--tx3)', flexShrink: 0 }}>Categorise:</span>
        {sortedTypeKeys.map((t) => (
          <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span style={{ fontSize: '.68rem', color: 'var(--tx2)' }}>{typeLabel(schema, t) || '(no type)'}</span>
            <select
              className="sl"
              style={{ fontSize: '.68rem', padding: '2px 6px', minHeight: 0, width: 'auto' }}
              value={layerCategoryProp[t] || ''}
              onChange={(e) => setLayerCategoryProp((m) => ({ ...m, [t]: e.target.value }))}
            >
              <option value="">Default</option>
              {(typeConnectionProps.get(t) || []).map((p) => <option key={p} value={p}>{edgeLabel(schema, p)}</option>)}
            </select>
          </span>
        ))}
      </div>

      <div style={{ flex: 1, border: '1px solid var(--bd)', borderRadius: 'var(--r)', overflow: 'hidden' }}>
        {!features.length ? (
          <div className="det-empty">No displayable geometries found</div>
        ) : (
          <MapContainer bounds={bounds} boundsOptions={{ padding: [30, 30], maxZoom: INITIAL_FIT_MAX_ZOOM }} maxZoom={MAX_ZOOM} style={{ height: '100%', width: '100%', background: 'var(--bg2)' }}>
            {basemap.url && (
              // Der key umfasst bewusst auch die Kacheltiefe: react-leaflet
              // reicht nur wenige geaenderte Optionen an eine bestehende Ebene
              // weiter, maxNativeZoom gehoert nicht dazu. Ohne den Wechsel im
              // key bliebe eine nachtraeglich erkannte Tiefe wirkungslos.
              <TileLayer
                key={basemap.id + ':' + nativeZoom}
                attribution={basemap.attribution}
                url={basemap.url}
                maxZoom={MAX_ZOOM}
                maxNativeZoom={nativeZoom}
                eventHandlers={basemap.adaptiveNativeZoom ? tileDepthHandlers : undefined}
              />
            )}
            <InvalidateSizeOnResize />
            <PanToSelection features={features} highlightIds={highlightIds} active={active} />
            {flatLayers.map(({ key, color: layerColor, features: groupFeatures }) => (
              hiddenKeys.has(key) ? null : (
                <LayerGroup key={key}>
                  {groupFeatures.map((f) => {
                    const isHighlighted = highlightIds.has(f.nodeId)
                    // A color given to this one node beats the layer's -- the
                    // layer color may be a category, not a type, so only an
                    // explicit per-node override may override it.
                    const color = nodeColorOverride(schema, f.nodeId) || layerColor
                    const style = { color, weight: 1.5, fillColor: color, fillOpacity: 0.3 }
                    const highlightStyle = { color: HIGHLIGHT_COLOR, weight: 3, fillColor: HIGHLIGHT_COLOR, fillOpacity: 0.45 }
                    const handlers = {
                      click: () => { setMultiHighlightIds(null); openInExplorer(f.nodeId) },
                      // Anchored at the cursor rather than the geometry: a
                      // polygon's bounding box can be most of the screen, so
                      // placing the card beside IT would put it anywhere but
                      // next to the mouse.
                      mouseover: (ev) => scheduleNodeHoverAt(f.nodeId, ev.originalEvent?.clientX, ev.originalEvent?.clientY),
                      mouseout: hideNodeHover,
                    }
                    return renderFeature(f, style, highlightStyle, isHighlighted, handlers)
                  })}
                </LayerGroup>
              )
            ))}
            <LayerControlPanel groups={layerTree} hiddenKeys={hiddenKeys} onToggle={toggleLayer} onToggleGroup={toggleGroup} />
          </MapContainer>
        )}
      </div>
    </div>
  )
}
