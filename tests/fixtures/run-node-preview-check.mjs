// run-node-preview-check.mjs
//
// Tests the content of the hover quick-info card (src/lib/nodePreview.js):
// attribute ordering shared with the Explorer's detail view, truncation,
// image detection, connection grouping and the bounds that keep the card
// from growing past what fits on screen.
//
// Usage: node run-node-preview-check.mjs

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

const { buildNodePreview, orderedAttrKeys, truncate, MAX_ATTRS, MAX_CONN_GROUPS, MAX_CONN_SAMPLE, MAX_VALUE_LEN } =
  await import(L('nodePreview.js'))

const H = (s) => console.log('\n===== ' + s + ' =====')
let failed = 0
function check(label, cond, extra = '') {
  if (!cond) failed++
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}${extra ? '  ' + extra : ''}`)
}

// A small stand-in for the archaeological case from the request: an SE that
// contains finds, plus the finds themselves.
const graph = {
  nodes: {
    SE1: {
      l: 'SE 12',
      t: 'Befund',
      a: { ansprache: 'Graben', beschreibung: 'Verfuellung', zeit: '1989' },
      o: { ENTHAELT: ['F1', 'F2', 'F3', 'F4'], VERORTET_IN: ['L1'] },
      i: { HAT_BEFUND: ['K1'] },
    },
    F1: { l: 'Fund 1', t: 'Fund', a: { material: 'Bronze' }, o: {}, i: { ENTHAELT: ['SE1'] } },
    F2: { l: 'Fund 2', t: 'Fund', a: {}, o: {}, i: { ENTHAELT: ['SE1'] } },
    F3: { l: 'Fund 3', t: 'Fund', a: {}, o: {}, i: { ENTHAELT: ['SE1'] } },
    F4: { l: 'Fund 4', t: 'Fund', a: {}, o: {}, i: { ENTHAELT: ['SE1'] } },
    L1: { l: 'Flaeche 3', t: 'Ort', a: {}, o: {}, i: {} },
    K1: { l: 'Kampagne 1989', t: 'Kampagne', a: {}, o: {}, i: {} },
  },
}
const schema = { mainAttrs: { Befund: ['ansprache'] } }

// ── attribute order ─────────────────────────────────────────────────────────
H('Attribut-Reihenfolge (geteilt mit der Detailansicht)')
check('mainAttrs zuerst, Rest alphabetisch',
  orderedAttrKeys(schema, graph.nodes.SE1).join(',') === 'ansprache,beschreibung,zeit',
  orderedAttrKeys(schema, graph.nodes.SE1).join(','))
check('ohne Schema rein alphabetisch',
  orderedAttrKeys(null, graph.nodes.SE1).join(',') === 'ansprache,beschreibung,zeit')
check('leere Werte fallen raus',
  orderedAttrKeys(null, { t: 'X', a: { a: 'x', b: '', c: null, d: 0 } }).join(',') === 'a,d',
  '(0 ist ein Wert, "" und null nicht)')

// ── truncation ──────────────────────────────────────────────────────────────
H('Werte kuerzen')
const long = 'x'.repeat(200)
check('lange Werte gekuerzt', truncate(long).length === MAX_VALUE_LEN)
check('gekuerzte Werte enden mit Ellipse', truncate(long).endsWith('…'))
check('kurze Werte unveraendert', truncate('Bronze') === 'Bronze')
check('Zeilenumbrueche werden zu Leerzeichen', truncate('a\n  b') === 'a b')

// ── the card itself ─────────────────────────────────────────────────────────
H('Karteninhalt')
const p = buildNodePreview(graph, schema, 'SE1')
check('Label und Typ uebernommen', p.label === 'SE 12' && p.type === 'Befund')
check('Attribute in der richtigen Reihenfolge', p.attrs.map((a) => a.key).join(',') === 'ansprache,beschreibung,zeit')
check('ausgehende vor eingehenden Verbindungen',
  p.connections.map((c) => c.dir + ':' + c.etype).join(' ') === 'o:ENTHAELT o:VERORTET_IN i:HAT_BEFUND',
  p.connections.map((c) => c.dir + ':' + c.etype).join(' '))
check('Anzahl je Verbindung', p.connections[0].count === 4)
check('Beispiel-Labels statt IDs', p.connections[0].sample.join(',') === 'Fund 1,Fund 2,Fund 3')
check(`hoechstens ${MAX_CONN_SAMPLE} Beispiele`, p.connections[0].sample.length === MAX_CONN_SAMPLE)
check('Gesamtzahl der Verbindungen', p.totalConnections === 6, String(p.totalConnections))
check('unbekannte ID ergibt keine Karte', buildNodePreview(graph, schema, 'gibtsnicht') === null)
check('ohne Graph keine Karte', buildNodePreview(null, schema, 'SE1') === null)

// The saved per-type connection order from the detail view must carry over,
// otherwise the card would list connections differently than the panel does.
const reordered = buildNodePreview(graph, schema, 'SE1', { connOrder: ['i:HAT_BEFUND', 'o:VERORTET_IN'] })
check('gespeicherte Verbindungs-Reihenfolge wird uebernommen',
  reordered.connections.map((c) => c.dir + ':' + c.etype).join(' ') === 'i:HAT_BEFUND o:VERORTET_IN o:ENTHAELT',
  reordered.connections.map((c) => c.dir + ':' + c.etype).join(' '))

// ── bounds ──────────────────────────────────────────────────────────────────
H('Begrenzung')
const wide = { nodes: { N: { l: 'N', t: 'T', a: {}, o: {}, i: {} } } }
for (let i = 0; i < 20; i++) wide.nodes.N.a['attr' + String(i).padStart(2, '0')] = 'v' + i
for (let i = 0; i < 9; i++) wide.nodes.N.o['E' + i] = ['N']
const wp = buildNodePreview(wide, null, 'N')
check(`hoechstens ${MAX_ATTRS} Attribute`, wp.attrs.length === MAX_ATTRS)
check('Rest wird gezaehlt', wp.moreAttrs === 14, String(wp.moreAttrs))
check(`hoechstens ${MAX_CONN_GROUPS} Verbindungsarten`, wp.connections.length === MAX_CONN_GROUPS)
check('restliche Verbindungsarten gezaehlt', wp.moreConnections === 4, String(wp.moreConnections))

// ── images ──────────────────────────────────────────────────────────────────
H('Bilder')
const img = {
  nodes: {
    A: { l: 'Mit Bild', t: 'T', a: { bild: 'https://example.org/x.jpg', material: 'Ton' }, o: {}, i: {} },
    B: { l: 'Ohne Bild', t: 'T', a: { material: 'Ton' }, o: {}, i: {} },
    'https://example.org/y.png': { l: 'ID ist Bild', t: 'T', a: {}, o: {}, i: {} },
  },
}
const ip = buildNodePreview(img, null, 'A')
check('Bild aus Attribut erkannt', ip.image === 'https://example.org/x.jpg')
check('Bild-URL nicht zusaetzlich als Textzeile', ip.attrs.map((a) => a.key).join(',') === 'material',
  ip.attrs.map((a) => a.key).join(','))
check('ohne Bild kein Bild', buildNodePreview(img, null, 'B').image === null)
check('Bild-URL als Knoten-ID erkannt',
  buildNodePreview(img, null, 'https://example.org/y.png').image === 'https://example.org/y.png')

// ── against the real dataset ────────────────────────────────────────────────
H('echter Datensatz')
const trigPath = path.join(__dirname, 'example-rdf.trig')
if (!fs.existsSync(trigPath)) {
  console.log('(example-rdf.trig nicht vorhanden - uebersprungen)')
} else {
  const { rdfTextToGraph } = await import(L('rdfImport.js'))
  const g = rdfTextToGraph(fs.readFileSync(trigPath, 'utf8'), 'trig')
  const ids = Object.keys(g.nodes)
  const t = Date.now()
  let nulls = 0
  let overflow = 0
  for (const id of ids) {
    const pv = buildNodePreview(g, g.schema, id)
    if (!pv) { nulls++; continue }
    if (pv.attrs.length > MAX_ATTRS || pv.connections.length > MAX_CONN_GROUPS) overflow++
    if (pv.attrs.some((a) => a.value.length > MAX_VALUE_LEN)) overflow++
  }
  console.log(`${ids.length} Knoten in ${Date.now() - t}ms`)
  check('jeder vorhandene Knoten liefert eine Karte', nulls === 0, String(nulls))
  check('keine Karte sprengt ihre Grenzen', overflow === 0, String(overflow))
}

console.log(failed ? `\n[${failed} FEHLGESCHLAGEN]` : '\n[done]')
process.exit(failed ? 1 : 0)
