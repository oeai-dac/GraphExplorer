import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Die Beispieldaten für die Web-Fassung. Sie liegen im Repo unter 0_exampleData
// und werden nur im Pages-Build als eigene Datei neben index.html gelegt --
// in der Standalone-Datei und im lokalen Build haben sie nichts verloren.
function exampleData() {
  return {
    name: 'graph-explorer-example-data',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'example/GraphExplorer_Example.json',
        source: readFileSync(new URL('./0_exampleData/GraphExplorer_Example.json', import.meta.url)),
      })
    },
  }
}

// Separate dev port from OntoCartographer Studio (3000) so both can run
// side by side. No backend proxy yet -- the Explorer is read-only for now
// (loads a static Graph-JSON file or receives one via postMessage).
//
// Modus "pages" (npm run build:pages) baut die Web-Fassung für GitHub Pages:
// relative Pfade, damit sie unter /<repo>/ läuft, plus Beispieldaten.
export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === 'pages' ? [exampleData()] : [])],
  base: mode === 'pages' ? './' : '/',
  server: {
    port: 3001,
  },
}))
