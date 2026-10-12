// run-scene3d-check.mjs
//
// Checks the data side of the 3D tab (src/lib/scene3d.js) and the Z support
// it needs from src/lib/wkt.js: heights survive parsing, degrees end up in
// metres, OBJ object names find their nodes -- and the map's 2D path stays
// exactly as it was.
//
// Usage: node run-scene3d-check.mjs

import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { register } from 'node:module'

// Same resolve hook as run-lib-checks.mjs: the lib files use Vite-style
// extensionless relative imports.
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

const { parseWkt } = await import(L('wkt.js'))
const { buildScene3dFeatures, featureBounds3d, buildNameIndex, matchObjectName, parseOriginHint, utmZoneFor } = await import(L('scene3d.js'))

const H = (s) => console.log('\n===== ' + s + ' =====')
let failed = 0
function check(label, cond, extra = '') {
  if (!cond) failed++
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}${extra ? '  ' + extra : ''}`)
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

H('WKT: the map path keeps getting [x, y]')
check('POINT Z without keepZ', same(parseWkt('POINT Z (1 2 3)').coordinates, [1, 2]))
check('POLYGON Z without keepZ', same(parseWkt('POLYGON Z ((0 0 1, 1 0 1, 1 1 1, 0 0 1))').coordinates[0][1], [1, 0]))

H('WKT: keepZ')
check('POINT Z', same(parseWkt('POINT Z (1 2 3)', { keepZ: true }).coordinates, [1, 2, 3]))
check('lower-case marker', same(parseWkt('Point z (1 2 3)', { keepZ: true }).coordinates, [1, 2, 3]))
check('no marker, three numbers', same(parseWkt('POINT (1 2 3)', { keepZ: true }).coordinates, [1, 2, 3]))
check('ZM keeps Z, drops M', same(parseWkt('POINT ZM (1 2 3 4)', { keepZ: true }).coordinates, [1, 2, 3]))
check('M alone is not a height', same(parseWkt('POINT M (1 2 3)', { keepZ: true }).coordinates, [1, 2]))
check('2D stays 2D', same(parseWkt('POINT (1 2)', { keepZ: true }).coordinates, [1, 2]))
check('MULTIPOLYGON Z', same(parseWkt('MULTIPOLYGON Z (((0 0 5, 1 0 5, 1 1 6, 0 0 5)))', { keepZ: true }).coordinates[0][0][2], [1, 1, 6]))
check('MULTIPOINT Z, both spellings',
  same(parseWkt('MULTIPOINT Z ((1 2 3), (4 5 6))', { keepZ: true }).coordinates, [[1, 2, 3], [4, 5, 6]]) &&
  same(parseWkt('MULTIPOINT Z (1 2 3, 4 5 6)', { keepZ: true }).coordinates, [[1, 2, 3], [4, 5, 6]]))

H('UTM zone')
check('Vienna -> 33N', utmZoneFor(16.41, 48.2).label === 'EPSG:32633')
check('southern hemisphere', utmZoneFor(-58.4, -34.6).label === 'EPSG:32721')

H('buildScene3dFeatures')
const g = {
  nodes: {
    a: { l: 'Find 1', t: 'Find', a: { pos: 'POINT Z (16.4160605 48.2030286 156.63)' } },
    b: { l: 'Find 2', t: 'Find', a: { pos: 'POINT (16.4160605 48.2030286)' } },
    c: { l: 'Plan', t: 'Plan', a: { geom: 'POLYGON Z ((16.416 48.203 156, 16.4161 48.203 156, 16.4161 48.2031 156.2, 16.416 48.203 156))' } },
    d: { l: 'Broken', t: 'Plan', a: { geom: 'POINT Z (abc def ghi)' } },
  },
}
const r = buildScene3dFeatures(g, '4326')
check('degrees go to UTM 33N', r.frame === 'EPSG:32633', r.frame)
check('two geometries with height', r.features.length === 2, String(r.features.length))
check('one flat geometry counted, not shown', r.flatCount === 1)
check('garbage counted as failed, not NaN', r.failedCount === 1 && !JSON.stringify(r.features).includes('null'))
const pt = r.features.find((f) => f.nodeId === 'a').coordinates
// The example OBJ puts its origin at E 605211 / N 5339827 (make_example.py).
check('easting in metres', pt[0] > 605200 && pt[0] < 605260, pt[0].toFixed(2))
check('northing in metres', pt[1] > 5339800 && pt[1] < 5339880, pt[1].toFixed(2))
check('height untouched', pt[2] === 156.63)
const b = featureBounds3d(r.features)
check('bounds span the heights', b[0][2] === 156 && b[1][2] === 156.63)
const proj = buildScene3dFeatures({ nodes: { x: { l: 'x', t: 'T', a: { p: 'POINT Z (605211 5339827 150)' } } } }, '32633')
check('projected CRS is kept as is', proj.frame === 'EPSG:32633' && same(proj.features[0].coordinates, [605211, 5339827, 150]))
check('unknown EPSG -> null', buildScene3dFeatures(g, '99999') === null)

H('OBJ names -> nodes')
const idx = buildNameIndex({
  nodes: {
    n1: { l: 'SU1001', t: 'SU' },
    n2: { l: 'TSP-1011-02', t: 'Find' },
    n3: { l: 'SE  2004', t: 'SU' },
    n4: { l: 'Twin', t: 'SU' },
    n5: { l: 'Twin', t: 'SU' },
  },
})
check('exact label', matchObjectName(idx, 'SU1001')?.nodeId === 'n1')
check('case and spaces do not count', matchObjectName(idx, 'se 2004')?.nodeId === 'n3')
check('Blender duplicate suffix', matchObjectName(idx, 'SU1001.001')?.nodeId === 'n1')
check('node id as fallback', matchObjectName(idx, 'n2')?.nodeId === 'n2')
check('shared label is flagged', matchObjectName(idx, 'Twin')?.ambiguous === true)
check('unknown name', matchObjectName(idx, 'Nothing') === null)
check('empty name', matchObjectName(idx, '') === null)

H('OBJ header origin')
const header = fs.readFileSync(path.join(ROOT, '0_exampleData/GraphExplorer_Example.obj'), 'utf8').slice(0, 2000)
check('example header', same(parseOriginHint(header), { e: 605211, n: 5339827 }), JSON.stringify(parseOriginHint(header)))
check('only E is not enough', parseOriginHint('# origin E 605211\nv 0 0 0') === null)
check('comments after the data are ignored', parseOriginHint('v 0 0 0\n# E 1 N 2') === null)
check('Blender header has none', parseOriginHint('# Blender 4.2.0\n# www.blender.org\nmtllib x.mtl\no Cube') === null)

H('Example data: every OBJ object finds its node')
const exGraph = JSON.parse(fs.readFileSync(path.join(ROOT, '0_exampleData/GraphExplorer_Example.json'), 'utf8'))
const exIdx = buildNameIndex(exGraph)
const names = [...fs.readFileSync(path.join(ROOT, '0_exampleData/GraphExplorer_Example.obj'), 'utf8').matchAll(/^o (.+)$/gm)].map((m) => m[1].trim())
const missing = names.filter((n) => !matchObjectName(exIdx, n))
check(`${names.length} objects, all linked`, names.length > 0 && !missing.length, missing.slice(0, 5).join(', '))
const ex = buildScene3dFeatures(exGraph, '4326')
check('example WKT lands in UTM 33N', ex.frame === 'EPSG:32633', `${ex.features.length} with height, ${ex.flatCount} flat, ${ex.failedCount} failed`)

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed')
process.exit(failed ? 1 : 0)
