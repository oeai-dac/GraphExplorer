// run-dashboard-layout-check.mjs
//
// Tests the Dashboard's split-tree logic in src/lib/dashboardLayout.js and
// the shared view registry in src/lib/views.js -- both are plain data
// modules, so the whole arrangement behaviour is checkable without a browser.
//
// Usage: node run-dashboard-layout-check.mjs

import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { register } from 'node:module'

register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(spec, ctx, next){
  try { return await next(spec, ctx) } catch(e){
    if(spec.startsWith('.') && !/\\.(js|mjs|cjs|json)$/.test(spec)) return next(spec + '.js', ctx)
    throw e
  }
}`), import.meta.url)

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../')
const L = (p) => pathToFileURL(path.join(ROOT, 'src/lib', p)).href

const D = await import(L('dashboardLayout.js'))
const { VIEW_KEYS, isViewAvailable, availableViewKeys } = await import(L('views.js'))

const H = (s) => console.log('\n===== ' + s + ' =====')
let failed = 0
function check(label, cond, extra = '') {
  if (!cond) failed++
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}${extra ? '  ' + extra : ''}`)
}

// Compact rendering of a tree, for eyeballing the shape in the output.
function render(n) {
  if (!n) return '(leer)'
  if (n.type === 'pane') return n.view
  return `[${n.dir} ${n.ratio.toFixed(2)} ${render(n.a)} | ${render(n.b)}]`
}

// ── splitting ───────────────────────────────────────────────────────────────
H('teilen')
const l0 = D.defaultLayout()
check('Startlayout ist ein einzelnes Fenster', D.countPanes(l0) === 1, render(l0))

const p0 = D.listPanes(l0)[0]
const l1 = D.splitPane(l0, p0.id, 'row', 'map')
check('Teilen ergibt zwei Fenster', D.countPanes(l1) === 2, render(l1))
check('bestehende Ansicht bleibt links', l1.a.view === 'explore')
check('neue Ansicht steht rechts', l1.b.view === 'map')
check('Ausgangsbaum unveraendert (rein funktional)', D.countPanes(l0) === 1)

// Example from the request: Explorer neben Karte, darunter die Harris Matrix.
const l2 = D.splitPane(l1, l1.b.id, 'col', 'matrix')
check('Fenster im Baum weiter teilbar', D.countPanes(l2) === 3, render(l2))
check('alle Fenster-IDs eindeutig', new Set(D.listPanes(l2).map((p) => p.id)).size === 3)

// ── structural sharing (what keeps a splitter drag cheap) ───────────────────
H('strukturelles Teilen beim Ziehen')
const dragged = D.setSplitRatio(l2, l2.id, 0.7)
check('Wurzel ist ein neues Objekt', dragged !== l2)
check('unberuehrter Teilbaum bleibt identisch', dragged.b === l2.b, '(sonst wuerde jede Maus-Bewegung alles neu rendern)')
check('Verhaeltnis uebernommen', dragged.ratio === 0.7)

// ── ratio clamping ──────────────────────────────────────────────────────────
H('Verhaeltnis begrenzen')
check('zu klein wird angehoben', D.setSplitRatio(l2, l2.id, -3).ratio === D.MIN_RATIO)
check('zu gross wird gekappt', D.setSplitRatio(l2, l2.id, 42).ratio === D.MAX_RATIO)
check('NaN faellt auf 0.5 zurueck', D.setSplitRatio(l2, l2.id, NaN).ratio === 0.5)

// ── closing ─────────────────────────────────────────────────────────────────
H('schliessen')
const panes2 = D.listPanes(l2)
const closed = D.closePane(l2, panes2[1].id)
check('Fenster entfernt', D.countPanes(closed) === 2, render(closed))
check('Geschwister ruecken nach', render(closed).includes('explore') && render(closed).includes('matrix'))
const single = D.closePane(D.closePane(closed, D.listPanes(closed)[0].id), 'x')
check('letztes Fenster laesst sich nicht schliessen', D.countPanes(D.closePane(single, D.listPanes(single)[0].id)) === 1)
check('unbekannte ID aendert nichts', D.closePane(l2, 'gibtsnicht') === l2)

// ── view switching ──────────────────────────────────────────────────────────
H('Ansicht wechseln')
const switched = D.setPaneView(l2, D.listPanes(l2)[0].id, 'timeline')
check('Ansicht gesetzt', D.listPanes(switched)[0].view === 'timeline')
check('gleiche Ansicht erzeugt keinen neuen Baum', D.setPaneView(switched, D.listPanes(switched)[0].id, 'timeline') === switched)

// ── obergrenze ──────────────────────────────────────────────────────────────
H('Obergrenze an Fenstern')
let big = D.defaultLayout()
for (let i = 0; i < 40; i++) big = D.splitPane(big, D.listPanes(big)[0].id, i % 2 ? 'col' : 'row')
check(`nie mehr als ${D.MAX_PANES} Fenster`, D.countPanes(big) === D.MAX_PANES, `(${D.countPanes(big)})`)

// ── restoring from localStorage ─────────────────────────────────────────────
H('wiederherstellen aus localStorage')
check('null verworfen', D.sanitizeLayout(null) === null)
check('Muell verworfen', D.sanitizeLayout({ type: 'nonsense' }) === null)
check('String verworfen', D.sanitizeLayout('[]') === null)
check('unbekannte Ansicht verworfen', D.sanitizeLayout({ type: 'pane', view: 'evil' }, VIEW_KEYS) === null)
check('Zyklus-Attrappe ohne Ende wird gekappt', D.sanitizeLayout(deepNest(40)) === null)

const restored = D.sanitizeLayout(JSON.parse(JSON.stringify(l2)), VIEW_KEYS)
check('gueltiger Baum kommt zurueck', D.countPanes(restored) === 3, render(restored))
const oldIds = new Set([...D.listPanes(l2).map((p) => p.id), l2.id])
check('frische IDs, keine Kollision mit laufender Sitzung',
  D.listPanes(restored).every((p) => !oldIds.has(p.id)))

// A layout built on a graph WITH geometries, restored against one without:
// the map pane drops out, the rest survives.
const withoutMap = D.sanitizeLayout(JSON.parse(JSON.stringify(l2)), ['explore', 'matrix', 'overview'])
check('nicht verfuegbare Ansicht faellt weg, Rest bleibt', D.countPanes(withoutMap) === 2, render(withoutMap))
check('ungueltiges Verhaeltnis beim Laden begradigt',
  D.sanitizeLayout({ type: 'split', dir: 'row', ratio: 99, a: { type: 'pane', view: 'explore' }, b: { type: 'pane', view: 'search' } }, VIEW_KEYS).ratio === D.MAX_RATIO)

function deepNest(depth) {
  let n = { type: 'pane', view: 'explore' }
  for (let i = 0; i < depth; i++) n = { type: 'split', dir: 'row', ratio: 0.5, a: n, b: { type: 'pane', view: 'search' } }
  return n
}

// ── presets ─────────────────────────────────────────────────────────────────
H('Voreinstellungen')
for (const p of D.PRESETS) {
  const full = D.buildPreset(p.key, VIEW_KEYS)
  check(`"${p.label}" baut auf`, !!full && D.countPanes(full) >= 1, render(full))
}
// On a graph with neither geometries nor stratigraphy, a preset must not
// leave the user staring at panes it can't fill.
const poor = ['overview', 'explore', 'charts', 'search']
const fallback = D.buildPreset('triple', poor)
check('Voreinstellung weicht auf verfuegbare Ansichten aus',
  D.listPanes(fallback).every((p) => poor.includes(p.view)), render(fallback))

// ── view availability (shared by tab bar and pane picker) ───────────────────
H('Verfuegbarkeit der Ansichten')
const plain = { nodes: { a: { l: 'A', t: 'T', a: { name: 'x' }, o: {}, i: {} } } }
check('Uebersicht immer verfuegbar', isViewAvailable(plain, 'overview'))
check('Karte ohne WKT nicht verfuegbar', !isViewAvailable(plain, 'map'))
check('Matrix ohne Dot-One nicht verfuegbar', !isViewAvailable(plain, 'matrix'))
check('unbekannter Schluessel nie verfuegbar', !isViewAvailable(plain, 'dashboard'))
check('ohne Graph nur die datenfreien Ansichten',
  availableViewKeys(null).join(',') === 'overview,explore,graph,charts,search', availableViewKeys(null).join(','))

const geo = { nodes: { a: { l: 'A', t: 'T', a: { geom: 'POINT(16.37 48.21)' }, o: {}, i: {} } } }
check('Karte mit WKT verfuegbar', isViewAvailable(geo, 'map'))

const strat = { nodes: { a: { l: 'A', t: 'T', a: {}, o: { 'http://x#p#dot1:above': ['b'] }, i: {} }, b: { l: 'B', t: 'T', a: {}, o: {}, i: {} } } }
check('Matrix mit Dot-One verfuegbar', isViewAvailable(strat, 'matrix'))

console.log(failed ? `\n[${failed} FEHLGESCHLAGEN]` : '\n[done]')
process.exit(failed ? 1 : 0)
