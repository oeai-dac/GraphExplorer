// run-chart-data-check.mjs
//
// Tests the Charts tab's data layer (src/lib/chartData.js): the merged
// property list with coverage, date bucketing, sort modes, grouping,
// cross-tabulation and the drill-down conditions that turn a clicked
// category back into an Explorer filter.
//
// Usage: node run-chart-data-check.mjs

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

const C = await import(L('chartData.js'))
const { applyConditions } = await import(L('filters.js'))

const H = (s) => console.log('\n===== ' + s + ' =====')
let failed = 0
function check(label, cond, extra = '') {
  if (!cond) failed++
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}${extra ? '  ' + extra : ''}`)
}

// Finds with a material link, a date literal and an inventory number that
// looks like a year but must NOT be treated as one.
const graph = {
  nodes: {
    F1: { l: 'Fund 1', t: 'Fund', a: { datierung: '1985-06-01', invnr: '1750' }, o: { MATERIAL: ['M_bronze'] }, i: {} },
    F2: { l: 'Fund 2', t: 'Fund', a: { datierung: '1987', invnr: '1751' }, o: { MATERIAL: ['M_bronze'] }, i: {} },
    F3: { l: 'Fund 3', t: 'Fund', a: { datierung: '1992-03-11', invnr: '1752' }, o: { MATERIAL: ['M_eisen'] }, i: {} },
    F4: { l: 'Fund 4', t: 'Fund', a: { invnr: '1753' }, o: { MATERIAL: ['M_bronze', 'M_eisen'] }, i: {} },
    M_bronze: { l: 'Bronze', t: 'Material', a: {}, o: {}, i: { MATERIAL: ['F1', 'F2', 'F4'] } },
    M_eisen: { l: 'Eisen', t: 'Material', a: {}, o: {}, i: { MATERIAL: ['F3', 'F4'] } },
  },
}
const funde = ['F1', 'F2', 'F3', 'F4']

// ── the merged property list ────────────────────────────────────────────────
H('Property-Liste (Verbindungen und Werte in einer Liste)')
const props = C.listChartProperties(graph, funde, null)
check('Verbindungen und Attribute stehen gemeinsam in der Liste',
  props.some((p) => p.kind === 'connection') && props.some((p) => p.kind === 'attr'),
  props.map((p) => `${p.kind}:${p.label}(${p.coverage})`).join(' '))
check('kein "Typ" mehr als Dimension', props.every((p) => p.kind !== 'type'))
check('nach Abdeckung sortiert', props[0].coverage >= props[props.length - 1].coverage)

const byId = Object.fromEntries(props.map((p) => [p.id, p]))
check('Abdeckung einer Verbindung', byId['c:MATERIAL'].coverage === 4)
check('Abdeckung eines Attributs zaehlt nur gesetzte Werte', byId['a:datierung'].coverage === 3,
  String(byId['a:datierung'].coverage))
check('Datumsproperty erkannt', byId['a:datierung'].temporal === true)
check('Inventarnummer NICHT als Datum erkannt', byId['a:invnr'].temporal === false,
  '(sonst bekaeme jedes Zahlenfeld eine Jahrhundert-Auswahl)')
check('Verbindung nie datumsartig', byId['c:MATERIAL'].temporal === false)
check('Property-IDs trennen Verbindung und Attribut gleichen Namens',
  C.listChartProperties(
    { nodes: { X: { l: 'X', t: 'T', a: { gleich: 'v' }, o: { gleich: ['X'] }, i: {} } } }, ['X'], null
  ).length === 2,
  '(im echten CIDOC-Export gibt es "P3 has note" als beides)')
check('Anzahl verschiedener Werte je Property', byId['c:MATERIAL'].distinct === 2 && byId['a:invnr'].distinct === 4,
  `${byId['c:MATERIAL'].distinct}/${byId['a:invnr'].distinct}`)

// A property with one value per node charts as a wall of 1-high bars. It must
// sink below the ones that actually group.
const wide = { nodes: {} }
for (let i = 0; i < 50; i++) {
  wide.nodes['N' + i] = { l: 'N' + i, t: 'T', a: { geom: `POINT(${i} ${i})`, phase: i % 3 ? 'A' : 'B' }, o: {}, i: {} }
}
const wideProps = C.listChartProperties(wide, Object.keys(wide.nodes), null)
check('Property mit einem eigenen Wert je Knoten wird als schlecht gruppierbar erkannt',
  wideProps.find((p) => p.key === 'geom').poorGrouping === true)
check('gut gruppierende Property trotz kleinerer Abdeckung nicht',
  wideProps.find((p) => p.key === 'phase').poorGrouping === false)
check('und steht in der Liste vorn', wideProps[0].key === 'phase',
  wideProps.map((p) => p.key).join(' '))

// ── grouping by a connection ────────────────────────────────────────────────
H('Gruppieren nach Verbindung')
const matDim = C.dimForProperty(byId['c:MATERIAL'])
const mat = C.groupAndCount(graph, funde, matDim)
check('nach Label des verknuepften Knotens gruppiert',
  mat.map((b) => `${b.label}=${b.count}`).join(' ') === 'Bronze=3 Eisen=2',
  mat.map((b) => `${b.label}=${b.count}`).join(' '))
check('mehrwertiger Knoten zaehlt in jeder Kategorie',
  mat.find((b) => b.label === 'Bronze').ids.includes('F4') && mat.find((b) => b.label === 'Eisen').ids.includes('F4'))

// ── date bucketing ──────────────────────────────────────────────────────────
H('Datumsgruppierung')
const raw = C.groupAndCount(graph, funde, C.dimForProperty(byId['a:datierung'], ''))
check('ohne Auflösung: ein Balken je Schreibweise', raw.filter((b) => b.label !== C.NO_VALUE).length === 3,
  '(genau das Problem, das die Auflösung loest)')

const dec = C.groupAndCount(graph, funde, C.dimForProperty(byId['a:datierung'], 'decade'))
const decLabels = dec.map((b) => `${b.label}=${b.count}`).join(' ')
check('Jahrzehnt fasst 1985 und 1987 zusammen', decLabels.includes('1980–1989=2'), decLabels)
check('1992 bekommt ein eigenes Jahrzehnt', decLabels.includes('1990–1999=1'))
check('Knoten ohne Datum landen in "(kein Wert)"',
  dec.find((b) => b.label === C.NO_VALUE)?.count === 1)

const cen = C.groupAndCount(graph, funde, C.dimForProperty(byId['a:datierung'], 'century'))
check('Jahrhundert fasst alle drei zusammen',
  cen.find((b) => b.label === '1900–1999')?.count === 3,
  cen.map((b) => b.label).join(' '))

check('Standardauflösung ist Jahrzehnt', C.DEFAULT_DATE_BUCKET === 'decade')
check('Auflösung greift nur bei Datumsproperties',
  C.dimForProperty(byId['a:invnr'], 'decade').bucket === '',
  '(sonst wuerden Inventarnummern zu Jahrzehnten verrechnet)')

// v. Chr. must bucket downwards, not towards zero.
const bc = { nodes: { A: { l: 'A', t: 'T', a: { datierung: '-1985' }, o: {}, i: {} } } }
const bcProp = C.listChartProperties(bc, ['A'], null).find((p) => p.key === 'datierung')
const bcBucket = C.groupAndCount(bc, ['A'], C.dimForProperty(bcProp, 'decade'))[0]
check('negative Jahre werden abwaerts gerundet', bcBucket.label === '1990 BCE–1981 BCE', bcBucket.label)

// ── sorting ─────────────────────────────────────────────────────────────────
H('Sortierung')
const byCount = C.groupAndCount(graph, funde, matDim, { sort: 'count' })
check('nach Anzahl absteigend', byCount[0].label === 'Bronze')

const decByLabel = C.groupAndCount(graph, funde, C.dimForProperty(byId['a:datierung'], 'decade'), { sort: 'label' })
check('Datum nach Bezeichnung laeuft chronologisch',
  decByLabel[0].label === '1980–1989' && decByLabel[1].label === '1990–1999',
  decByLabel.map((b) => b.label).join(' '))
check('"(kein Wert)" steht immer am Ende', decByLabel[decByLabel.length - 1].label === C.NO_VALUE)

const natural = C.sortBuckets(
  [{ label: 'SE 10', count: 1 }, { label: 'SE 2', count: 1 }, { label: 'SE 1', count: 1 }], 'label'
).map((r) => r.label).join(' ')
check('Bezeichnungen natuerlich sortiert', natural === 'SE 1 SE 2 SE 10', natural)

// ── pivot ───────────────────────────────────────────────────────────────────
H('Pivot-Tabelle')
const pv = C.pivotCount(graph, funde, matDim, C.dimForProperty(byId['a:datierung'], 'decade'))
check('Zeilen sind die Materialien', pv.rowLabels.join(' ') === 'Bronze Eisen', pv.rowLabels.join(' '))
check('Zelle Bronze × 1980er', pv.getCell('Bronze', '1980–1989') === 2)
check('Zeilensumme zaehlt Knoten einmal', pv.rowTotal('Bronze') === 3)
check('Gesamtsumme ist die Knotenzahl', pv.grandTotal === 4)
check('Zell-IDs abrufbar', pv.getCellIds('Bronze', '1980–1989').sort().join(',') === 'F1,F2')

// ── drill-down: a clicked category must reproduce exactly its own nodes ─────
H('Klick auf eine Kategorie filtert exakt dieselben Knoten')
for (const bucket of mat) {
  const cond = C.conditionForCategory(graph, matDim, bucket.label, bucket.ids)
  const got = applyConditions(graph, funde, [cond]).sort().join(',')
  check(`Verbindung "${bucket.label}"`, got === bucket.ids.slice().sort().join(','), got)
}

const decDim = C.dimForProperty(byId['a:datierung'], 'decade')
for (const bucket of dec.filter((b) => b.label !== C.NO_VALUE)) {
  const cond = C.conditionForCategory(graph, decDim, bucket.label, bucket.ids)
  const got = applyConditions(graph, funde, [cond]).sort().join(',')
  check(`Datumsgruppe "${bucket.label}" trifft genau ihre Knoten`, got === bucket.ids.slice().sort().join(','),
    got + ' (' + cond.op + ')')
}
check('Datumsgruppe filtert ueber die konkreten Werte, nicht ueber einen Bereich',
  C.conditionForCategory(graph, decDim, '1980–1989', ['F1', 'F2']).op === 'in',
  '(Rohwerte sind beliebig geschrieben, ein Bereichsvergleich waere still falsch)')
check('"(kein Wert)" liefert keine Bedingung',
  C.conditionForCategory(graph, decDim, C.NO_VALUE, ['F4']) === null)

// ── category colors (Harris-Matrix: "Einfaerben nach ...") ──────────────────
H('Kategorienfarben')
{
  const { legend, colorOf } = C.assignCategoryColors(mat)
  const bronze = legend.find((l) => l.label === 'Bronze')
  const eisen = legend.find((l) => l.label === 'Eisen')
  check('jede Kategorie bekommt eine eigene Farbe', bronze.color !== eisen.color, `${bronze.color} / ${eisen.color}`)
  check('Knoten erben die Farbe ihrer Kategorie', colorOf('F1') === bronze.color && colorOf('F3') === eisen.color)
  check('mehrwertiger Knoten nimmt die Farbe seiner GROESSTEN Kategorie',
    colorOf('F4') === bronze.color, '(F4 ist Bronze UND Eisen, Bronze ist die groessere Gruppe)')
  check('unbekannte ID faellt auf die neutrale Farbe zurueck',
    colorOf('gibtsnicht') === C.NEUTRAL_CATEGORY_COLOR)

  // "(kein Wert)" is not a category -- it must not eat a palette color.
  const withEmpty = C.assignCategoryColors(C.groupAndCount(graph, funde, C.dimForProperty(byId['a:datierung'], '')))
  const none = withEmpty.legend.find((l) => l.label === C.NO_VALUE)
  check('"(kein Wert)" bleibt neutral', none.plain && none.color === C.NEUTRAL_CATEGORY_COLOR)
  check('und verbraucht keine Palettenfarbe',
    new Set(withEmpty.legend.filter((l) => !l.plain).map((l) => l.color)).size ===
      withEmpty.legend.filter((l) => !l.plain).length)

  // Past the palette, colors would start repeating -- those categories are
  // marked instead, so the legend can say "uebrige" rather than lie.
  const many = Array.from({ length: 30 }, (_, i) => ({ label: 'K' + i, count: 30 - i, ids: ['n' + i] }))
  const big = C.assignCategoryColors(many)
  const colored = big.legend.filter((l) => !l.plain)
  check('nur so viele Kategorien wie Farben bekommen eine eigene', colored.length < many.length, `${colored.length} von ${many.length}`)
  check('keine Farbe wird doppelt vergeben', new Set(colored.map((l) => l.color)).size === colored.length)
  check('der Rest ist neutral', big.legend.filter((l) => l.plain).every((l) => l.color === C.NEUTRAL_CATEGORY_COLOR))
  check('plainCount zaehlt Knoten, nicht Kategoriezugehoerigkeiten',
    big.plainCount === many.length - colored.length, String(big.plainCount))

  // Mehrwertige Knoten: die Summe der grauen Kategorien waere groesser als
  // die Knotenzahl -- gezaehlt werden muessen die tatsaechlich grauen Knoten.
  const multi = [
    { label: 'gross', count: 2, ids: ['a', 'b'] },
    ...Array.from({ length: 25 }, (_, i) => ({ label: 'T' + i, count: 2, ids: ['a', 'b'] })),
  ]
  const m = C.assignCategoryColors(multi)
  check('mehrwertige Knoten werden nur einmal als "uebrige" gezaehlt',
    m.plainCount === 0, `${m.plainCount} (a und b haben bereits eine Farbe)`)
}

// ── real dataset ────────────────────────────────────────────────────────────
H('echter Datensatz')
const trigPath = path.join(__dirname, 'example-rdf.trig')
if (!fs.existsSync(trigPath)) {
  console.log('(example-rdf.trig nicht vorhanden - uebersprungen)')
} else {
  const { rdfTextToGraph } = await import(L('rdfImport.js'))
  const g = rdfTextToGraph(fs.readFileSync(trigPath, 'utf8'), 'trig')
  const ids = Object.keys(g.nodes)
  let t = Date.now()
  const list = C.listChartProperties(g, ids, g.schema)
  console.log(`${list.length} Properties aus ${ids.length} Knoten in ${Date.now() - t}ms`)
  check('Properties gefunden', list.length > 0)
  check('Abdeckung nie groesser als die Knotenzahl', list.every((p) => p.coverage > 0 && p.coverage <= ids.length))
  console.log('  Top 5:', list.slice(0, 5).map((p) => `${p.label}(${p.coverage}${p.temporal ? ', Datum' : ''})`).join(' · '))

  // Every property must group without throwing, and the drill-down for the
  // biggest category must reproduce that category exactly.
  t = Date.now()
  let mismatches = 0
  for (const p of list.slice(0, 25)) {
    const dim = C.dimForProperty(p, C.DEFAULT_DATE_BUCKET)
    const rows = C.groupAndCount(g, ids, dim)
    const top = rows.find((r) => r.label !== C.NO_VALUE)
    if (!top) continue
    const cond = C.conditionForCategory(g, dim, top.label, top.ids)
    if (!cond) { mismatches++; continue }
    const got = applyConditions(g, ids, [cond])
    if (got.length !== top.ids.length) mismatches++
  }
  console.log(`25 Properties gruppiert und geprueft in ${Date.now() - t}ms`)
  check('Klick-Filter trifft ueberall genau die gezaehlten Knoten', mismatches === 0, String(mismatches))
}

console.log(failed ? `\n[${failed} FEHLGESCHLAGEN]` : '\n[done]')
process.exit(failed ? 1 : 0)
