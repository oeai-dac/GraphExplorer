// run-tile-depth-check.mjs
//
// Prueft die Regel aus src/lib/tileDepth.js: bis zu welcher Zoomstufe ein
// selbst erzeugtes Kachelraster als vorhanden gilt.
//
// Warum als eigenes Skript und nicht im Browser: die Regel entscheidet ueber
// den Unterschied zwischen "unscharf" und "leer" auf der Karte, und beide
// Fehlrichtungen faellt man erst weit hineingezoomt auf -- also genau dort, wo
// es beim Testen von Hand am unbequemsten ist.
//
// Usage: node run-tile-depth-check.mjs

import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../')
const L = (p) => pathToFileURL(path.join(ROOT, 'src/lib', p)).href

const { nextTileDepth } = await import(L('tileDepth.js'))

const H = (s) => console.log('\n===== ' + s + ' =====')
let failed = 0
function check(label, cond, extra = '') {
  if (!cond) failed++
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}${extra ? '  ' + extra : ''}`)
}

const MAX = 24

H('Pyramide endet -- Leaflet soll ab da vergroessern statt leer zu bleiben')
check(
  'Fehler auf 23 bei Kacheln bis 22 setzt die Tiefe auf 22',
  nextTileDepth({ current: MAX, errorZoom: 23, loadedZooms: new Set([18, 19, 20, 21, 22]) }) === 22,
)
check(
  'auch wenn der Fehler mehrere Stufen tiefer liegt',
  nextTileDepth({ current: MAX, errorZoom: 24, loadedZooms: new Set([16]) }) === 16,
)
check(
  'eine bereits erkannte Tiefe wird nie wieder angehoben',
  nextTileDepth({ current: 18, errorZoom: 23, loadedZooms: new Set([20, 22]) }) === 18,
)

H('Loecher am Rand des abgedeckten Gebiets duerfen nichts ausloesen')
check(
  'Fehler auf derselben Stufe, auf der Kacheln sitzen, aendert nichts',
  nextTileDepth({ current: MAX, errorZoom: 20, loadedZooms: new Set([19, 20]) }) === MAX,
)
check(
  'Fehler auf einer groeberen Stufe als die geladene aendert nichts',
  nextTileDepth({ current: MAX, errorZoom: 12, loadedZooms: new Set([19, 20]) }) === MAX,
)

H('Solange nichts geladen ist, wird nichts geschlossen')
check(
  'ohne jede geladene Kachel bleibt die Tiefe unangetastet',
  nextTileDepth({ current: MAX, errorZoom: 19, loadedZooms: new Set() }) === MAX,
  '(sonst liefe ein Raster, das erst tiefer beginnt, endgueltig ins Leere)',
)
check(
  'das gilt auch nach mehreren Fehlschlaegen hintereinander',
  [21, 20, 19, 18].reduce(
    (cur, z) => nextTileDepth({ current: cur, errorZoom: z, loadedZooms: new Set() }),
    MAX,
  ) === MAX,
)

H('Unbrauchbare Eingaben')
check(
  'ohne Stufenangabe im Ereignis bleibt alles wie es war',
  nextTileDepth({ current: MAX, errorZoom: undefined, loadedZooms: new Set([20]) }) === MAX,
)
check(
  'ein Array statt eines Sets wird ebenso akzeptiert',
  nextTileDepth({ current: MAX, errorZoom: 23, loadedZooms: [20, 22] }) === 22,
)

H('Zusammenspiel: erst blind, dann belegt, dann zu tief')
{
  let depth = MAX
  const loaded = new Set()
  // Startansicht liegt ueber dem Raster: noch nichts geladen, nichts aendern
  depth = nextTileDepth({ current: depth, errorZoom: 19, loadedZooms: loaded })
  check('Schritt 1 -- Startansicht ohne Treffer laesst die Tiefe offen', depth === MAX)
  // Nutzer zoomt heraus, Kacheln kommen an
  loaded.add(17)
  loaded.add(16)
  depth = nextTileDepth({ current: depth, errorZoom: 18, loadedZooms: loaded })
  check('Schritt 2 -- nach dem ersten Treffer wird die Tiefe auf 17 festgezurrt', depth === 17)
  // Wieder hineingezoomt: ab hier vergroessert Leaflet
  depth = nextTileDepth({ current: depth, errorZoom: 22, loadedZooms: loaded })
  check('Schritt 3 -- tieferes Hineinzoomen aendert daran nichts mehr', depth === 17)
}

console.log(failed ? `\n[${failed} FEHLGESCHLAGEN]` : '\n[done]')
process.exit(failed ? 1 : 0)
