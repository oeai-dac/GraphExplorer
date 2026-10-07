// run-collapse-check.mjs
//
// Tests the pass-through node-collapsing (graph node contraction) in
// src/lib/collapse.js against a synthetic
// SE -> Embedding -> Fund graph and the real full-dataset TriG.
//
// Usage: node --max-old-space-size=2048 run-collapse-check.mjs

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

const { rdfTextToGraph } = await import(L('rdfImport.js'))
const { collapseTypes, collapsePreview } = await import(L('collapse.js'))
const { hasTemporalData, getTemporalOptions, buildTimelineEvents } = await import(L('temporal.js'))

const H = (s) => console.log('\n===== ' + s + ' =====')

// ── synthetic clean SE -> Embedding -> Fund ─────────────────────────────────
H('synthetic SE -> Embedding -> Fund')
const ttl = `@prefix ex: <http://example.org/> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
ex:SE1 a ex:SE ; rdfs:label "SE 1" ; ex:isEmbeddingAt ex:Emb1, ex:Emb2 .
ex:Emb1 a ex:Embedding ; ex:isEmbeddingOf ex:Fund1 .
ex:Emb2 a ex:Embedding ; ex:isEmbeddingOf ex:Fund2 .
ex:Fund1 a ex:Fund ; rdfs:label "Fund 1" ; ex:material "Bronze" .
ex:Fund2 a ex:Fund ; rdfs:label "Fund 2" .`
const g0 = rdfTextToGraph(ttl, 'ttl')
const EMB = 'http://example.org/Embedding'
console.log('before: nodes', g0.meta.node_count, '| preview removes', collapsePreview(g0, [EMB]))
const g1 = collapseTypes(g0, [EMB])
console.log('after:  nodes', g1.meta.node_count, '| Embedding gone:', g1.nodes['http://example.org/Emb1'] === undefined)
console.log('SE1 now links directly to:', JSON.stringify(g1.nodes['http://example.org/SE1'].o))
console.log('Fund1 incoming:', JSON.stringify(g1.nodes['http://example.org/Fund1'].i))
console.log('bypass edge label:', Object.entries(g1.schema.edgeLabels).filter(([k]) => k.includes('»')).map(([, v]) => v))

// ── CIDOC relator pattern: BOTH edges point OUT of the event node ───────────
H('CIDOC pattern  Fund <-AP18- Embedding -AP19-> SE  (both edges out)')
const ttl2 = `@prefix ex: <http://example.org/> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
ex:Emb1 a ex:Embedding ; ex:isEmbeddingOf ex:FundA ; ex:isEmbeddingAt ex:SE_X .
ex:Emb2 a ex:Embedding ; ex:isEmbeddingOf ex:FundB ; ex:isEmbeddingAt ex:SE_X .
ex:FundA a ex:Fund ; rdfs:label "Fund A" .
ex:FundB a ex:Fund ; rdfs:label "Fund B" .
ex:SE_X a ex:SE ; rdfs:label "SE X" .`
const g2 = rdfTextToGraph(ttl2, 'ttl')
console.log('before: nodes', g2.meta.node_count, '| SE_X neighbours (o/i):',
  JSON.stringify(g2.nodes['http://example.org/SE_X'].o), JSON.stringify(g2.nodes['http://example.org/SE_X'].i))
const g2c = collapseTypes(g2, ['http://example.org/Embedding'])
console.log('after:  nodes', g2c.meta.node_count)
const seX = g2c.nodes['http://example.org/SE_X']
const fundA = g2c.nodes['http://example.org/FundA']
const linked = JSON.stringify(seX.o) + JSON.stringify(seX.i)
console.log('SE_X now connected to FundA/FundB?',
  linked.includes('FundA') && linked.includes('FundB'), '  (must be true — the info must survive!)')
console.log('  SE_X.o:', JSON.stringify(seX.o))
console.log('  SE_X.i:', JSON.stringify(seX.i))
console.log('  FundA.o:', JSON.stringify(fundA.o), '| FundA.i:', JSON.stringify(fundA.i))

// ── Studio graph: `i` is named differently from `o` (resolved inverses) ─────
// The reported case: an Ort links to a POI as "Hat POIs", the POI links back
// as "Ist POI von". Collapsing ANY type must not turn the incoming side into
// the forward wording -- neither for untouched edges nor for a bypass edge,
// which has to be readable from both ends.
H('inverse Kantennamen ueberleben das Zusammenfassen')
const studio = {
  node_types: { Ort: 1, POI: 1, Fund: 1, Einmessung: 1 },
  edge_types: { hat_pois: 1, hat_einmessung: 1, hat_fundort: 1 },
  schema: {
    typeColors: {}, typeLabels: {}, mainAttrs: {},
    edgeLabels: {
      hat_pois: 'Hat POIs', ist_poi_von: 'Ist POI von',
      hat_einmessung: 'Hat Einmessung', ist_einmessung_von: 'Ist Einmessung von',
      hat_fundort: 'Hat Fundort', ist_fundort_von: 'Ist Fundort von',
    },
  },
  nodes: {
    ORT: { l: 'Ephesos', t: 'Ort', a: {}, o: { hat_pois: ['POI'] }, i: {} },
    POI: { l: 'Domitiansplatz', t: 'POI', a: {}, o: {}, i: { ist_poi_von: ['ORT'], ist_fundort_von: ['EIN'] } },
    FUND: { l: 'Fibel', t: 'Fund', a: {}, o: { hat_einmessung: ['EIN'] }, i: {} },
    EIN: { l: 'Einmessung 1', t: 'Einmessung', a: {}, o: { hat_fundort: ['POI'] }, i: { ist_einmessung_von: ['FUND'] } },
  },
}
{
  const c = collapseTypes(studio, ['Einmessung'])
  const lbl = (k) => c.schema.edgeLabels[k] || k
  const keys = (nd, dir) => Object.keys(nd[dir]).map(lbl)
  console.log('Ort   ->', keys(c.nodes.ORT, 'o'), '| POI <-', keys(c.nodes.POI, 'i'))
  console.log('unberuehrte Kante behaelt ihre Inverse:',
    keys(c.nodes.POI, 'i').includes('Ist POI von'), ' (nicht "Hat POIs")')
  console.log('Bypass  Fund ->', keys(c.nodes.FUND, 'o'), ' | POI <-', keys(c.nodes.POI, 'i'))
  console.log('Bypass rueckwaerts lesbar:',
    keys(c.nodes.POI, 'i').includes('Ist Fundort von › Ist Einmessung von'))
}

// ── literal-only LEAF: a Time-Span that only carries a date ─────────────────
// The reported case: Fund -> Herstellung -> Zeitraum(begin/end literals). The
// Zeitraum has ONE arm, so there is nothing to reconnect -- collapsing it must
// still leave the dating behind, on the neighbour, or the date is destroyed.
H('literal-only leaf: Fund -> Herstellung -> Zeitraum(1850-1900)')
const ttl3 = `@prefix ex: <http://example.org/> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
ex:Fund1 a ex:Fund ; rdfs:label "Fund 1" ; ex:material "Bronze" ; ex:hasTimeSpan ex:Zeitraum1 .
ex:Fund2 a ex:Fund ; rdfs:label "Fund 2" ; ex:hasTimeSpan ex:Zeitraum2 .
ex:Zeitraum1 a ex:Zeitraum ; ex:beginn "1850" ; ex:ende "1900" .
ex:Zeitraum2 a ex:Zeitraum ; ex:beginn "1600" ; ex:ende "1650" .`
const g3 = rdfTextToGraph(ttl3, 'ttl')
const ZR = 'http://example.org/Zeitraum'
const g3c = collapseTypes(g3, [ZR])
const f1 = g3c.nodes['http://example.org/Fund1']
console.log('Zeitraum removed:', g3c.nodes['http://example.org/Zeitraum1'] === undefined)
console.log('Fund1 attrs now:', JSON.stringify(f1.a), '  (beginn/ende must be here!)')
console.log('dating carried over:', f1.a.beginn === '1850' && f1.a.ende === '1900', ' | own attribute kept:', f1.a.material === 'Bronze')
console.log('Fund2 got its OWN dates, not Fund1\'s:',
  JSON.stringify(g3c.nodes['http://example.org/Fund2'].a))

// ── the point of the whole exercise: the Zeitstrahl now dates the FIND ──────
H('collapse -> Zeitstrahl: the dating moves onto the find')
{
  const before = buildTimelineEvents(g3, getTemporalOptions(g3)[0] || null)
  const optsAfter = getTemporalOptions(g3c)
  const after = buildTimelineEvents(g3c, optsAfter[0] || null)
  const isFund = (e) => g3c.nodes[e.nodeId]?.t === 'http://example.org/Fund'
  console.log('before: dated nodes are', before.map((e) => e.label || e.nodeId.split('/').pop()).join(', '))
  console.log('after:  dated nodes are', after.map((e) => e.label).join(', '))
  console.log('graph still datable:', hasTemporalData(g3c),
    '| both finds dated:', after.filter(isFund).length === 2,
    '| Fund 1 = 1850-1900:', after.some((e) => e.label === 'Fund 1' && e.start === 1850 && e.end === 1900))
}

// ── many collapsed components on one hub node: values are merged, capped ────
H('hub node: one SE, 12 dated embeddings -> merged + capped')
const many = ['@prefix ex: <http://example.org/> .', 'ex:SE1 a ex:SE ; ex:note "eigene Notiz" .']
for (let i = 1; i <= 12; i++) {
  many.push(`ex:Emb${i} a ex:Embedding ; ex:note "N${i}" ; ex:isEmbeddingOf ex:F${i} ; ex:isEmbeddingAt ex:SE1 .`)
  many.push(`ex:F${i} a ex:Fund .`)
}
const g4 = rdfTextToGraph(many.join('\n'), 'ttl')
const g4c = collapseTypes(g4, ['http://example.org/Embedding'])
const seNote = g4c.nodes['http://example.org/SE1'].a.note
console.log('SE1 note:', JSON.stringify(seNote))
console.log('  own value first:', seNote.startsWith('eigene Notiz'),
  '| capped:', seNote.endsWith('…'), '| parts:', seNote.split(' · ').length, '(must not grow unbounded)')
console.log('F3 note:', JSON.stringify(g4c.nodes['http://example.org/F3'].a.note), '(exactly its own embedding)')

// ── real full-dataset TriG: collapse S23_Position_Determination ─────────────
H('real trig: collapse S23_Position_Determination')
const trigPath = path.join(__dirname, 'example-rdf.trig')
if (!fs.existsSync(trigPath)) { console.log('(example-rdf.trig nicht vorhanden - uebersprungen)'); process.exit(0) }
const g = rdfTextToGraph(fs.readFileSync(trigPath, 'utf8'), 'trig')
const S23 = 'http://www.cidoc-crm.org/extensions/crmsci/S23_Position_Determination'
const t = Date.now()
const gc = collapseTypes(g, [S23])
console.log(`collapse in ${Date.now() - t}ms`)
console.log(`nodes ${g.meta.node_count} -> ${gc.meta.node_count}  (removed ${g.node_types[S23]} S23)`)
console.log('S23 removed from node_types:', gc.node_types[S23] === undefined)
// integrity: no adjacency may reference a removed node
let dangling = 0
for (const nd of Object.values(gc.nodes)) {
  for (const arr of Object.values(nd.o)) for (const x of arr) if (!gc.nodes[x]) dangling++
  for (const arr of Object.values(nd.i)) for (const x of arr) if (!gc.nodes[x]) dangling++
}
console.log('dangling references to removed nodes:', dangling, '(must be 0)')
console.log('\n[done]')
