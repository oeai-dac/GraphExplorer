// Prüft src/explorer-bridge.js -- die Browser-Seite der Kopplung.
//
//     node tests/fixtures/run-bridge-checks.mjs
//
// Geprüft wird über den echten Weg: ein gefälschter WebSocket nimmt entgegen,
// was die Brücke sendet, und schiebt ihr hinein, was QGIS schicken würde. Damit
// laufen Transport, Auflösung und Rückkopplungssperre so, wie sie später auch
// laufen -- statt einzelner Funktionen, die man isoliert richtig hinbiegt.
//
// Der Prüfstein ist die Ein-Hop-Auflösung: Ein Fund trägt keine SE-Nummer, die
// hängt am Befund nebenan. Wer im Explorer einen Fund anklickt, muss trotzdem
// dessen Fläche in QGIS hervorgehoben bekommen.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const bridgeSrc = readFileSync(join(here, '..', '..', 'src', 'explorer-bridge.js'), 'utf8')

const failures = []
const check = (name, got, want) => {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g !== w) failures.push(`${name}\n    erwartet: ${w}\n    bekommen: ${g}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// -- Ein Graph in der Form, die wirklich vorkommt ---------------------------
//
// Der Befund trägt die SE-Nummer. Der Fund hängt eine Kante daneben, die
// Keramik zwei. Genau diese Staffelung macht die Auflösung nötig.
const GRAPH = {
  meta: { title: 'Prüfbestand' },
  nodes: {
    B_1: { l: 'SE 2001', t: 'Befund', a: { se: 'SE 2001', ansprache: 'Graben' },
           o: { ENTHAELT_FN: ['F_1', 'F_2'] }, i: {} },
    B_2: { l: 'SE 2002', t: 'Befund', a: { se: 'SE 2002' }, o: {}, i: {} },
    F_1: { l: 'Fund 17', t: 'Fund', a: { material: 'Keramik' }, o: { MATERIAL: ['K_1'] },
           i: { ENTHAELT_FN: ['B_1'] } },
    F_2: { l: 'Fund 18', t: 'Fund', a: { material: 'Eisen' }, o: {},
           i: { ENTHAELT_FN: ['B_1'] } },
    K_1: { l: 'Keramik', t: 'Material', a: {}, o: {}, i: { MATERIAL: ['F_1'] } },
    X_1: { l: 'Alleinstehend', t: 'Fund', a: {}, o: {}, i: {} },
  },
}

const SPEC = { nodeType: 'Befund', nodeSource: 'attr', nodeAttr: 'se' }

// -- Umgebung ---------------------------------------------------------------

function makeStore(graph) {
  const listeners = []
  let state = {
    graph,
    selectedId: null,
    openInExplorer(id) { store._set({ selectedId: id }) },
    loadGraph(g) { store._set({ graph: g, selectedId: null }) },
  }
  const store = {
    getState: () => state,
    subscribe(fn) { listeners.push(fn); return () => {} },
    _set(patch) {
      const prev = state
      state = { ...state, ...patch }
      for (const fn of listeners) fn(state, prev)
    },
  }
  return store
}

/** Nimmt auf, was gesendet wird, und erlaubt das Hineinschieben von Nachrichten. */
class FakeSocket {
  constructor() {
    this.readyState = 1
    this.sent = []
    FakeSocket.last = this
  }
  send(text) { this.sent.push(JSON.parse(text)) }
  close() { this.readyState = 3 }
  /** So, wie QGIS einen Aufruf schicken würde. */
  fromQgis(msg) { this.onmessage({ data: JSON.stringify(msg) }) }
  takeSent() { const s = this.sent; this.sent = []; return s }
}

/** `link` bestimmt, woher die Brücke Port und Marke nimmt:
 *  'injected' = wie im Betrieb (httpserver.py schreibt sie in die Seite),
 *  'hash'     = der Ersatzweg über das URL-Fragment,
 *  'none'     = gar keine, die Seite bleibt eine gewöhnliche Webseite. */
function makeContext(store, link = 'injected') {
  const el = () => ({
    style: { cssText: '' }, textContent: '', title: '', placeholder: '', value: '',
    appendChild() {}, onclick: null, onkeydown: null,
  })
  const window = {
    location: { hash: link === 'hash' ? '#ws=54321&token=GEHEIM' : '' },
    __GRAPH_EXPLORER_API__: { version: 1, store },
  }
  if (link === 'injected') window.__EXPLORER_LINK__ = { ws: 54321, token: 'GEHEIM' }

  const context = {
    window,
    document: { createElement: el, createTextNode: (t) => ({ text: t }), body: el() },
    WebSocket: FakeSocket,
    URL,          // die Brücke liest die Marke aus der Adresse
    setTimeout,
    console,
    JSON,
  }
  vm.createContext(context)
  vm.runInContext(bridgeSrc, context)
  return { window, context }
}

// -- Ablauf ------------------------------------------------------------------

const store = makeStore(GRAPH)
const { window } = makeContext(store)

await sleep(150)          // die Brücke wartet in Intervallen auf die App

const socket = FakeSocket.last
check('Verbindung aufgebaut', !!socket, true)

socket.onopen()
const hello = socket.takeSent()[0]
check('meldet sich mit Marke', hello, { event: 'hello', token: 'GEHEIM', apiVersion: 1 })

// -- Anfragen aus QGIS -------------------------------------------------------

socket.fromQgis({ id: 1, method: 'setSpecs', args: [[SPEC]] })
check('setSpecs bestätigt', socket.takeSent()[0], { id: 1, result: 1 })

socket.fromQgis({ id: 2, method: 'describeGraph', args: [] })
const described = socket.takeSent()[0].result
check('Knotentypen erkannt', described.types.map((t) => t.type).sort(),
      ['Befund', 'Fund', 'Material'])
check('Attribute je Typ', described.types.find((t) => t.type === 'Befund').attrs,
      ['ansprache', 'se'])
check('ohne Namensfunktionen keine Anzeigenamen', described.labels, undefined)

// Mit den Namensfunktionen der App (lib/schema.js) kommen die Anzeigenamen mit
// -- so heißt in QGIS alles wie im Explorer. Hier mit Stellvertretern, die
// zeigen, dass Schema und Schlüssel ankommen.
window.__GRAPH_EXPLORER_API__.labels = {
  type: (schema, t) => (schema && schema.typeLabels[t]) || t,
  edge: (schema, e) => (schema && schema.edgeLabels[e]) || e,
  attr: (k) => k.replace(/_/g, ' '),
}
store._set({ schema: { typeLabels: { Befund: 'Befund (Grabung)' },
                       edgeLabels: { ENTHAELT_FN: 'enthält Fund' } } })
socket.takeSent()
socket.fromQgis({ id: 21, method: 'describeGraph', args: [] })
const named = socket.takeSent()[0].result
check('Typname aus dem Schema', named.types.find((t) => t.type === 'Befund').label,
      'Befund (Grabung)')
check('Typ ohne Schemaeintrag behält den Schlüssel', named.labels.types.Material, 'Material')
check('Beziehungsname aus dem Schema', named.labels.rels.ENTHAELT_FN, 'enthält Fund')
check('beide Beziehungen erfasst', 'ENTHAELT_FN' in named.labels.rels &&
      'MATERIAL' in named.labels.rels, true)
check('Attributname über die App-Funktion', named.labels.attrs.material, 'material')
delete window.__GRAPH_EXPLORER_API__.labels

socket.fromQgis({ id: 3, method: 'collectKeys', args: [SPEC] })
check('Schlüssel der Befunde', socket.takeSent()[0].result,
      [{ id: 'B_1', key: 'SE 2001' }, { id: 'B_2', key: 'SE 2002' }])

// -- Werte für die Attributtabelle -------------------------------------------
//
// Gefragt wird nach den Knoten *einer* Verknüpfung. Was an einem Fund steht,
// hilft der SE-Tabelle nicht -- die Liste soll deshalb nur zeigen, was an den
// Befunden hängt, dazu aber auch, was eine Kante weiter zu holen wäre.

socket.fromQgis({ id: 6, method: 'describeValues', args: [SPEC] })
const inventory = socket.takeSent()[0].result
const byLabel = Object.fromEntries(inventory.values.map((v) => [v.label, v]))

check('beide Befunde gezählt', inventory.total, 2)
check('eigene Properties gefunden',
      inventory.values.filter((v) => v.group === 'Knoten').map((v) => v.label).sort(),
      ['Beschriftung des Knotens', 'ID des Knotens', 'ansprache', 'se'])

// Der eigentliche Ertrag der Zählung: "ansprache" trägt nur einer der beiden
// Befunde. Eine Spalte daraus füllt auch nur die Hälfte der Zeilen, und das
// soll man sehen, bevor sie angelegt ist.
check('Häufigkeit sagt, wie voll die Spalte würde',
      [byLabel.ansprache.count, byLabel.ansprache.of], [1, 2])
check('Beispielwert liegt bei', byLabel.ansprache.sample, 'Graben')

// Eine Anzahl ist eine Zahl. Eine SE-Nummer sieht nur wie eine aus -- und wenn
// beim neunhundertsten Knoten "2001a" steht, wäre sie in einer Zahlenspalte
// eine leere Zelle. Deshalb ist alles andere Text, bis jemand es umstellt.
check('Anzahl wird als Zahlenspalte vorgeschlagen',
      byLabel['→ ENTHAELT_FN: Anzahl'].kind, 'int')
check('eine Nummer bleibt vorsichtshalber Text', byLabel.se.kind, 'text')
check('Beschriftungen der Nachbarn',
      byLabel['→ ENTHAELT_FN: Beschriftungen'].sample, 'Fund 17; Fund 18')
// Attribute der Nachbarn sind der Grund, aus dem die Kopplung sich überhaupt
// lohnt: Das Material hängt am Fund, gefragt ist es an der SE.
check('Attribute der Nachbarn',
      byLabel['→ ENTHAELT_FN: material'].sample, 'Keramik; Eisen')

// Und die Gegenprobe: Ein Wert, den es an diesem Knotentyp nicht gibt, steht
// auch nicht in der Liste. Sonst legte man Spalten an, die leer bleiben.
check('nichts Fremdes in der Liste', byLabel.material, undefined)

socket.fromQgis({
  id: 7,
  method: 'collectValues',
  args: [SPEC, [
    { kind: 'attr', attr: 'ansprache' },
    { kind: 'rel', dir: 'out', rel: 'ENTHAELT_FN', what: 'count' },
    { kind: 'rel', dir: 'out', rel: 'ENTHAELT_FN', what: 'attr', attr: 'material' },
  ]],
})
check('Werte je Knoten, in der Reihenfolge der Anfrage', socket.takeSent()[0].result, [
  { id: 'B_1', key: 'SE 2001', values: ['Graben', 2, ['Keramik', 'Eisen']] },
  // null heißt "hat er nicht", 0 heißt "keine Funde" -- der Unterschied
  // entscheidet, ob die Zelle leer bleibt oder eine Aussage trägt.
  { id: 'B_2', key: 'SE 2002', values: [null, 0, null] },
])

// -- Auflösung: Explorer -> QGIS ---------------------------------------------

// Die Brücke sendet nur, wenn sich die *Schlüssel* ändern -- nicht bei jedem
// Klick. Für die Auflösungsprüfungen muss deshalb zwischendurch abgeräumt
// werden, sonst prüft man versehentlich die Sparsamkeit statt der Auflösung.
function selectFresh(id) {
  store._set({ selectedId: null })
  socket.takeSent()
  store._set({ selectedId: id })
  return socket.takeSent()[0]
}

check('Befund trägt den Schlüssel selbst',
      selectFresh('B_1'), { event: 'selection', nodeId: 'B_1', keys: ['SE 2001'] })

// Der eigentliche Prüfstein: Ein Fund trägt keine SE-Nummer.
check('Fund löst über eine Kante zur SE auf',
      selectFresh('F_1'), { event: 'selection', nodeId: 'F_1', keys: ['SE 2001'] })

check('Material löst über zwei Kanten auf',
      selectFresh('K_1'), { event: 'selection', nodeId: 'K_1', keys: ['SE 2001'] })

// Nicht "X_1 liefert nichts" prüfen -- aus dem Leeren heraus ändert das nichts
// und wird zu Recht nicht gesendet. Interessant ist der Fall, der vorkommt:
// von einem Befund weg auf etwas Unverbundenes. Dann muss die Hervorhebung in
// QGIS aufgehoben werden, sonst bleibt eine Fläche markiert, die mit dem
// gerade offenen Knoten nichts zu tun hat.
store._set({ selectedId: 'B_1' })
socket.takeSent()
store._set({ selectedId: 'X_1' })
check('Wechsel auf einen Knoten ohne Bezug räumt die Hervorhebung ab',
      socket.takeSent()[0], { event: 'selection', nodeId: 'X_1', keys: [] })

// Und die Kehrseite davon: Wer sich innerhalb einer SE von Fund zu Fund
// bewegt, darf QGIS nicht bei jedem Schritt neu auswählen lassen -- das
// Kartenfenster würde bei jedem Klick flackern.
store._set({ selectedId: 'B_1' })
socket.takeSent()
store._set({ selectedId: 'F_1' })   // andere ID, gleiche Schlüssel
check('unveränderte Schlüssel senden nicht erneut', socket.takeSent(), [])

// -- Rückkopplungssperre -----------------------------------------------------
//
// Ohne sie: QGIS wählt aus -> Explorer wählt aus -> Explorer meldet zurück ->
// QGIS wählt aus -> ... Der Test prüft, dass genau das nicht passiert.

store._set({ selectedId: null })
socket.takeSent()

socket.fromQgis({ id: 4, method: 'selectNodes', args: [['B_2']] })
const afterSelect = socket.takeSent()
check('Auswahl aus QGIS wird übernommen', store.getState().selectedId, 'B_2')
check('und nicht zurückgeworfen',
      afterSelect.filter((m) => m.event === 'selection'), [])

// Nach dem Freigeben der Sperre muss eine *echte* Auswahl wieder durchkommen --
// eine Sperre, die klemmt, wäre genauso kaputt wie gar keine.
await sleep(20)
store._set({ selectedId: 'B_1' })
check('spätere Auswahl kommt wieder durch',
      socket.takeSent()[0], { event: 'selection', nodeId: 'B_1', keys: ['SE 2001'] })

// -- Graph stückweise laden --------------------------------------------------

const graphJson = JSON.stringify({ nodes: { N_1: { l: 'neu', t: 'Befund', a: { se: '9' } } } })
const half = Math.floor(graphJson.length / 2)
socket.fromQgis({ method: 'loadGraphChunk', args: [graphJson.slice(0, half), false] })
socket.fromQgis({ id: 5, method: 'loadGraphChunk', args: [graphJson.slice(half), true] })
check('stückweise übertragener Graph kommt an', socket.takeSent().pop(), { id: 5, result: '' })
check('und ist geladen', Object.keys(store.getState().graph.nodes), ['N_1'])

// -- Methoden auch ohne QGIS erreichbar --------------------------------------

check('für die Browser-Konsole exponiert', typeof window.__QGIS_BRIDGE__.describeGraph, 'function')

// -- Woher die Verbindungsdaten kommen ---------------------------------------
//
// Der erste Anlauf in QGIS hing genau hier: Die Daten standen nur im
// URL-Fragment, und das fiel unter Windows beim Öffnen weg. Seitdem schreibt
// httpserver.py sie in die Seite -- der Ersatzweg bleibt trotzdem bestehen.

FakeSocket.last = null
makeContext(makeStore(GRAPH), 'hash')
await sleep(150)
check('Ersatzweg über das URL-Fragment trägt noch', !!FakeSocket.last, true)
if (FakeSocket.last) {
  FakeSocket.last.onopen()
  check('und meldet dieselbe Marke', FakeSocket.last.takeSent()[0].token, 'GEHEIM')
}

// Ohne Verbindungsdaten darf nichts passieren -- sonst würde jeder, der die
// Datei einfach so aufmacht, eine Fehlermeldung sehen.
FakeSocket.last = null
makeContext(makeStore(GRAPH), 'none')
await sleep(150)
check('ohne Verbindungsdaten bleibt es still', FakeSocket.last, null)

// -- Ergebnis ----------------------------------------------------------------

if (failures.length) {
  console.log(`\n${failures.length} Prüfung(en) fehlgeschlagen:\n`)
  for (const f of failures) console.log(`  - ${f}\n`)
  process.exit(1)
}
console.log('explorer-bridge.js: alle Prüfungen bestanden.')
