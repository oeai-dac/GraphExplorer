// The imperative three.js side of the 3D tab: renderer, camera, picking.
// Scene3dTab owns one per mounted view and tells it what to show; this file
// knows nothing about the store or React.
//
// Rendering is on demand, not in a loop: every view of the app stays mounted
// while hidden (see App.jsx), and a 60 fps loop per 3D view would keep the
// GPU busy for a tab nobody is looking at. Camera moves, resizes and style
// changes each request one frame.

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

const UNMATCHED_COLOR = '#9aa5ab'
const HIGHLIGHT_COLOR = '#1f8da6' // --gold, as on the map
const FADED_OPACITY = 0.12
const FILL_OPACITY = 0.35
const CLICK_TOLERANCE = 5 // px a press may move and still count as a click

export class Viewer {
  constructor(container, { onHover, onClick }) {
    this.container = container
    this.onHover = onHover
    this.onClick = onClick

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    this.renderer.setPixelRatio(window.devicePixelRatio || 1)
    this.renderer.domElement.style.display = 'block'
    container.appendChild(this.renderer.domElement)

    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 10000)
    // Z is up: the frame is easting/northing/height, like the map plus height.
    this.camera.up.set(0, 0, 1)
    this.camera.position.set(10, -10, 10)

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8899a0, 1.6))
    // A light that moves with the camera keeps the faced side lit from any
    // angle -- a fixed sun leaves half of every excavation in the dark.
    const headlight = new THREE.DirectionalLight(0xffffff, 1.4)
    headlight.position.set(0.3, 0.5, 1)
    this.camera.add(headlight)
    this.scene.add(this.camera)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.screenSpacePanning = true
    this.controls.addEventListener('change', () => this.requestRender())

    this.content = new THREE.Group()
    this.scene.add(this.content)
    this.pickables = []
    this.sharedGeometries = []
    this.materials = new Map()
    this.raycaster = new THREE.Raycaster()
    this.frame = 0
    this.hoverFrame = 0
    this.hoverId = null
    this.flight = 0

    const el = this.renderer.domElement
    this._down = null
    this._onPointerDown = (e) => { this._down = { x: e.clientX, y: e.clientY, button: e.button } }
    this._onPointerUp = (e) => {
      const d = this._down
      this._down = null
      if (!d || d.button !== 0) return
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_TOLERANCE) return
      const id = this.pick(e.clientX, e.clientY)
      if (id) this.onClick?.(id)
    }
    this._onPointerMove = (e) => {
      if (e.buttons) return // dragging the camera, not hovering
      const { clientX, clientY } = e
      cancelAnimationFrame(this.hoverFrame)
      this.hoverFrame = requestAnimationFrame(() => this._hover(clientX, clientY))
    }
    this._onPointerLeave = () => {
      cancelAnimationFrame(this.hoverFrame)
      this._setHover(null)
    }
    el.addEventListener('pointerdown', this._onPointerDown)
    el.addEventListener('pointerup', this._onPointerUp)
    el.addEventListener('pointermove', this._onPointerMove)
    el.addEventListener('pointerleave', this._onPointerLeave)

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(container)
    this.resize()
  }

  dispose() {
    cancelAnimationFrame(this.frame)
    cancelAnimationFrame(this.hoverFrame)
    cancelAnimationFrame(this.flight)
    this.resizeObserver.disconnect()
    const el = this.renderer.domElement
    el.removeEventListener('pointerdown', this._onPointerDown)
    el.removeEventListener('pointerup', this._onPointerUp)
    el.removeEventListener('pointermove', this._onPointerMove)
    el.removeEventListener('pointerleave', this._onPointerLeave)
    this.controls.dispose()
    this._clearContent()
    for (const m of this.materials.values()) m.dispose()
    this.renderer.dispose()
    el.remove()
  }

  resize() {
    const w = this.container.clientWidth
    const h = this.container.clientHeight
    // A hidden tab measures 0x0; keep the last good size until it is shown.
    if (!w || !h) return
    this.renderer.setSize(w, h, false)
    this.renderer.domElement.style.width = '100%'
    this.renderer.domElement.style.height = '100%'
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.requestRender()
  }

  requestRender() {
    if (this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.renderer.render(this.scene, this.camera)
    })
  }

  // --- content ---------------------------------------------------------------

  _clearContent() {
    // Geometries of the OBJ clone are shared with the model in the store and
    // with every other 3D view; only the ones built here may be disposed.
    this.content.traverse((o) => {
      if (o.userData.ownGeometry) o.geometry?.dispose()
    })
    this.content.clear()
    this.pickables = []
    // Shared by all points of one build, so not owned by any single mesh.
    for (const g of this.sharedGeometries) g.dispose()
    this.sharedGeometries = []
  }

  /**
   * Replace what is shown.
   *   features  - WKT geometries in the metric frame, minus `origin`
   *   model     - { group, placement } from the store, or null
   *   origin    - [x, y, z] subtracted from everything (keeps float32 precise:
   *               UTM northings in the millions would otherwise jitter by
   *               decimetres on the GPU)
   *   matchName(name) - { nodeId, ambiguous } or null for an OBJ object
   * Returns { matched, unmatched, ambiguous } for the OBJ.
   */
  setContent({ features, model, origin, matchName }) {
    this._clearContent()
    const stats = { matched: 0, unmatched: 0, ambiguous: 0 }
    const [ox, oy, oz] = origin

    if (model) {
      const { e, n, h, up } = model.placement
      const holder = new THREE.Group()
      holder.position.set(e - ox, n - oy, h - oz)
      const clone = model.group.clone(true)
      // Blender writes OBJ Y-up (x east, -z north, y up); CloudCompare keeps
      // the data's own Z-up. Rotating Y-up by +90° about X gives x, -z, y.
      if (up === 'y') clone.rotation.x = Math.PI / 2
      holder.add(clone)
      clone.traverse((o) => {
        if (!o.isMesh) return
        const m = matchName(o.name)
        o.userData.kind = 'solid'
        o.userData.mtlColor = firstMaterial(o.material)?.color?.getHexString?.()
        if (m) {
          o.userData.nodeId = m.nodeId
          stats.matched++
          if (m.ambiguous) stats.ambiguous++
        } else {
          stats.unmatched++
        }
        this.pickables.push(o)
      })
      this.content.add(holder)
    }

    // Point size follows the scene: a find spot should be visible next to a
    // 50 m trench and next to a 2 m sondage alike.
    const extent = new THREE.Box3()
    if (model) extent.expandByObject(this.content)
    for (const f of features) forEachTuple(f.coordinates, (t) => extent.expandByPoint(new THREE.Vector3(t[0] - ox, t[1] - oy, t[2] - oz)))
    const diag = extent.isEmpty() ? 10 : extent.getSize(new THREE.Vector3()).length()
    const radius = Math.max(diag * 0.003, 0.01)
    const sphere = new THREE.SphereGeometry(1, 12, 8)
    this.raycaster.params.Line.threshold = radius

    const wkt = new THREE.Group()
    for (const f of features) {
      const local = (t) => new THREE.Vector3(t[0] - ox, t[1] - oy, t[2] - oz)
      const tag = (o, kind) => {
        o.userData.nodeId = f.nodeId
        o.userData.kind = kind
        this.pickables.push(o)
        wkt.add(o)
      }
      switch (f.type) {
        case 'Point':
        case 'MultiPoint':
          for (const t of f.type === 'Point' ? [f.coordinates] : f.coordinates) {
            const m = new THREE.Mesh(sphere)
            m.scale.setScalar(radius)
            m.position.copy(local(t))
            tag(m, 'point')
          }
          break
        case 'LineString':
        case 'MultiLineString':
          for (const line of f.type === 'LineString' ? [f.coordinates] : f.coordinates) {
            tag(ownGeometry(new THREE.Line(new THREE.BufferGeometry().setFromPoints(line.map(local)))), 'line')
          }
          break
        case 'Polygon':
        case 'MultiPolygon':
          for (const poly of f.type === 'Polygon' ? [f.coordinates] : f.coordinates) {
            const fill = polygonMesh(poly, local)
            if (fill) tag(fill, 'fill')
            for (const ring of poly) {
              tag(ownGeometry(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(ring.map(local)))), 'line')
            }
          }
          break
      }
    }
    this.sharedGeometries.push(sphere)
    this.content.add(wkt)

    this.requestRender()
    return stats
  }

  /**
   * Colour and visibility, without rebuilding anything.
   *   colorOf(nodeId, mtlColor) - '#rrggbb' or null for "not matched"
   *   layerOf(nodeId)           - layer key, checked against hiddenKeys
   *   hiddenNodes               - Set of node ids hidden one by one (outliner)
   *   highlightIds              - Set; when non-empty everything else fades
   */
  setStyle({ colorOf, layerOf, hiddenKeys, hiddenNodes, highlightIds, fade }) {
    const anyHighlight = highlightIds.size > 0
    for (const o of this.pickables) {
      const id = o.userData.nodeId
      // Layers and single objects hide independently: colouring by one
      // grouping while hiding by another (by material, minus SE 1004).
      o.visible = !hiddenKeys.has(layerOf(id)) && !(id && hiddenNodes.has(id))
      const lit = id && highlightIds.has(id)
      const state = lit ? 'hi' : anyHighlight && fade ? 'faded' : 'normal'
      const color = lit ? HIGHLIGHT_COLOR : colorOf(id, o.userData.mtlColor) || UNMATCHED_COLOR
      o.material = this._material(o.userData.kind, color, state)
      // Highlighted parts are drawn last so they show through the faded rest.
      o.renderOrder = lit ? 2 : 0
    }
    this.requestRender()
  }

  _material(kind, color, state) {
    const key = kind + '|' + color + '|' + state
    let m = this.materials.get(key)
    if (m) return m
    const faded = state === 'faded'
    if (kind === 'line') {
      m = new THREE.LineBasicMaterial({ color, transparent: faded, opacity: faded ? FADED_OPACITY * 2 : 1 })
    } else {
      const opacity = faded ? FADED_OPACITY : kind === 'fill' ? FILL_OPACITY : 1
      m = new THREE.MeshStandardMaterial({
        color,
        roughness: 0.85,
        metalness: 0,
        flatShading: kind === 'solid',
        side: THREE.DoubleSide,
        transparent: opacity < 1,
        opacity,
        depthWrite: opacity === 1,
        emissive: state === 'hi' ? new THREE.Color(HIGHLIGHT_COLOR).multiplyScalar(0.35) : 0x000000,
      })
    }
    this.materials.set(key, m)
    return m
  }

  // --- camera ----------------------------------------------------------------

  /** Frame the visible objects for `nodeIds` (all visible ones if null). */
  frameNodes(nodeIds, { animate = true } = {}) {
    const box = new THREE.Box3()
    for (const o of this.pickables) {
      if (!o.visible) continue
      if (nodeIds && !nodeIds.has(o.userData.nodeId)) continue
      box.expandByObject(o)
    }
    if (box.isEmpty()) return false
    const sphere = box.getBoundingSphere(new THREE.Sphere())
    // A single find is a few centimetres across; framing just that would
    // fill the screen with it and lose the layer it sits in. Never closer
    // than a sixth of the whole scene.
    let r = sphere.radius
    if (nodeIds) {
      const all = new THREE.Box3()
      for (const o of this.pickables) if (o.visible) all.expandByObject(o)
      r = Math.max(r, all.getBoundingSphere(new THREE.Sphere()).radius / 6)
    }
    r = Math.max(r, 0.5)
    const fov = (this.camera.fov * Math.PI) / 180
    const dist = (r / Math.sin(fov / 2)) * 1.15
    // Keep the current viewing direction; only a fresh view gets the default
    // look from the south-west and above.
    const dir = this.camera.position.clone().sub(this.controls.target)
    if (dir.lengthSq() < 1e-9) dir.set(-1, -1, 1)
    dir.normalize()
    const toTarget = sphere.center.clone()
    const toPos = sphere.center.clone().addScaledVector(dir, dist)
    this.camera.near = Math.max(dist / 1000, 0.001)
    this.camera.far = dist * 100
    this.camera.updateProjectionMatrix()
    this._flyTo(toPos, toTarget, animate ? 500 : 0)
    return true
  }

  _flyTo(pos, target, ms) {
    cancelAnimationFrame(this.flight)
    if (!ms) {
      this.camera.position.copy(pos)
      this.controls.target.copy(target)
      this.controls.update()
      return
    }
    const p0 = this.camera.position.clone()
    const t0 = this.controls.target.clone()
    const start = performance.now()
    const step = (now) => {
      const k = Math.min(1, (now - start) / ms)
      const e = k * k * (3 - 2 * k)
      this.camera.position.lerpVectors(p0, pos, e)
      this.controls.target.lerpVectors(t0, target, e)
      this.controls.update()
      if (k < 1) this.flight = requestAnimationFrame(step)
    }
    this.flight = requestAnimationFrame(step)
  }

  // --- picking ---------------------------------------------------------------

  pick(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect()
    if (!rect.width || !rect.height) return null
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
    this.raycaster.setFromCamera(ndc, this.camera)
    const visible = this.pickables.filter((o) => o.visible && o.material?.opacity > FADED_OPACITY * 2)
    // Faded parts can't be picked: with a selection made, a click should land
    // on what is in focus, not on the ghost layer in front of it.
    const pool = visible.length ? visible : this.pickables.filter((o) => o.visible)
    for (const hit of this.raycaster.intersectObjects(pool, false)) {
      if (hit.object.userData.nodeId) return hit.object.userData.nodeId
    }
    return null
  }

  _hover(clientX, clientY) {
    const id = this.pick(clientX, clientY)
    this.renderer.domElement.style.cursor = id ? 'pointer' : ''
    if (id !== this.hoverId) this._setHover(id, clientX, clientY)
  }

  _setHover(id, x, y) {
    this.hoverId = id
    this.onHover?.(id, x, y)
  }
}

function firstMaterial(m) {
  return Array.isArray(m) ? m[0] : m
}

function ownGeometry(o) {
  o.userData.ownGeometry = true
  return o
}

function forEachTuple(coords, fn) {
  if (Array.isArray(coords) && typeof coords[0] === 'number') fn(coords)
  else if (Array.isArray(coords)) coords.forEach((c) => forEachTuple(c, fn))
}

// A WKT polygon as a filled surface. Triangulated in plan view (x/y) with
// each vertex keeping its own height -- right for plana and footprints, which
// is what polygons with Z in excavation data usually are.
function polygonMesh(rings, local) {
  const pts = rings.map((ring) => {
    const r = ring.map(local)
    // WKT rings repeat their first point at the end; the triangulator doesn't want it.
    if (r.length > 1 && r[0].equals(r[r.length - 1])) r.pop()
    return r
  })
  if (!pts[0] || pts[0].length < 3) return null
  const contour = pts[0].map((v) => new THREE.Vector2(v.x, v.y))
  const holes = pts.slice(1).filter((h) => h.length >= 3).map((h) => h.map((v) => new THREE.Vector2(v.x, v.y)))
  const faces = THREE.ShapeUtils.triangulateShape(contour, holes)
  if (!faces.length) return null
  const all = [pts[0], ...pts.slice(1).filter((h) => h.length >= 3)].flat()
  const geom = new THREE.BufferGeometry().setFromPoints(all)
  geom.setIndex(faces.flat())
  geom.computeVertexNormals()
  return ownGeometry(new THREE.Mesh(geom))
}
