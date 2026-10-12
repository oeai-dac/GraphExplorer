// Die Web-Fassung auf GitHub Pages ("npm run build:pages", Modus "pages").
// Sie ist derselbe Explorer, nur mit Beispieldaten zum Ausprobieren und ohne
// das, was online nicht geht: eigene Kacheln neben der HTML-Datei und die
// Kopplung an QGIS/Blender (die bleibt bewusst der lokalen Fassung
// vorbehalten). Vite ersetzt den Ausdruck beim Bauen durch true/false.
export const IS_WEB = import.meta.env?.MODE === 'pages'

// Liegt im Pages-Build neben index.html, siehe vite.config.js.
export const EXAMPLE_URL = './example/GraphExplorer_Example.json'
// The 3D bodies belonging to it, offered in the 3D tab.
export const EXAMPLE_MODEL_URL = './example/GraphExplorer_Example.obj'
export const EXAMPLE_MTL_URL = './example/GraphExplorer_Example.mtl'
