// Baut den GraphExplorer in eine einzige, in sich geschlossene HTML-Datei.
//
// Wozu: Kolleg:innen sollen die App testen koennen, ohne Node.js oder npm zu
// installieren und ohne dass irgendwo ein Server laeuft -- eine Datei per Mail
// oder Netzlaufwerk, Doppelklick, fertig.
//
// Warum das ueberhaupt geht: Der normale Vite-Build erzeugt genau drei Dateien
// (index.html + ein JS + ein CSS) und keinen einzigen Verweis auf weitere
// Dateien -- Leaflets Marker-Grafiken liegen bereits als Data-URI im CSS, und
// der Bundle enthaelt keine dynamischen Imports und keine Worker. Also laesst
// sich alles direkt in die HTML-Datei inlinen.
//
// Der eine Kniff: Das JS wird als klassisches <script> eingebettet, nicht als
// <script type="module">. Module wuerden beim Oeffnen ueber file:// an der
// CORS-Pruefung des Browsers scheitern. Der Bundle enthaelt ohnehin keine
// Modul-Syntax (kein import/export, kein import.meta), ist also als klassisches
// Script gueltig -- die Pruefung unten stellt sicher, dass das so bleibt.
//
// Dabei ist ein Unterschied wichtig: <script type="module"> wird vom Browser
// automatisch deferred und laeuft erst, wenn das DOM fertig geparst ist. Ein
// klassisches <script> im <head> laeuft sofort -- also bevor es <div id="root">
// im Body gibt, und createRoot(null) wirft. Ein "defer"-Attribut hilft nicht,
// weil es bei Inline-Scripts ignoriert wird. Darum wird der Bundle unten in
// DOMContentLoaded gehaengt, was die Defer-Semantik von Modulen nachbildet.
//
// Wie die App fragt auch diese Datei beim Öffnen nach dem Koordinatensystem
// der Geometrien. Geht sie mit einem bekannten Datensatz hinaus, laesst sich
// die Antwort mit --epsg vorbelegen. Aendern laesst sich die Vorgabe auch in
// der fertigen Datei jederzeit ueber "EPSG ... ändern".
//
// Aufruf:   npm run build:standalone                    (nachfragen)
//           npm run build:standalone -- --epsg 32635    (vorbelegt, z.B. UTM 35N)
// Ergebnis: GraphExplorer-standalone.html im Projektordner

import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outFile = join(projectRoot, 'GraphExplorer-standalone.html')
const buildDir = mkdtempSync(join(tmpdir(), 'graphexplorer-standalone-'))

function parseEpsgArg(argv) {
  const i = argv.indexOf('--epsg')
  if (i === -1) return null
  const value = (argv[i + 1] || '').trim()
  if (!value || value.startsWith('--')) {
    throw new Error('--epsg needs a value, e.g. "--epsg 32635" or "--epsg none".')
  }
  if (value.toLowerCase() === 'none') return null
  // Erlaubt sind ein EPSG-Code (mit oder ohne Praefix) und eine rohe
  // proj4-Zeile -- genau das, was der Dialog im Karten-Tab auch annimmt.
  if (!/^(EPSG:)?\d{4,6}$/i.test(value) && !value.startsWith('+proj=')) {
    throw new Error(
      `"${value}" does not look like an EPSG code (e.g. 32635) or a ` +
        'proj4 definition (starting with "+proj=").',
    )
  }
  return value
}

const epsg = parseEpsgArg(process.argv.slice(2))

try {
  console.log('\n  [1/3] Vite build ...\n')
  execSync(`npx vite build --base=./ --outDir "${buildDir}" --emptyOutDir`, {
    cwd: projectRoot,
    stdio: 'inherit',
  })

  console.log('\n  [2/3] Inlining JS and CSS ...')
  let html = readFileSync(join(buildDir, 'index.html'), 'utf8')

  // Muss vor dem Bundle stehen: der Store liest die Vorgabe beim Initialisieren.
  if (epsg) {
    const before = html
    // Ersetzungs-*Funktion*, nicht -String: in einem String waeren "$&", "$'"
    // und Co. Platzhalter, die der eingesetzte Text ungewollt ausloesen kann.
    html = html.replace(
      /<head>/i,
      () => `<head>\n  <script>window.__GRAPH_EXPLORER_EPSG__ = ${JSON.stringify(epsg)};</script>`,
    )
    if (html === before) throw new Error('No <head> found -- EPSG preset not set.')
  }

  const readAsset = (ref) => readFileSync(join(buildDir, ref.replace(/^\.?\//, '')), 'utf8')

  // Enthielte der Bundle je die Zeichenfolge "</script", wuerde sie das
  // umgebende Tag vorzeitig schliessen. In JS ist "<\/" damit identisch.
  const escapeClosingTag = (js) => js.replace(/<\/script/gi, '<\\/script')

  const inlined = []

  html = html
    // Preload-Hinweise auf Dateien, die es nach dem Inlinen nicht mehr gibt
    .replace(/\s*<link\b[^>]*\brel="modulepreload"[^>]*>/gi, '')
    .replace(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/gi, (tag, src) => {
      if (/^https?:/i.test(src)) return tag
      const js = readAsset(src)
      // Exakte Probe, ob der Bundle als klassisches Script gueltig ist:
      // new Function() kompiliert den Code, ohne ihn auszufuehren, und wirft
      // bei ESM-Syntax (import/export) einen SyntaxError. Zuverlaessiger als
      // ein Regex, der auch in Strings wie "RDF import (...)" anschlaegt.
      try {
        new Function(`'use strict';${js}`)
      } catch (err) {
        throw new Error(
          `${src} does not run as a classic <script> (${err.message}). ` +
            'This path then needs an iife build via build.rollupOptions.output.format.',
        )
      }
      inlined.push(src)
      // Bildet die beiden Eigenschaften nach, die der Bundle von einem Modul
      // erwartet: strict mode (inkl. "this === undefined" oben) und
      // Ausfuehrung erst, wenn das DOM steht.
      return (
        `<script>\n(function(){'use strict';\nfunction __startGraphExplorer(){\n` +
        escapeClosingTag(js) +
        `\n}\nif (document.readyState === 'loading') {\n` +
        `  document.addEventListener('DOMContentLoaded', __startGraphExplorer);\n` +
        `} else {\n  __startGraphExplorer();\n}\n})();\n</script>`
      )
    })
    .replace(/<link\b[^>]*\brel="stylesheet"[^>]*>/gi, (tag) => {
      const href = tag.match(/\bhref="([^"]+)"/i)?.[1]
      if (!href || /^https?:/i.test(href)) return tag // Google Fonts bleiben extern
      inlined.push(href)
      return `<style>\n${readAsset(href)}\n</style>`
    })

  // Strukturelle Gegenprobe: jede Datei, die der Build erzeugt hat, muss
  // entweder die HTML-Huelle selbst oder eingebettet worden sein. Faengt
  // Code-Splitting und nicht inlinebare Assets, ohne im Minifikat zu raten.
  const listFiles = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? listFiles(join(dir, e.name)) : [join(dir, e.name)],
    )
  const normalise = (p) => p.replace(/^\.?\//, '').replace(/\\/g, '/')
  const embedded = new Set(inlined.map(normalise))
  const missed = listFiles(buildDir)
    .map((f) => normalise(relative(buildDir, f)))
    .filter((f) => f !== 'index.html' && !embedded.has(f))
  if (missed.length) {
    throw new Error(
      'The build produces files that were not embedded: ' +
        missed.join(', ') +
        '. A single HTML file would no longer be complete.',
    )
  }

  // Gegenprobe: ausserhalb von <script>/<style> darf kein Verweis auf eine
  // lokale Datei uebrig sein, sonst ist die HTML-Datei nicht eigenstaendig.
  const shell = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '<script/>')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '<style/>')
  const leftover = shell.match(/\b(?:src|href)="(?!https?:|data:|#)[^"]*"/gi)
  if (leftover) {
    throw new Error('References to external files left: ' + leftover.join(', '))
  }

  writeFileSync(outFile, html, 'utf8')
  const mb = (Buffer.byteLength(html, 'utf8') / 1024 / 1024).toFixed(2)
  console.log(
    `\n  [3/3] Done: GraphExplorer-standalone.html (${mb} MB)` +
      `\n        Coordinate system: ${epsg ? epsg + ' (preset)' : 'asked when the map is opened'}\n`,
  )
} finally {
  rmSync(buildDir, { recursive: true, force: true })
}
