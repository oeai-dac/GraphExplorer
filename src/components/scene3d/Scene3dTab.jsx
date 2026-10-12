import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../../store'
import { hideNodeHover, scheduleNodeHoverAt } from '../shared/nodeHover'
import { typeColor, nodeColorOverride, typeLabel, edgeLabel, fmt, PALETTE } from '../../lib/schema'
import { hasGeoData, neighborNodeIds, resolveFeatureCategory, connectionPropsByType } from '../../lib/geo'
import { buildScene3dFeatures, featureBounds3d, buildNameIndex, matchObjectName } from '../../lib/scene3d'
import { IS_WEB, EXAMPLE_MODEL_URL, EXAMPLE_MTL_URL } from '../../lib/webBuild'
import { EpsgPrompt } from '../map/EpsgPrompt'
import { LayerControlPanel } from '../map/LayerControlPanel'
import { ObjectListPanel } from './ObjectListPanel'
import { Viewer } from './viewer'
import { loadObjFiles, parseObj } from './loadObj'

const UNMATCHED = '__unmatched'
const NO_CATEGORY = '(no value)'
const NO_FEATURES = [] // stable, so "no WKT" doesn't rebuild the scene on every render

// Small inputs for the OBJ origin. Uncontrolled on purpose: a controlled
// number field fights every intermediate state ("-", "605211.") while typing.
// The value is taken on Enter or when leaving the field.
function NumberField({ label, value, onCommit, title }) {
  const commit = (e) => {
    const v = Number(String(e.target.value).replace(',', '.'))
    if (Number.isFinite(v) && v !== value) onCommit(v)
    else e.target.value = value
  }
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '.68rem', color: 'var(--tx3)' }} title={title}>
      {label}
      <input
        key={value}
        className="sl"
        defaultValue={value}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
        style={{ fontSize: '.68rem', padding: '2px 6px', minHeight: 0, width: 92, cursor: 'text', fontFamily: "'IBM Plex Mono', monospace" }}
      />
    </label>
  )
}

const smallSelect = { fontSize: '.68rem', padding: '2px 6px', minHeight: 0, width: 'auto' }
const hint = { fontSize: '.68rem', color: 'var(--tx3)' }

export function Scene3dTab({ active, domId = 'tab-3d' }) {
  const graph = useStore((s) => s.graph)
  const schema = useStore((s) => s.schema)
  const geoEpsg = useStore((s) => s.geoEpsg)
  const setGeoEpsg = useStore((s) => s.setGeoEpsg)
  const selectedId = useStore((s) => s.selectedId)
  const openInExplorer = useStore((s) => s.openInExplorer)
  const navigateTo = useStore((s) => s.navigateTo)
  const model = useStore((s) => s.model3d)
  const setModel3d = useStore((s) => s.setModel3d)
  const setPlacement = useStore((s) => s.setModel3dPlacement)

  const [colorMode, setColorMode] = useState('type')
  const [fade, setFade] = useState(true)
  const [hiddenKeys, setHiddenKeys] = useState(new Set())
  // Per-layer categorisation, as on the map: typeKey -> connection property.
  // A type with one set splits into sub-layers by the value reached over
  // that property (Material, Find type, "lies in SU" ...); the others keep
  // their type colour.
  const [layerCategoryProp, setLayerCategoryProp] = useState({})
  // Nodes hidden one by one in the object list, on top of hidden layers.
  const [hiddenNodes, setHiddenNodes] = useState(new Set())
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [dragging, setDragging] = useState(false)
  const [viewerError, setViewerError] = useState('')
  const [contentVersion, setContentVersion] = useState(0)

  const containerRef = useRef(null)
  const fileInputRef = useRef(null)
  const viewerRef = useRef(null)
  const framedRef = useRef(null)

  const hasGeo = useMemo(() => hasGeoData(graph), [graph])
  const wkt = useMemo(
    () => (graph && hasGeo && geoEpsg ? buildScene3dFeatures(graph, geoEpsg) : null),
    [graph, hasGeo, geoEpsg],
  )
  const features = wkt?.features || NO_FEATURES
  const nameIndex = useMemo(() => buildNameIndex(graph), [graph])

  // Which node each OBJ object stands for -- the viewer works it out for
  // itself too, this copy feeds the counts and the layer list.
  const objMatches = useMemo(() => {
    if (!model) return []
    const out = []
    model.group.traverse((o) => {
      if (o.isMesh) out.push(matchObjectName(nameIndex, o.name))
    })
    return out
  }, [model, nameIndex])
  const matchedCount = objMatches.filter(Boolean).length
  const ambiguousCount = objMatches.filter((m) => m?.ambiguous).length

  // Everything is drawn relative to one origin near the data, see Viewer.setContent.
  const origin = useMemo(() => {
    const b = featureBounds3d(features)
    if (b) return b[0].map(Math.floor)
    if (model) return [model.placement.e, model.placement.n, model.placement.h]
    return [0, 0, 0]
  }, [features, model])

  // Nodes that have something to show in this view, for the selection rule below.
  const shownIds = useMemo(() => {
    const ids = new Set(features.map((f) => f.nodeId))
    for (const m of objMatches) if (m) ids.add(m.nodeId)
    return ids
  }, [features, objMatches])

  // The selected node's own objects if it has any. Only a node without one
  // (a find whose position sits on a separate measurement node) borrows its
  // neighbours' -- otherwise selecting a layer would also light up every
  // layer it touches stratigraphically, which on the map can't happen but
  // in an OBJ of stacked units is the rule.
  const highlightIds = useMemo(() => {
    if (!graph || !selectedId) return new Set()
    if (shownIds.has(selectedId)) return new Set([selectedId])
    return new Set([...neighborNodeIds(graph, selectedId)].filter((id) => shownIds.has(id)))
  }, [graph, selectedId, shownIds])

  // The layer tree for the panel and, per node, the leaf layer it is drawn
  // in. Counted per drawn object, so a find with a WKT point and an OBJ body
  // counts twice -- the panel says how much a checkbox hides.
  const layers = useMemo(() => {
    const leafOf = new Map() // nodeId -> { key, color }
    if (!graph) return { groups: [], leafOf, sortedTypes: [], propsByType: new Map() }
    const drawn = [...features.map((f) => f.nodeId), ...objMatches.map((m) => m?.nodeId ?? null)]
    const byType = new Map() // typeKey -> drawn node ids (with repeats)
    let unmatched = 0
    for (const id of drawn) {
      if (!id) { unmatched++; continue }
      const t = graph.nodes[id]?.t || ''
      if (!byType.has(t)) byType.set(t, [])
      byType.get(t).push(id)
    }
    const sortedTypes = [...byType.keys()].sort((a, b) => typeLabel(schema, a).localeCompare(typeLabel(schema, b)))
    const propsByType = connectionPropsByType(graph, shownIds, (p) => edgeLabel(schema, p))

    const groups = sortedTypes.map((t) => {
      const ids = byType.get(t)
      const label = typeLabel(schema, t) || '(no type)'
      const prop = layerCategoryProp[t]
      if (!prop) {
        const color = typeColor(schema, t)
        for (const id of ids) leafOf.set(id, { key: t, color })
        return { key: t, label, color, count: ids.length, children: null }
      }
      const catOf = new Map()
      const byCat = new Map()
      for (const id of ids) {
        if (!catOf.has(id)) catOf.set(id, resolveFeatureCategory(graph, id, prop) || NO_CATEGORY)
        const cat = catOf.get(id)
        byCat.set(cat, (byCat.get(cat) || 0) + 1)
      }
      const cats = [...byCat.keys()].sort((a, b) => byCat.get(b) - byCat.get(a))
      const children = cats.map((cat, i) => ({ key: t + '::' + cat, label: cat, color: PALETTE[i % PALETTE.length], count: byCat.get(cat) }))
      const childOf = new Map(children.map((c, i) => [cats[i], c]))
      for (const [id, cat] of catOf) leafOf.set(id, { key: childOf.get(cat).key, color: childOf.get(cat).color })
      return { key: t, label, count: ids.length, children }
    })
    if (unmatched) groups.push({ key: UNMATCHED, label: 'Not in the graph (OBJ)', color: '#9aa5ab', count: unmatched, children: null })
    return { groups, leafOf, sortedTypes, propsByType }
  }, [graph, schema, features, objMatches, shownIds, layerCategoryProp])

  // Node ids are only meaningful within one graph.
  useEffect(() => setHiddenNodes(new Set()), [graph])

  // One outliner row per drawn node, coloured as it is drawn.
  const outlinerEntries = useMemo(() => {
    if (!graph) return []
    return [...shownIds].map((id) => {
      const nd = graph.nodes[id]
      return {
        id,
        label: nd?.l || id,
        typeKey: nd?.t || '',
        typeLabel: typeLabel(schema, nd?.t) || '(no type)',
        color: nodeColorOverride(schema, id) || layers.leafOf.get(id)?.color || typeColor(schema, nd?.t),
      }
    })
  }, [graph, schema, shownIds, layers])

  // Blender's keys: H hides the selected node, Shift+H everything else,
  // Alt+H brings everything back.
  useEffect(() => {
    if (!active) return
    function onKey(e) {
      if (e.key !== 'h' && e.key !== 'H') return
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || '')) return
      if (e.ctrlKey || e.metaKey) return
      if (e.altKey) {
        setHiddenNodes(new Set())
      } else if (!selectedId || !shownIds.has(selectedId)) {
        return
      } else if (e.shiftKey) {
        setHiddenNodes(new Set([...shownIds].filter((id) => id !== selectedId)))
      } else {
        setHiddenNodes((prev) => new Set(prev).add(selectedId))
      }
      e.preventDefault()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [active, selectedId, shownIds])

  // Latest callbacks for the viewer, which is created once.
  const handlers = useRef({})
  handlers.current = {
    onHover: (id, x, y) => (id ? scheduleNodeHoverAt(id, x, y) : hideNodeHover()),
    onClick: (id) => openInExplorer(id),
  }

  useEffect(() => {
    if (!containerRef.current) return
    let viewer
    try {
      viewer = new Viewer(containerRef.current, {
        onHover: (...a) => handlers.current.onHover(...a),
        onClick: (...a) => handlers.current.onClick(...a),
      })
    } catch (err) {
      setViewerError('3D display is not available in this browser (WebGL could not be started).')
      return
    }
    viewerRef.current = viewer
    return () => {
      hideNodeHover()
      viewer.dispose()
      viewerRef.current = null
    }
  }, [!!graph])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    viewer.setContent({
      features,
      model,
      origin,
      matchName: (name) => matchObjectName(nameIndex, name),
    })
    setContentVersion((v) => v + 1)
  }, [features, model, origin, nameIndex])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || !graph) return
    viewer.setStyle({
      colorOf: (id, mtlColor) => {
        if (colorMode === 'material' && mtlColor) return '#' + mtlColor
        if (!id) return null
        // A colour given to this one node beats its layer's, as on the map.
        return nodeColorOverride(schema, id) || layers.leafOf.get(id)?.color || typeColor(schema, graph.nodes[id]?.t)
      },
      layerOf: (id) => (id ? layers.leafOf.get(id)?.key ?? (graph.nodes[id]?.t || '') : UNMATCHED),
      hiddenKeys,
      hiddenNodes,
      highlightIds,
      fade,
    })
  }, [contentVersion, graph, schema, layers, colorMode, hiddenKeys, hiddenNodes, highlightIds, fade])

  // A new set of things to look at gets framed once; later rebuilds (an
  // origin typed in, a colour changed) leave the camera where the user put it.
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || !active) return
    const key = (wkt ? 'w' + features.length : '') + '|' + (model ? model.fileName : '')
    if (framedRef.current === key) return
    // Wait for the panel to be laid out -- hidden, it measures 0x0.
    const frame = requestAnimationFrame(() => {
      viewer.resize()
      if (viewer.frameNodes(null, { animate: false })) framedRef.current = key
    })
    return () => cancelAnimationFrame(frame)
  }, [contentVersion, active])

  // Bring the selection into view, as the map does.
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || !active || !highlightIds.size) return
    const frame = requestAnimationFrame(() => {
      viewer.resize()
      viewer.frameNodes(highlightIds)
    })
    return () => cancelAnimationFrame(frame)
  }, [highlightIds, active])

  async function acceptModel(load) {
    setLoadError('')
    setLoading(true)
    try {
      const { fileName, group, hint: origin } = await load()
      setModel3d({
        fileName,
        group,
        placement: { e: origin?.e ?? 0, n: origin?.n ?? 0, h: 0, up: 'y', fromHeader: !!origin },
      })
    } catch (err) {
      setLoadError(err.message || 'The file could not be read.')
    } finally {
      setLoading(false)
    }
  }

  const loadFiles = (files) => files?.length && acceptModel(() => loadObjFiles(files))

  const loadExampleModel = () =>
    acceptModel(async () => {
      const [obj, mtl] = await Promise.all([EXAMPLE_MODEL_URL, EXAMPLE_MTL_URL].map(async (u) => {
        const res = await fetch(u)
        if (!res.ok) throw new Error('example model not found (' + res.status + ')')
        return res.text()
      }))
      return parseObj('GraphExplorer_Example.obj', obj, mtl)
    })

  if (!graph) return null

  const layerGroups = layers.groups
  const toggleGroup = (group) => {
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
  const toggleLayer = (key) => setHiddenKeys((prev) => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })

  const needsEpsg = hasGeo && (!geoEpsg || !wkt)
  const nothingToShow = !features.length && !model
  const placement = model?.placement

  return (
    <div className={'panel' + (active ? ' on' : '')} id={domId}>
      <div className="sec-hdr">
        <h2>3D</h2>
        {wkt && <span className="badge">{fmt(features.length)} geometries with height</span>}
        {model && (
          <span className="badge" title={ambiguousCount ? `${ambiguousCount} object names fit several nodes; the first one was taken` : undefined}>
            {model.fileName} &middot; {fmt(matchedCount)} of {fmt(objMatches.length)} objects linked
          </span>
        )}
        {wkt && wkt.flatCount > 0 && (
          <span className="badge" title="Geometries without a Z value have no height to sit at; they are on the map">
            {fmt(wkt.flatCount)} without height not shown
          </span>
        )}
        {wkt && wkt.failedCount > 0 && (
          <span className="badge" style={{ color: '#c94052', borderColor: '#c9405266' }}>
            {wkt.failedCount} of {wkt.totalCount} geometries not readable
          </span>
        )}
        {wkt && (
          <span
            style={{ fontSize: '.7rem', color: 'var(--tx3)', cursor: 'pointer', textDecoration: 'underline dotted' }}
            onClick={() => setGeoEpsg(null)}
            title={`The graph's coordinates (EPSG ${geoEpsg}) are shown in ${wkt.frame}, metres. Click to use a different source coordinate system.`}
          >
            Change EPSG {geoEpsg}
          </span>
        )}
      </div>

      <div className="frow" style={{ alignItems: 'center', rowGap: 4 }}>
        <button className="sl" style={smallSelect} onClick={() => fileInputRef.current?.click()} disabled={loading} title="Load a Wavefront OBJ (choose its .mtl along with it for the colours)">
          {loading ? 'Loading …' : model ? 'Replace OBJ …' : 'Load OBJ …'}
        </button>
        <input ref={fileInputRef} type="file" accept=".obj,.mtl" multiple style={{ display: 'none' }}
          onChange={(e) => { loadFiles(e.target.files); e.target.value = '' }} />
        {IS_WEB && !model && (
          <button className="sl" style={smallSelect} onClick={loadExampleModel} disabled={loading} title="The OBJ that belongs to the example dataset">
            Load example model
          </button>
        )}
        {model && (
          <span style={{ ...hint, cursor: 'pointer', textDecoration: 'underline dotted' }} onClick={() => setModel3d(null)}>
            remove
          </span>
        )}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 'auto' }}>
          <span style={hint}>Colour:</span>
          <select className="sl" style={smallSelect} value={colorMode} onChange={(e) => setColorMode(e.target.value)}>
            <option value="type">Layers (type / category)</option>
            <option value="material" disabled={!model}>OBJ material</option>
          </select>
        </span>
        <label style={{ ...hint, display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }} title="With a node selected, everything else turns translucent">
          <input type="checkbox" checked={fade} onChange={(e) => setFade(e.target.checked)} style={{ margin: 0 }} />
          Fade the rest
        </label>
        <button className="sl" style={smallSelect} onClick={() => viewerRef.current?.frameNodes(null)} title="Show everything">
          Fit view
        </button>
      </div>

      {layers.sortedTypes.length > 0 && (
        <div className="frow" style={{ alignItems: 'center', rowGap: 4 }}>
          <span style={{ ...hint, flexShrink: 0 }}>Categorise:</span>
          {layers.sortedTypes.map((t) => (
            <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span style={{ fontSize: '.68rem', color: 'var(--tx2)' }}>{typeLabel(schema, t) || '(no type)'}</span>
              <select
                className="sl"
                style={smallSelect}
                value={layerCategoryProp[t] || ''}
                onChange={(e) => setLayerCategoryProp((m) => ({ ...m, [t]: e.target.value }))}
              >
                <option value="">Default</option>
                {(layers.propsByType.get(t) || []).map((p) => <option key={p} value={p}>{edgeLabel(schema, p)}</option>)}
              </select>
            </span>
          ))}
          {colorMode === 'material' && <span style={hint}>(OBJ colours win while &ldquo;OBJ material&rdquo; is chosen)</span>}
        </div>
      )}

      {model && (
        <div className="frow" style={{ alignItems: 'center', rowGap: 4 }}>
          <span style={hint}>OBJ origin:</span>
          <NumberField label="E" value={placement.e} onCommit={(e) => setPlacement({ e, fromHeader: false })} title="Easting the OBJ's x = 0 corresponds to" />
          <NumberField label="N" value={placement.n} onCommit={(n) => setPlacement({ n, fromHeader: false })} title="Northing the OBJ's 0 corresponds to" />
          <NumberField label="H" value={placement.h} onCommit={(h) => setPlacement({ h })} title="Height added to the OBJ's heights" />
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span style={hint}>Up axis:</span>
            <select className="sl" style={smallSelect} value={placement.up} onChange={(e) => setPlacement({ up: e.target.value })}>
              <option value="y">Y (Blender export)</option>
              <option value="z">Z (CloudCompare, survey data)</option>
            </select>
          </span>
          <span style={hint}>
            {placement.fromHeader ? 'taken from the OBJ header' : ''}
            {wkt ? `${placement.fromHeader ? ' · ' : ''}in ${wkt.frame}` : ''}
          </span>
        </div>
      )}

      {loadError && <div className="frow" style={{ color: '#c94052', fontSize: '.78rem' }}>{loadError}</div>}

      <div
        style={{ flex: 1, position: 'relative', minHeight: 0, border: '1px solid ' + (dragging ? 'var(--gold)' : 'var(--bd)'), borderRadius: 'var(--r)', overflow: 'hidden', background: 'var(--bg2)', marginBottom: '1.2rem' }}
        onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); loadFiles(e.dataTransfer.files) }}
      >
        <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
        {viewerError ? (
          <div className="det-empty" style={{ position: 'absolute', inset: 0, background: 'var(--bg2)' }}>{viewerError}</div>
        ) : needsEpsg ? (
          <div style={{ position: 'absolute', inset: 0, background: 'var(--bg2)', overflow: 'auto' }}>
            <EpsgPrompt
              onSubmit={setGeoEpsg}
              error={geoEpsg && !wkt ? `"${geoEpsg}" was not recognised. Please enter a valid EPSG code or a proj4 definition (starting with "+proj=").` : undefined}
            />
          </div>
        ) : nothingToShow ? (
          <div className="det-empty" style={{ position: 'absolute', inset: 0, flexDirection: 'column', gap: '.5rem', textAlign: 'center', padding: '2rem', pointerEvents: 'none' }}>
            <div style={{ color: 'var(--tx)', fontSize: '.9rem' }}>Drop an OBJ (with its .mtl) here</div>
            <div style={{ maxWidth: 460 }}>
              Objects are linked to nodes by name: an OBJ object called like a node&rsquo;s label stands for that node,
              as in the Blender and CloudCompare links.
              {hasGeo && wkt ? ' The graph has no geometries with a Z value of its own.' : ''}
            </div>
          </div>
        ) : (
          <>
            {outlinerEntries.length > 0 && (
              <ObjectListPanel
                entries={outlinerEntries}
                hidden={hiddenNodes}
                onChange={setHiddenNodes}
                onSelect={(id) => navigateTo(id, true)}
                selectedId={selectedId}
              />
            )}
            {layerGroups.length > 0 && <LayerControlPanel groups={layerGroups} hiddenKeys={hiddenKeys} onToggle={toggleLayer} onToggleGroup={toggleGroup} />}
          </>
        )}
      </div>
    </div>
  )
}
