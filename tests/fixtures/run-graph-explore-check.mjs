// run-graph-explore-check.mjs
//
// Tests the Graph tab's model (src/lib/graphExplore.js): expanding and
// collapsing, the per-group load limit and its "+N laden" step, the derived
// node/edge set (including the o/i redundancy that must not draw a relation
// twice), the incremental radial placement's fixed-point property, and the
// start-node helpers -- finally over the real 13 MB export as a scale check.
//
// Usage: node --max-old-space-size=4096 run-graph-explore-check.mjs

import fs from 'fs'
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

const G = await import(L('graphExplore.js'))
const {
  DEFAULT_GROUP_LIMIT, MAX_VISIBLE_NODES,
  neighborGroups, neighborIds, deriveGraph, groupStatus, hiddenNeighborCount,
  rootAt, expand, collapse, toggle, loadMore, collapseAll, isExpanded, emptyExploreState,
  positionNewNodes, layoutExploreGraph, searchNodes, topDegreeNodes, exploreEdgeLabel,
} = G

const H = (s) => console.log('\n===== ' + s + ' =====')
let failed = 0
function check(label, cond, extra = '') {
  if (!cond) failed++
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}${extra ? '  ' + extra : ''}`)
}

const ids = (d) => d.nodes.map((n) => n.id).sort().join(',')

// A small stand-in for the archaeological case: a campaign holding two SE,
// each holding finds, plus a place both SE point at -- the diamond that makes
// collapsing interesting (a node held by two branches must survive closing
// one of them).
const graph = {
  node_types: { Kampagne: 1, Befund: 2, Fund: 3, Ort: 1 },
  edge_types: { ENTHAELT: 3, VERORTET_IN: 2, HAT_BEFUND: 2 },
  nodes: {
    K1: { l: 'Kampagne 1989', t: 'Kampagne', a: {}, o: { HAT_BEFUND: ['SE1', 'SE2'] }, i: {} },
    SE1: { l: 'SE 12', t: 'Befund', a: { ansprache: 'Graben' }, o: { ENTHAELT: ['F1', 'F2'], VERORTET_IN: ['L1'] }, i: { HAT_BEFUND: ['K1'] } },
    SE2: { l: 'SE 13', t: 'Befund', a: {}, o: { ENTHAELT: ['F3'], VERORTET_IN: ['L1'] }, i: { HAT_BEFUND: ['K1'] } },
    F1: { l: 'Fund 1', t: 'Fund', a: { material: 'Bronze' }, o: {}, i: { ENTHAELT: ['SE1'] } },
    F2: { l: 'Fund 2', t: 'Fund', a: {}, o: {}, i: { ENTHAELT: ['SE1'] } },
    F3: { l: 'Fund 3', t: 'Fund', a: {}, o: {}, i: { ENTHAELT: ['SE2'] } },
    L1: { l: 'Flaeche 3', t: 'Ort', a: {}, o: {}, i: { VERORTET_IN: ['SE1', 'SE2'] } },
  },
}

// ── neighbour groups ────────────────────────────────────────────────────────
H('Nachbarschaftsgruppen')
const gSE1 = neighborGroups(graph, 'SE1')
check('ausgehend vor eingehend, je alphabetisch',
  gSE1.map((g) => g.key).join(',') === 'o:ENTHAELT,o:VERORTET_IN,i:HAT_BEFUND',
  gSE1.map((g) => g.key).join(','))
check('leere Gruppen fallen weg', neighborGroups(graph, 'F2').length === 1)
check('unbekannter Knoten: keine Gruppen', neighborGroups(graph, 'nope').length === 0)

// Adjacency may name ids the graph doesn't carry; counting them would promise
// boxes that can never be drawn.
const dangling = { nodes: { A: { l: 'A', t: 'T', a: {}, o: { P: ['B', 'ghost'] }, i: {} }, B: { l: 'B', t: 'T', a: {}, o: {}, i: { P: ['A'] } } } }
check('haengende Referenz wird nicht mitgezaehlt', neighborGroups(dangling, 'A')[0].ids.join(',') === 'B')

check('distinkte Nachbarn, nicht Gruppensummen', neighborIds(graph, 'SE1').size === 4)

// ── expand / collapse ───────────────────────────────────────────────────────
H('Auf- und Einklappen')
let st = rootAt('K1')
check('Wurzel startet geoeffnet', isExpanded(st, 'K1'))
let d = deriveGraph(graph, st)
check('Wurzel oeffnet ihre Nachbarn', ids(d) === 'K1,SE1,SE2', ids(d))
check('Tiefe wird mitgefuehrt', d.byId.get('SE1').depth === 1 && d.byId.get('K1').depth === 0)

st = expand(st, 'SE1')
d = deriveGraph(graph, st)
check('SE1 bringt Funde und Ort', ids(d) === 'F1,F2,K1,L1,SE1,SE2', ids(d))

st = expand(st, 'SE2')
d = deriveGraph(graph, st)
check('SE2 kommt dazu', ids(d) === 'F1,F2,F3,K1,L1,SE1,SE2', ids(d))

// The point of deriving instead of storing: L1 hangs off BOTH SE, so closing
// one must not take it away.
st = collapse(st, 'SE1')
d = deriveGraph(graph, st)
check('Einklappen entfernt nur die exklusiven Kinder', ids(d) === 'F3,K1,L1,SE1,SE2', ids(d))
check('gemeinsamer Nachbar bleibt (von SE2 gehalten)', d.byId.has('L1'))

st = collapse(st, 'K1')
d = deriveGraph(graph, st)
check('Wurzel eingeklappt: nur sie bleibt', ids(d) === 'K1', ids(d))
check('geschlossener Zweig traegt nichts bei', d.edges.length === 0)

check('toggle ist seine eigene Umkehrung',
  ids(deriveGraph(graph, toggle(toggle(rootAt('K1'), 'SE1'), 'SE1'))) === ids(deriveGraph(graph, rootAt('K1'))))
check('alles einklappen laesst die Wurzel offen',
  ids(deriveGraph(graph, collapseAll(expand(rootAt('K1'), 'SE1')))) === 'K1,SE1,SE2')
check('leerer Zustand zeichnet nichts', deriveGraph(graph, emptyExploreState()).nodes.length === 0)
check('unbekannte Wurzel zeichnet nichts', deriveGraph(graph, rootAt('ghost')).nodes.length === 0)

// ── edges ───────────────────────────────────────────────────────────────────
H('Kanten')
st = expand(expand(rootAt('K1'), 'SE1'), 'SE2')
d = deriveGraph(graph, st)
// o and i are redundant by contract, and the two sides may carry different
// names -- walking both would draw every relation twice, under two labels.
check('jede Relation genau einmal', d.edges.length === 7, String(d.edges.length))
check('Richtung folgt o', d.edges.every((e) => (graph.nodes[e.source].o[e.etype] || []).includes(e.target)))
check('keine Kante zu unsichtbaren Knoten',
  d.edges.every((e) => d.byId.has(e.source) && d.byId.has(e.target)))

// A producer that wrote only one side still gets a line, or the neighbour it
// opened would sit there unconnected.
const oneSided = {
  nodes: {
    A: { l: 'A', t: 'T', a: {}, o: {}, i: { 'Ist Teil von': ['B'] } },
    B: { l: 'B', t: 'T', a: {}, o: {}, i: {} },
  },
}
const dOne = deriveGraph(oneSided, rootAt('A'))
check('nur in i notierte Kante wird ergaenzt', dOne.edges.length === 1 && dOne.edges[0].inferred === true)

// ── group limit ─────────────────────────────────────────────────────────────
H('Deckel je Gruppe und Nachladen')
const wide = { nodes: { R: { l: 'R', t: 'T', a: {}, o: { P: [] }, i: {} } } }
for (let i = 0; i < 120; i++) {
  wide.nodes['n' + i] = { l: 'n' + i, t: 'T', a: {}, o: {}, i: { P: ['R'] } }
  wide.nodes.R.o.P.push('n' + i)
}
let ws = rootAt('R')
let wd = deriveGraph(wide, ws)
check(`erste Expansion zeichnet ${DEFAULT_GROUP_LIMIT} von 120`, wd.nodes.length === DEFAULT_GROUP_LIMIT + 1, String(wd.nodes.length))

let status = groupStatus(wide, ws, new Set(wd.nodes.map((n) => n.id)), 'R')[0]
check('Status nennt gezeichnet und gesamt', status.shown === DEFAULT_GROUP_LIMIT && status.total === 120)
check('Status nennt den ungeoeffneten Rest', status.remaining === 120 - DEFAULT_GROUP_LIMIT)

ws = loadMore(ws, 'R', 'o:P')
wd = deriveGraph(wide, ws)
check('nachladen fuegt eine weitere Charge hinzu', wd.nodes.length === 2 * DEFAULT_GROUP_LIMIT + 1, String(wd.nodes.length))

ws = loadMore(ws, 'R', 'o:P', 70)
wd = deriveGraph(wide, ws)
check('"alle" oeffnet den Rest', wd.nodes.length === 121, String(wd.nodes.length))

// Re-opening must not silently restore a "+N laden" the user can no longer see.
const reopened = deriveGraph(wide, expand(collapse(ws, 'R'), 'R'))
check('Einklappen setzt den Deckel zurueck', reopened.nodes.length === DEFAULT_GROUP_LIMIT + 1, String(reopened.nodes.length))

check('geschlossener Knoten meldet nichts als gezeichnet',
  groupStatus(wide, collapse(ws, 'R'), new Set(['R']), 'R')[0].shown === 0)

// ── hard ceiling ────────────────────────────────────────────────────────────
H('Obergrenze der Zeichenflaeche')
const huge = { nodes: { R: { l: 'R', t: 'T', a: {}, o: {}, i: {} } } }
// A hub whose every neighbour is itself a hub: enough to blow past the ceiling
// even with the per-group limit in force.
for (let i = 0; i < 100; i++) {
  const a = 'a' + i
  huge.nodes[a] = { l: a, t: 'T', a: {}, o: {}, i: {} }
  huge.nodes.R.o['P' + i] = [a]
  huge.nodes[a].i['P' + i] = ['R']
  huge.nodes[a].o.Q = []
  for (let j = 0; j < 100; j++) {
    const b = a + '_' + j
    huge.nodes[b] = { l: b, t: 'T', a: {}, o: {}, i: { Q: [a] } }
    huge.nodes[a].o.Q.push(b)
  }
}
let hs = rootAt('R')
for (let i = 0; i < 100; i++) hs = expand(hs, 'a' + i)
const hd = deriveGraph(huge, hs)
check('Grenze wird eingehalten', hd.nodes.length <= MAX_VISIBLE_NODES, String(hd.nodes.length))
check('Grenze wird gemeldet, nicht verschwiegen', hd.truncated === true)

// ── placement ───────────────────────────────────────────────────────────────
H('Platzierung')
const p1 = positionNewNodes(deriveGraph(graph, rootAt('K1')).nodes, {})
check('Wurzel im Ursprung', p1.K1.x === 0 && p1.K1.y === 0)
check('jeder Knoten bekommt eine Position', ['K1', 'SE1', 'SE2'].every((id) => Number.isFinite(p1[id]?.x)))
check('Kinder liegen nicht aufeinander', p1.SE1.x !== p1.SE2.x || p1.SE1.y !== p1.SE2.y)

// The whole reason for the radial layout: expanding must not move what is
// already on screen.
const p2 = positionNewNodes(deriveGraph(graph, expand(rootAt('K1'), 'SE1')).nodes, p1)
check('bestehende Knoten bleiben stehen',
  ['K1', 'SE1', 'SE2'].every((id) => p1[id].x === p2[id].x && p1[id].y === p2[id].y))
check('neue Knoten kommen dazu', Number.isFinite(p2.F1?.x) && Number.isFinite(p2.L1?.x))
check('wiederholter Aufruf aendert nichts',
  JSON.stringify(positionNewNodes(deriveGraph(graph, expand(rootAt('K1'), 'SE1')).nodes, p2)) === JSON.stringify(p2))

const dAll = deriveGraph(graph, expand(expand(rootAt('K1'), 'SE1'), 'SE2'))
const pl = layoutExploreGraph(dAll.nodes, dAll.edges)
check('Neuanordnung positioniert alle', dAll.nodes.every((n) => Number.isFinite(pl[n.id]?.x)))
check('Neuanordnung schichtet nach Tiefe', pl.K1.x < pl.SE1.x && pl.SE1.x < pl.F1.x,
  `${pl.K1.x} / ${pl.SE1.x} / ${pl.F1.x}`)

// A self-loop must not break the layered layout.
const loop = { nodes: { A: { l: 'A', t: 'T', a: {}, o: { P: ['A'] }, i: { P: ['A'] } } } }
const dLoop = deriveGraph(loop, rootAt('A'))
check('Selbstbezug bleibt zeichenbar', Number.isFinite(layoutExploreGraph(dLoop.nodes, dLoop.edges).A.x))

// ── start-node helpers ──────────────────────────────────────────────────────
H('Startknoten finden')
check('Suche ab 2 Zeichen', searchNodes(graph, 'S').length === 0)
check('Suche nach Label', searchNodes(graph, 'SE 1').sort().join(',') === 'SE1,SE2')
check('Suche nach ID', searchNodes(graph, 'K1').join(',') === 'K1')
check('Typfilter ohne Suchtext blaettert den Typ', searchNodes(graph, '', 'Fund').sort().join(',') === 'F1,F2,F3')
check('Typfilter und Suchtext zusammen', searchNodes(graph, 'Fund 1', 'Fund').join(',') === 'F1')
check('Obergrenze wird eingehalten', searchNodes(wide, '', 'T', 10).length === 10)

const top = topDegreeNodes(graph, 3)
check('meistvernetzter Knoten zuerst', top[0].id === 'SE1', top.map((t) => `${t.id}:${t.degree}`).join(' '))
check('Grad zaehlt beide Richtungen', top[0].degree === 4)

// ── edge labels ─────────────────────────────────────────────────────────────
H('Kantenbeschriftung')
const sch = { edgeLabels: { ENTHAELT: 'Enthaelt', 'http://x#p': 'Liegt' } }
check('Schema-Label gewinnt', exploreEdgeLabel(sch, 'ENTHAELT') === 'Enthaelt')
check('Dot-One wird lesbar zerlegt', exploreEdgeLabel(sch, 'http://x#p#dot1:above') === 'Liegt · above',
  exploreEdgeLabel(sch, 'http://x#p#dot1:above'))
check('Dot-One ohne Schema faellt auf den Lokalnamen zurueck',
  exploreEdgeLabel({}, 'http://x#p#dot1:above') === 'p · above', exploreEdgeLabel({}, 'http://x#p#dot1:above'))
check('kuratiertes Label fuer den vollen Dot-One-Schluessel gewinnt',
  exploreEdgeLabel({ edgeLabels: { 'http://x#p#dot1:above': 'Liegt ueber' } }, 'http://x#p#dot1:above') === 'Liegt ueber')

// ── the real export ─────────────────────────────────────────────────────────
const bigPath = path.join(__dirname, 'example-graph.json')
if (fs.existsSync(bigPath)) {
  H('Echter Export (Skalen-Check)')
  const big = JSON.parse(fs.readFileSync(bigPath, 'utf8'))
  const t0 = Date.now()
  const start = topDegreeNodes(big, 1)[0]
  const tTop = Date.now() - t0

  let bs = rootAt(start.id)
  let bd = deriveGraph(big, bs)
  check(`Start am meistvernetzten Knoten (${start.id}, Grad ${start.degree})`, bd.nodes.length > 1, `${bd.nodes.length} Knoten`)
  check('meistvernetzte Knoten in vertretbarer Zeit', tTop < 8000, tTop + ' ms')

  // Expand everything the first ring offers -- the realistic worst case for a
  // couple of eager clicks.
  const t1 = Date.now()
  for (const n of bd.nodes) bs = expand(bs, n.id)
  bd = deriveGraph(big, bs)
  const tExpand = Date.now() - t1
  check('zwei Ringe bleiben unter der Grenze', bd.nodes.length <= MAX_VISIBLE_NODES, `${bd.nodes.length} Knoten`)
  check('Ableitung bleibt schnell', tExpand < 4000, tExpand + ' ms')
  check('Kanten verweisen nur auf sichtbare Knoten',
    bd.edges.every((e) => bd.byId.has(e.source) && bd.byId.has(e.target)))

  const t2 = Date.now()
  const bp = positionNewNodes(bd.nodes, {})
  check('alle platziert', bd.nodes.every((n) => Number.isFinite(bp[n.id]?.x)), Date.now() - t2 + ' ms')

  const t3 = Date.now()
  const bl = layoutExploreGraph(bd.nodes, bd.edges)
  check('Neuanordnung schafft den Ausschnitt', bd.nodes.every((n) => Number.isFinite(bl[n.id]?.x)), Date.now() - t3 + ' ms')

  const vis = new Set(bd.nodes.map((n) => n.id))
  check('verborgene Nachbarn werden korrekt gezaehlt',
    bd.nodes.every((n) => hiddenNeighborCount(big, vis, n.id) >= 0))
} else {
  console.log('\n(example-graph.json fehlt — Skalen-Check uebersprungen)')
}

console.log(failed ? `\n[${failed} FEHLGESCHLAGEN]` : '\n[done]')
process.exit(failed ? 1 : 0)
