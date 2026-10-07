# tests/fixtures — Prüfskripte für den GraphExplorer

Diese Skripte rufen die reinen Logikmodule aus `src/lib/` direkt unter Node
auf — **ohne Browser, ohne Backend, ohne Netzwerk**. Sie prüfen vor allem
Datenunabhängigkeit (kommt der Explorer mit fremden, unbequemen Graphen klar?)
und Skalierung (bleibt er bei ~120.000 Knoten benutzbar?).

## Dateien

| Datei | Zweck |
|---|---|
| `generic-graph.json` | Bewusst untypisches Graph-JSON **ohne** `schema`-Block. Deckt ab: Unicode-/Sonderzeichen-Typen und -Labels, WKT-False-Positives (`POINT(abc def)`, `POINTER…`), projizierte Geometrie (Nicht-WGS84), zyklische und widersprüchliche Dot-One-Stratigrafie, Nicht-Skalar-Attribute (Array/Objekt/null/Zahl), Knoten ohne Typ. |
| `example-graph.json` | Echter, großer Export aus OntoCartographer Studio (~12 MB). Skalen- und Performance-Smoke-Test. **Nicht im Repository** — siehe unten. |
| `example-rdf.trig` | Echter TriG-Export desselben Datensatzes (~11 MB). Referenz für den RDF-Direktimport. **Nicht im Repository.** |
| `run-lib-checks.mjs` | Ruft die Logikmodule (`filters`, `geo`, `schema`, `schemaGraph`, `harrisMatrix`, `chartData`, `temporal`, `timelineLanes` …) mit beiden Graphen auf — beim Zeitstrahl auch die Zeilen („je Wert eine Zeile", auch über eine **Kante** wie die SE eines Fundes) und den Jahresbereichsfilter. |
| `run-rdf-import-check.mjs` | Prüft den clientseitigen RDF-Importer (`src/lib/rdfImport.js`, N3.js) gegen ein kleines RDF-Star-Beispiel und gegen `example-rdf.trig` — Knoten-/Typ-/Dot-One-Erkennung, Harris-Sequenz — und vergleicht grob mit `example-graph.json`. |
| `run-collapse-check.mjs` | Prüft das Zusammenfassen von Durchgangs-Knotentypen (`src/lib/collapse.js`): synthetisch (SE → Embedding → Fund) und am echten TriG (`S23_Position_Determination`), inkl. Integritätscheck auf hängende Referenzen. Dazu die Attributübernahme: ein Blattknoten mit nichts als einer Datierung darf beim Zusammenfassen nicht verlorengehen, sondern muss am Fund landen — auch im Zeitstrahl —, und an einem Knotenpunkt mit vielen zusammengefassten Nachbarn müssen die Werte gekappt werden. |

## Ausführung

Kein Backend nötig, kein Server, keine Vorbereitung außer `npm install`:

```bash
cd tests/fixtures

node --max-old-space-size=4096 run-lib-checks.mjs
node --max-old-space-size=4096 run-rdf-import-check.mjs
node --max-old-space-size=4096 run-collapse-check.mjs
```

Das erhöhte Heap-Limit ist für die großen Beispieldateien nötig.

## Zu den großen Beispieldateien

`example-graph.json` und `example-rdf.trig` sind **per `.gitignore`
ausgeschlossen** (zusammen ~24 MB). Fehlen sie, überspringen die Skripte die
betroffenen Abschnitte per `existsSync`-Guard und laufen mit
`generic-graph.json` und den synthetischen Fällen normal durch — die Prüfung
verliert dann nur den Skalen- und Realdatenanteil.

Wer sie braucht, erzeugt sie aus einem beliebigen Projekt in OntoCartographer
Studio (Explore-Button für das JSON, RDF-Button/TriG für das RDF) und legt sie
unter diesen beiden Namen hier ab.

## Technischer Hinweis

Die Lib-Dateien nutzen Vite-typische Imports ohne `.js`-Endung
(`import … from './filters'`). Node löst das von Haus aus nicht auf, deshalb
registriert jedes Skript einen kleinen Resolve-Hook, der die Endung nachreicht.
**Projektcode wird dafür nicht verändert.** Bare-Imports (`proj4`, `dagre`,
`n3`) kommen aus `node_modules/` im Projektwurzelverzeichnis.

## Historie

Diese Fixtures entstanden im Rahmen einer Gesamtprüfung beider Werkzeuge (siehe
`../../../OntoCartographer-Studio/review/fable-gesamtpruefung.md`). Ein damals
vierter Test, `run-regression-check.mjs`, verglich den Studio-Export gegen eine
laufende Backend-Instanz; er setzt eine Studio-Installation voraus und liegt
deshalb seit der Trennung der beiden Anwendungen unter
`../../../OntoCartographer-Studio/tests/fixtures/`.
