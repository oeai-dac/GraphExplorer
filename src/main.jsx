import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { useStore } from './store'
import './styles.css'
// Die Browser-Seite der Kopplung an QGIS und Blender. Sie ist in jedem Build
// dabei -- start.bat und Standalone-Datei sind damit ein und derselbe
// Explorer, an den sich die Plugins anhängen. Ohne Verbindung bleibt sie
// still; verbinden lässt sich jederzeit über die Leiste unten links.
import './explorer-bridge.js'

// Version des Vertrags zwischen App und Brücke. Wird erhöht, sobald sich
// ändert, was hier bereitgestellt wird -- die Python-Seite prüft sie beim
// Verbinden und kann dann klar sagen "Plugin und Explorer passen nicht
// zusammen", statt an einer fehlenden Methode aufzulaufen.
//
// 2: describeValues/collectValues -- die Graph-Seite der Werteübernahme in
//    die QGIS-Attributtabelle. Die Wirte prüfen auf "mindestens", nicht auf
//    "genau".
const API_VERSION = 2

window.__GRAPH_EXPLORER_API__ = {
  version: API_VERSION,
  store: useStore,
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
