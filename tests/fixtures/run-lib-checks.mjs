// run-lib-checks.mjs
//
// Exercises the pure logic modules (src/lib/*.js) with
//   (a) the atypical/hostile generic-graph.json fixture, and
//   (b) the real 13 MB export (tests/fixtures/example-graph.json)
// for a scale/perf smoke test.
//
// Bare imports inside the lib files (proj4, dagre) resolve from
// node_modules because ESM resolves relative to each
// module file's own location -- so this script can live in tests/fixtures.
//
// Usage: node run-lib-checks.mjs

import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { register } from 'node:module'

// The lib files use Vite-style extensionless relative imports ("./filters").
// Node's ESM loader needs the ".js" -- register a resolve hook that retries
// with ".js" appended. (No project source is modified.)
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

const { deriveSchema, typeColor, typeLabel, edgeLabel } = await import(L('schema.js'))
const { looksLikeWkt, parseWkt } = await import(L('wkt.js'))
const geo = await import(L('geo.js'))
const harris = await import(L('harrisMatrix.js'))
const { layoutHarrisMatrix } = await import(L('dagreLayout.js'))
const { groupAndCount, pivotCount } = await import(L('chartData.js'))
const { buildTypeGraph } = await import(L('schemaGraph.js'))
const { applyConditions, connectedIds, distinctAttrValues, naturalCompare } = await import(L('filters.js'))
const { getTemporalOptions, buildTimelineEvents, hasTemporalData, filterEventsByYear } = await import(L('temporal.js'))
const { getLaneOptions, buildLanes } = await import(L('timelineLanes.js'))

const graph = JSON.parse(fs.readFileSync(path.join(__dirname, 'generic-graph.json'), 'utf8'))
const line = (s) => console.log(s)
const H = (s) => console.log('\n===== ' + s + ' =====')

// ---------------------------------------------------------------------------
H('1. deriveSchema on schema-less graph')
const schema = deriveSchema(graph)
line('typeColors: ' + JSON.stringify(schema.typeColors))
line('typeLabels: ' + JSON.stringify(schema.typeLabels))
line('empty-type "" color: ' + typeColor(schema, ''))
line('empty-type "" label: ' + JSON.stringify(typeLabel(schema, '')))

// ---------------------------------------------------------------------------
H('2. WKT detection: false positives + NaN coordinate leakage')
const samples = [
  'POINT(16.37 48.20)',      // valid
  'POINT(abc def)',          // garbage numbers -> NaN?
  'POINTER to a POLYGONAL discussion (not geometry)', // must NOT match
  'POLYGON EMPTY',           // no parens
  'POINT ()',                // empty
  'POINT(16.37 48.20) · POINT(16.40 48.21)', // two merged geometries -> must NOT count as one
  'POINT(16.37 48.20) ungenau',              // trailing remark -> must NOT be read as a point
  'POLYGON((0 0, 1 0, 1 1, 0 0))',           // nested parens, valid
]
for (const s of samples) {
  const looks = looksLikeWkt(s)
  let parsed = null, hasNaN = false
  if (looks) { parsed = parseWkt(s); if (parsed) hasNaN = JSON.stringify(parsed.coordinates).includes('null') || /NaN/.test(JSON.stringify(parsed.coordinates).replace(/null/g,'NaN')) }
  // JSON.stringify turns NaN into null; detect via Number.isNaN scan
  let nanLeak = false
  const scan = (c) => { if (Array.isArray(c)) c.forEach(scan); else if (typeof c === 'number' && Number.isNaN(c)) nanLeak = true }
  if (parsed) scan(parsed.coordinates)
  line(`looksLikeWkt=${looks?1:0} parsed=${parsed?parsed.type:'null'} NaN-leak=${nanLeak}  <= ${JSON.stringify(s)}`)
}

H('2b. buildGeoFeatures WGS84 (4326) -- does a NaN geometry become a feature?')
const feat4326 = geo.buildGeoFeatures(graph, '4326')
line('features: ' + feat4326.features.length + ' failed: ' + feat4326.failedCount + ' total: ' + feat4326.totalCount)
for (const f of feat4326.features) {
  const flat = JSON.stringify(f.coordinates)
  const nan = f.coordinates && (function chk(c){return Array.isArray(c)?c.some(chk):(typeof c==='number'&&Number.isNaN(c))})(f.coordinates)
  line(`  node=${f.nodeId} type=${f.type} NaN=${nan} coords=${flat.slice(0,60)}`)
}

H('2c. buildGeoFeatures with EPSG code NOT in table (e.g. 2056 CH1903+)')
const featUnknown = geo.buildGeoFeatures(graph, '2056')
line('epsgToProj4(2056) = ' + geo.epsgToProj4('2056'))
line('buildGeoFeatures(2056) = ' + (featUnknown === null ? 'null (handled)' : JSON.stringify({f:featUnknown.features.length})))
line('epsgToProj4("garbage") = ' + geo.epsgToProj4('garbage'))
line('epsgToProj4("+proj=utm +zone=33 +datum=WGS84") = ' + (geo.epsgToProj4('+proj=utm +zone=33 +datum=WGS84') ? 'accepted raw proj4' : 'rejected'))

// ---------------------------------------------------------------------------
H('3. Harris matrix: tab-gate vs actual dot-one presence + cyclic/contradictory')
line('hasDotOneData(graph) [gate uses schema.edgeLabels] = ' + harris.hasDotOneData(graph))
const seIds = ['SE_A','SE_B','SE_C','SE_D']
line('detectDotOneProperties(SE nodes) = ' + JSON.stringify(harris.detectDotOneProperties(graph, seIds)))
for (const bp of harris.detectDotOneProperties(graph, seIds)) {
  const seq = harris.buildSequence(graph, seIds, bp)
  line(`  baseProp=${bp}: rank=${seq.rankEdges.length} same=${seq.sameRankEdges.length} equals=${seq.equalsEdges.length} unknown=${seq.unknownEdges.length}`)
  line('    rankEdges=' + JSON.stringify(seq.rankEdges) + ' unknown=' + JSON.stringify(seq.unknownEdges))
  // feed into dagre layout (cyclic input!) -- must not hang/throw
  try {
    const lay = layoutHarrisMatrix(seIds, seq.rankEdges, seq.sameRankEdges, seq.equalsEdges)
    line('    layout positions ok: ' + Object.keys(lay.positions).length + ' nodes')
  } catch (e) { line('    layout THREW: ' + e.message) }
}
// schema-derived hasDotOneData with a schema block present:
const withSchema = { ...graph, schema: { edgeLabels: { 'http://ex.org/rel#dot1:widerspruch': 'x' } } }
line('hasDotOneData(with schema.edgeLabels containing dot1) = ' + harris.hasDotOneData(withSchema))

// ---------------------------------------------------------------------------
H('4. Non-scalar attribute values (arrays/objects/null/number)')
const arr = graph.nodes.arr1
line('raw a: ' + JSON.stringify(arr.a))
try { line('distinctAttrValues tags: ' + JSON.stringify(distinctAttrValues(graph, ['arr1'], 'tags'))) } catch(e){ line('distinctAttrValues THREW: '+e.message) }
try {
  const cond = [{ kind:'attr', key:'tags', op:'contains', value:'b' }]
  line('applyConditions attr contains "b": ' + JSON.stringify(applyConditions(graph, ['arr1'], cond)))
} catch(e){ line('applyConditions THREW: '+e.message) }
try {
  const g1 = groupAndCount(graph, ['arr1','n1'], { kind:'attr', key:'tags' }, schema)
  line('groupAndCount by attr tags: ' + JSON.stringify(g1))
} catch(e){ line('groupAndCount THREW: '+e.message) }
try {
  const g2 = groupAndCount(graph, ['arr1','n1'], { kind:'attr', key:'meta' }, schema)
  line('groupAndCount by object attr meta: ' + JSON.stringify(g2))
} catch(e){ line('groupAndCount THREW: '+e.message) }

// ---------------------------------------------------------------------------
H('5. buildTypeGraph + orphan/empty type + KNOWS edge')
const tg = buildTypeGraph(graph, schema)
line('type nodes: ' + tg.nodes.length + ' type edges: ' + tg.edges.length)
line('edges: ' + JSON.stringify(tg.edges.map(e => ({s:e.source,t:e.target,c:e.count}))))

// ---------------------------------------------------------------------------
H('6. >50 distinct node types')
const big = { node_types:{}, edge_types:{}, nodes:{} }
for (let i=0;i<55;i++){ big.node_types['T'+i]=1; big.nodes['b'+i]={l:'b'+i,t:'T'+i,a:{},o:{},i:{}} }
const bigSchema = deriveSchema(big)
const distinctColors = new Set(Object.values(bigSchema.typeColors))
line('55 types -> distinct colors used: ' + distinctColors.size + ' (palette length 20, cycling expected)')
line('T0 color=' + bigSchema.typeColors['T0'] + '  T20 color=' + bigSchema.typeColors['T20'] + '  (should be equal if cycling)')

// ---------------------------------------------------------------------------
H('7. naturalCompare edge cases')
for (const [a,b] of [['SE2','SE10'],['SE10','SE2'],['abc','abc'],['','x'],['A1B2','A1B10']]) {
  line(`naturalCompare(${JSON.stringify(a)},${JSON.stringify(b)}) = ${naturalCompare(a,b)}`)
}

// ---------------------------------------------------------------------------
H('7b. Timeline temporal parsing: CIDOC start/finish spans + combined view')
{
  // Mirrors a real dataset shape: an excavation dated with a CIDOC start/finish
  // SPAN (AP24_starts / AP23_finishes -- DIFFERENT property-number prefixes, so
  // the shared-prefix von/bis rule can't pair them) plus campaigns dated with a
  // single took_place_in_year POINT. Both must show, and a combined "Alle
  // Datierungen" view must carry every dated node on one axis.
  const g = { nodes: {
    Grabung: { l: 'Grabung', t: 'grabung', a: { AP24_starts: '2019', AP23_finishes: '2024' } },
    K22: { l: 'Kampagne 2022', t: 'kampagne', a: { took_place_in_year: '2022' } },
    K23: { l: 'Kampagne 2023', t: 'kampagne', a: { took_place_in_year: '2023' } },
    X: { l: 'ohne Datum', t: 'x', a: { Inventarnummer: '998' } },
  } }
  let fails = 0
  const want = (d, got, exp) => {
    const ok = JSON.stringify(got) === JSON.stringify(exp)
    if (!ok) fails++
    line(`  ${ok ? 'OK ' : 'XX '} ${d} => ${JSON.stringify(got)}${ok ? '' : ' (want ' + JSON.stringify(exp) + ')'}`)
  }
  const opts = getTemporalOptions(g)
  line('  options: ' + opts.map(o => `${o.label}[${o.kind}](${o.count})`).join(' | '))
  want('hasTemporalData', hasTemporalData(g), true)
  want('default = "All dates"', opts[0]?.label, 'All dates')
  want('combined covers 3 dated nodes', opts[0]?.count, 3)
  want('start/finish span detected as pair dim', opts.some(o => o.kind === 'pair'), true)
  const all = buildTimelineEvents(g, opts[0])
  const byId = Object.fromEntries(all.map(e => [e.nodeId, e]))
  want('Grabung is a 2019-2024 span', [byId.Grabung?.start, byId.Grabung?.end, byId.Grabung?.isSpan], [2019, 2024, true])
  want('K22 is a 2022 point', [byId.K22?.start, byId.K22?.isSpan], [2022, false])
  want('node without dating excluded', 'X' in byId, false)
  line('  TIMELINE CHECKS: ' + (fails ? fails + ' FAILED' : 'all pass'))
  if (fails) process.exitCode = 1
}

// ---------------------------------------------------------------------------
H('7c. Timeline lanes (one row per value) + year-range filter')
{
  // The reported use case: finds dated per year, each sitting IN a
  // stratigraphic unit -- and "SE" is an EDGE, not an attribute, so a
  // grouping over attributes alone would miss exactly what is wanted here.
  // F5 sits in two units (must appear in both rows), F6 in none.
  const se = (id) => ({ l: id, t: 'se', a: {}, o: {}, i: { liegtIn: [] } })
  const g = { nodes: {
    'SE 2001': se('SE 2001'), 'SE 2002': se('SE 2002'),
    F1: { l: 'Fund 1', t: 'fund', a: { jahr: '1850', material: 'Bronze', invnr: 'A-1' }, o: { liegtIn: ['SE 2001'] }, i: {} },
    F2: { l: 'Fund 2', t: 'fund', a: { jahr: '1875', material: 'Eisen', invnr: 'A-2' }, o: { liegtIn: ['SE 2001'] }, i: {} },
    F3: { l: 'Fund 3', t: 'fund', a: { jahr: '1902', material: 'Bronze', invnr: 'A-3' }, o: { liegtIn: ['SE 2002'] }, i: {} },
    F4: { l: 'Fund 4', t: 'fund', a: { jahr: '1600/1650', invnr: 'A-4' }, o: { liegtIn: ['SE 2002'] }, i: {} }, // span
    F5: { l: 'Fund 5', t: 'fund', a: { jahr: '1880', material: 'Bronze', invnr: 'A-5' }, o: { liegtIn: ['SE 2001', 'SE 2002'] }, i: {} },
    F6: { l: 'Fund 6', t: 'fund', a: { jahr: '1890', material: 'Eisen', invnr: 'A-6' }, o: {}, i: {} }, // no unit
  } }
  for (const [id, nd] of Object.entries(g.nodes)) {
    for (const t of nd.o?.liegtIn || []) g.nodes[t].i.liegtIn.push(id)
  }
  const sch = deriveSchema({ node_types: { fund: 6, se: 2 }, edge_types: { liegtIn: 7 }, nodes: g.nodes })
  let fails = 0
  const want = (d, got, exp) => {
    const ok = JSON.stringify(got) === JSON.stringify(exp)
    if (!ok) fails++
    line(`  ${ok ? 'OK ' : 'XX '} ${d} => ${JSON.stringify(got)}${ok ? '' : ' (want ' + JSON.stringify(exp) + ')'}`)
  }
  const dim = getTemporalOptions(g).find(o => o.id === 'attr::jahr')
  const evs = buildTimelineEvents(g, dim)
  want('6 dated finds', evs.length, 6)

  const lopts = getLaneOptions(g, evs, sch)
  line('  Zeilen-Optionen: ' + lopts.map(o => `${o.label}[${o.kind}](${o.values ?? '-'})`).join(' | '))
  want('first option is "no grouping"', [lopts[0].id, lopts[0].kind], ['', 'none'])
  want('the SE EDGE is offered', lopts.some(o => o.kind === 'connection' && o.key === 'liegtIn'), true)
  want('material offered', lopts.some(o => o.id === 'a:material'), true)
  want('per-node id NOT offered', lopts.some(o => o.id === 'a:invnr'), false)
  want('node type NOT offered (all events are finds)', lopts.some(o => o.kind === 'type'), false)

  const bySe = lopts.find(o => o.key === 'liegtIn')
  const lanes = buildLanes(g, evs, bySe, 'label', sch)
  const shape = lanes.map(l => `${l.label}: ${l.events.map(e => e.label.replace('Fund ', 'F')).join(',')}`)
  line('  Zeilen: ' + shape.join(' | '))
  want('one row per unit + one for "no value"', lanes.length, 3)
  want('SE 2001 row, chronological', shape[0], 'SE 2001: F1,F2,F5')
  want('SE 2002 row, chronological (1600-1650, 1880, 1902)', shape[1], 'SE 2002: F4,F5,F3')
  want('a find in two units appears in both', lanes.filter(l => l.events.some(e => e.nodeId === 'F5')).length, 2)
  want('"(no value)" is last', lanes[2].label, '(no value)')
  // 6 finds, F5 placed in both its units, F6 in "(kein Wert)" -> 7 placements.
  want('every lane keeps all its events (stacking is the view\'s job)',
    lanes.reduce((n, l) => n + l.events.length, 0), 7)

  const first = (mode) => buildLanes(g, evs, bySe, mode, sch).map(l => l.label)
  want('sort by count puts the bigger unit first', first('count')[0], 'SE 2001')
  want('sort by time puts the earliest unit first', first('time')[0], 'SE 2002')
  want('no grouping -> a single row with everything', buildLanes(g, evs, lopts[0], 'label', sch).map(l => l.events.length), [6])

  const ids = (list) => list.map(e => e.nodeId).sort()
  want('von 1870 bis 1900 (inclusive year end)', ids(filterEventsByYear(evs, 1870, 1900)), ['F2', 'F5', 'F6'])
  want('open end: ab 1900', ids(filterEventsByYear(evs, 1900, null)), ['F3'])
  want('open start: bis 1860', ids(filterEventsByYear(evs, null, 1860)), ['F1', 'F4'])
  want('span 1600-1650 counted when window touches it', ids(filterEventsByYear(evs, 1640, 1700)), ['F4'])
  want('reversed bounds are swapped, not empty', ids(filterEventsByYear(evs, 1900, 1870)), ['F2', 'F5', 'F6'])
  want('no bounds -> untouched', filterEventsByYear(evs, null, null).length, 6)
  line('  LANE/FILTER CHECKS: ' + (fails ? fails + ' FAILED' : 'all pass'))
  if (fails) process.exitCode = 1
}

// ---------------------------------------------------------------------------
H('8. SCALE test on real 13 MB export')
const bigPath = path.join(__dirname, 'example-graph.json')
if (fs.existsSync(bigPath)) {
  let t = Date.now(); const real = JSON.parse(fs.readFileSync(bigPath, 'utf8')); line('parse: ' + (Date.now()-t) + 'ms nodes=' + Object.keys(real.nodes).length)
  const rs = deriveSchema(real)
  t = Date.now(); const hg = geo.hasGeoData(real); line('hasGeoData: ' + hg + ' in ' + (Date.now()-t) + 'ms')
  t = Date.now(); const attrs = geo.detectGeoAttributes(real); line('detectGeoAttributes: ' + attrs.length + ' in ' + (Date.now()-t) + 'ms')
  t = Date.now(); const tg2 = buildTypeGraph(real, rs); line('buildTypeGraph: ' + tg2.nodes.length + ' types, ' + tg2.edges.length + ' edges in ' + (Date.now()-t) + 'ms')
  t = Date.now(); const hd = harris.hasDotOneData(real); line('hasDotOneData: ' + hd + ' in ' + (Date.now()-t) + 'ms')
  const allIds = Object.keys(real.nodes)
  t = Date.now(); const dp = harris.detectDotOneProperties(real, allIds); line('detectDotOneProperties(all): ' + JSON.stringify(dp) + ' in ' + (Date.now()-t) + 'ms')
  if (dp.length) { t = Date.now(); const seq = harris.buildSequence(real, allIds, dp[0]); line('buildSequence(all,'+dp[0].slice(-20)+'): rank='+seq.rankEdges.length+' in '+(Date.now()-t)+'ms') }
  // map search index over all geo-bearing nodes (the known OOM-risk path)
  const geoIds = [...new Set(attrs.map(a=>a.nodeId))]
  t = Date.now(); const idx = geo.buildMapSearchIndex(real, geoIds, 2); line('buildMapSearchIndex('+geoIds.length+' geo nodes, radius 2): ' + idx.size + ' entries in ' + (Date.now()-t) + 'ms')
  // reproject everything with a plausible EPSG (31256 -> not in table; try 4326 fallback)
  t = Date.now(); const gf = geo.buildGeoFeatures(real, '31287'); line('buildGeoFeatures(31287): ' + (gf?gf.features.length+' features, '+gf.failedCount+' failed':'null') + ' in ' + (Date.now()-t) + 'ms')
} else { line('real export not found, skipping scale test') }

console.log('\n[done]')
