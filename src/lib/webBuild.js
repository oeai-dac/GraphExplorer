// Die Web-Fassung auf GitHub Pages ("npm run build:pages", Modus "pages").
// Sie ist derselbe Explorer, nur mit Beispieldaten zum Ausprobieren und ohne
// das, was online nicht geht: eigene Kacheln neben der HTML-Datei und die
// Kopplung an QGIS/Blender (die bleibt bewusst der lokalen Fassung
// vorbehalten). Vite ersetzt den Ausdruck beim Bauen durch true/false.
export const IS_WEB = import.meta.env?.MODE === 'pages'

// Liegt im Pages-Build neben index.html, siehe vite.config.js.
export const EXAMPLE_URL = './example/GraphExplorer_Example.json'
