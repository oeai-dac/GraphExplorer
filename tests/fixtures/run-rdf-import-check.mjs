// run-rdf-import-check.mjs
//
// Exercises the client-side RDF importer (src/lib/rdfImport.js)
// against the real full-dataset TriG and a tiny RDF-star sample, then feeds the
// result through the same Explorer lib functions the UI uses, to confirm the
// imported graph is usable (types, dot-one/Harris, geo).
//
// Usage: node --max-old-space-size=4096 run-rdf-import-check.mjs

import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { register } from 'node:module'

// lib files use Vite-style extensionless imports ("./schema") -- add .js
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

const { rdfTextToGraph, rdfExtSupported } = await import(L('rdfImport.js'))
const { deriveSchema, typeLabel } = await import(L('schema.js'))
const harris = await import(L('harrisMatrix.js'))
const geo = await import(L('geo.js'))
const { buildTypeGraph } = await import(L('schemaGraph.js'))

const H = (s) => console.log('\n===== ' + s + ' =====')

// ── 1. tiny RDF-star sample ────────────────────────────────────────────────
H('1. Tiny TriG with RDF-star + literals + multi-value + collision')
const sample = `
@prefix ex: <http://example.org/> .
@prefix crm: <http://www.cidoc-crm.org/cidoc-crm/> .
@prefix ap: <http://www.cidoc-crm.org/extensions/crmarchaeo/> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
@prefix foaf: <http://xmlns.com/foaf/0.1/> .
ex:SU1 a ap:A8_Stratigraphic_Unit ; rdfs:label "SU 1"@de ; ex:note "first" ; ex:note "second" .
ex:SU2 a ap:A8_Stratigraphic_Unit ; rdfs:label "SU 2"@de ; ex:geom "POINT(16.37 48.20)" .
ex:P1 a ex:Person ; foaf:name "Ada Lovelace" .
ex:C1 a ex:Concept ; skos:prefLabel "Bronze"@de ; skos:prefLabel "bronze"@en .
ex:X1 a ex:Thing .
ex:SU1 ap:AP11_has_physical_relation_to ex:SU2 .
<< ex:SU1 ap:AP11_has_physical_relation_to ex:SU2 >> ap:AP11.1_has_type ex:ueber .
`
const g1 = rdfTextToGraph(sample, 'trig', 'sample')
console.log('nodes:', g1.meta.node_count, 'edges:', g1.meta.edge_count)
console.log('node_types:', JSON.stringify(g1.node_types))
console.log('edge_types:', JSON.stringify(g1.edge_types))
console.log('SU1.a (multi-value note merged?):', JSON.stringify(g1.nodes['http://example.org/SU1'].a))
console.log('SU1.o:', JSON.stringify(g1.nodes['http://example.org/SU1'].o))
console.log('SU2.o (derived reverse dot-one?):', JSON.stringify(g1.nodes['http://example.org/SU2'].o))
console.log('dot1 edgeLabels:', JSON.stringify(Object.fromEntries(Object.entries(g1.schema.edgeLabels).filter(([k]) => k.includes('#dot1:')))))
console.log('hasDotOneData:', harris.hasDotOneData(g1), '| hasGeoData:', geo.hasGeoData(g1))
console.log('LABELS (name/prefLabel, not identifier):')
console.log('  foaf:name  P1.l =', JSON.stringify(g1.nodes['http://example.org/P1'].l), '(expect "Ada Lovelace")')
console.log('  skos de    C1.l =', JSON.stringify(g1.nodes['http://example.org/C1'].l), '(expect "Bronze" - German preferred)')
console.log('  no label   X1.l =', JSON.stringify(g1.nodes['http://example.org/X1'].l), '(expect "X1" - falls back to identifier)')
console.log('rdfExtSupported: trig=%s rdf=%s json=%s', rdfExtSupported('trig'), rdfExtSupported('rdf'), rdfExtSupported('json'))

// ── 1b. dot-one qualifier as a LABELLED type resource ──────────────────────
// The Harris-Matrix-Editor export writes AP11.1_has_type as an E55_Type
// individual (hme:Relationstyp_above), not a literal. Humanising that URI
// gives "Relationstyp above", which matches no vocabulary entry -- every
// relation would land in unknownEdges and the matrix would draw flat. The
// rdfs:label of the type carries the real word and must win. The label is
// placed AFTER the annotation here on purpose: Turtle guarantees no ordering,
// so the importer has to resolve labels before emitting dot-one edges.
H('1b. AP11.1_has_type points at a labelled E55_Type (Harris-Matrix export shape)')
const typed = `
@prefix ex: <http://example.org/> .
@prefix ap: <http://www.cidoc-crm.org/extensions/crmarchaeo/> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
ex:SU1 a ap:A8_Stratigraphic_Unit ; rdfs:label "SU 1"@de .
ex:SU2 a ap:A8_Stratigraphic_Unit ; rdfs:label "SU 2"@de .
ex:SU1 ap:AP11_has_physical_relation_to ex:SU2 .
<< ex:SU1 ap:AP11_has_physical_relation_to ex:SU2 >> ap:AP11.1_has_type ex:Relationstyp_above .
ex:Relationstyp_above rdfs:label "above"@en .
`
const g1b = rdfTextToGraph(typed, 'ttl', 'typed-qualifier')
const keys1b = [...new Set(Object.values(g1b.nodes).flatMap((n) => Object.keys(n.o)))]
  .filter((k) => k.includes('#dot1:')).map((k) => k.split('#dot1:')[1]).sort()
console.log('dot1 values:', JSON.stringify(keys1b), '(expect ["above","below"], NOT "relationstyp above")')
const ids1b = Object.keys(g1b.nodes)
const seq1b = harris.buildSequence(g1b, ids1b, 'http://www.cidoc-crm.org/extensions/crmarchaeo/AP11_has_physical_relation_to')
console.log('rank:', seq1b.rankEdges.length, 'unknown:', seq1b.unknownEdges.length, '(expect rank 1, unknown 0)')
const lower1b = seq1b.rankEdges[0]
console.log('"SU1 above SU2" -> lower end is SU2:',
  lower1b?.source === 'http://example.org/SU2' && lower1b?.target === 'http://example.org/SU1')

// ── 2. real full-dataset TriG ──────────────────────────────────────────────
H('2. Real tests/fixtures/example-rdf.trig')
const trigPath = path.join(__dirname, 'example-rdf.trig')
if (!fs.existsSync(trigPath)) { console.log('(example-rdf.trig nicht vorhanden - uebersprungen)'); process.exit(0) }
let t = Date.now()
const trig = fs.readFileSync(trigPath, 'utf8')
const g = rdfTextToGraph(trig, 'trig', '8_full-dataset')
console.log(`import: ${Date.now() - t}ms  nodes=${g.meta.node_count} edges=${g.meta.edge_count}`)
console.log('node types:', Object.keys(g.node_types).length, '| edge types:', Object.keys(g.edge_types).length)
const dot1 = Object.keys(g.edge_types).concat(Object.keys(g.schema.edgeLabels)).filter((k) => k.includes('#dot1:'))
console.log('dot1 edge keys:', [...new Set(dot1)])

// feed through the Explorer lib the UI relies on
t = Date.now()
const schema = deriveSchema(g)
console.log('deriveSchema ok:', Object.keys(schema.typeColors).length, 'type colors')
console.log('hasDotOneData:', harris.hasDotOneData(g), 'in', Date.now() - t, 'ms')
console.log('hasGeoData:', geo.hasGeoData(g))
const attrs = geo.detectGeoAttributes(g)
console.log('geo attributes detected:', attrs.length)
const tg = buildTypeGraph(g, schema)
console.log('buildTypeGraph:', tg.nodes.length, 'type-nodes,', tg.edges.length, 'type-edges')
const allIds = Object.keys(g.nodes)
const dps = harris.detectDotOneProperties(g, allIds)
console.log('detectDotOneProperties:', dps)
if (dps.length) {
  const seq = harris.buildSequence(g, allIds, dps[0])
  console.log('buildSequence:', JSON.stringify({ rank: seq.rankEdges.length, same: seq.sameRankEdges.length, equals: seq.equalsEdges.length, unknown: seq.unknownEdges.length }))
}

// ── 3. compare against the backend-produced graph-explorer JSON ────────────
H('3. Sanity vs backend-produced 8_full-dataset_graphexplorer.json')
const gePath = path.join(__dirname, 'example-graph.json')
if (fs.existsSync(gePath)) {
  const ge = JSON.parse(fs.readFileSync(gePath, 'utf8'))
  console.log(`backend: nodes=${ge.meta.node_count} node_types=${Object.keys(ge.node_types).length}`)
  console.log(`import : nodes=${g.meta.node_count} node_types=${Object.keys(g.node_types).length}`)
  const geIds = new Set(Object.keys(ge.nodes)), imIds = new Set(Object.keys(g.nodes))
  const onlyBackend = [...geIds].filter((x) => !imIds.has(x)).length
  const onlyImport = [...imIds].filter((x) => !geIds.has(x)).length
  console.log(`node-id overlap: only-backend=${onlyBackend}  only-import=${onlyImport}  (differences expected: named-graph URIs, ontology-only resources)`)
}
console.log('\n[done]')
