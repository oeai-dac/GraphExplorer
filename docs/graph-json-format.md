# Graph-JSON — Formatspezifikation

**Gemeinsame Schnittstelle zwischen OntoCartographer Studio und GraphExplorer**

Stand: Juli 2026

---

## Status dieses Dokuments

Dieses Dokument gehört **keiner der beiden Anwendungen allein**. Es liegt als
identische Kopie in beiden Projektordnern:

- `OntoCartographer-Studio/docs/graph-json-format.md`
- `GraphExplorer/docs/graph-json-format.md`

**Wer erzeugt, wer liest:**

| Rolle | Komponente |
|---|---|
| Produzent | OntoCartographer Studio, Endpunkt `POST /pipeline/graph-explorer-json` (`backend/main.py`) |
| Konsument | GraphExplorer (`src/lib/schema.js`, `src/store.js` und die Tab-Komponenten) |
| Zweiter Produzent | GraphExplorer selbst, `src/lib/rdfImport.js` — erzeugt dieselbe Struktur clientseitig aus RDF, ohne Studio |

Der Explorer ist **nicht** auf das Studio angewiesen: Er kann RDF (Turtle,
TriG, N-Triples, N-Quads, N3, inkl. RDF-Star) direkt einlesen und selbst in
diese Struktur überführen. Das Studio liefert lediglich die reichere Variante,
weil es die Ontologie kennt (Farben nach CIDOC-Ankerklassen, aufgelöste
Inverse-Properties, kuratierte Labels).

Wird das Format geändert, müssen beide Seiten und dieses Dokument angepasst
werden. Es gibt bewusst **kein** Versionsfeld und keinen automatisierten
Kompatibilitätstest — beide Entwicklungen liegen in einer Hand.

---

## 1. Top-Level-Struktur

```json
{
  "meta":       { ... },
  "node_types": { "<TypKey>": <Anzahl>, ... },
  "edge_types": { "<KantenKey>": <Anzahl>, ... },
  "schema":     { ... },
  "nodes":      { "<KnotenID>": { ... }, ... },
  "languages":  { "primary": "de", "additional": ["en"] }
}
```

| Feld | Pflicht | Beschreibung |
|---|---|---|
| `meta` | optional | Titel und Herkunftsangaben, rein informativ |
| `node_types` | empfohlen | Knotentyp → Häufigkeit. Grundlage für Statistik-Kacheln und die Schema-Ableitung |
| `edge_types` | empfohlen | Kantentyp → Häufigkeit |
| `schema` | optional | Darstellungssteuerung, siehe [Abschnitt 4](#4-schema-block) |
| `nodes` | **Pflicht** | Der eigentliche Graph |
| `languages` | optional | Sprachen der Labels, siehe [Abschnitt 6](#6-mehrsprachige-labels). Fehlt bei einsprachigen Graphen |

Fehlen `node_types`/`edge_types`, funktioniert der Explorer weiterhin, die
Übersicht bleibt aber leer. Fehlt `schema`, leitet der Explorer alles selbst
ab (siehe 4.2).

### 1.1 `meta`

```json
"meta": {
  "title": "Carnuntum 1989–2024",
  "description": "...",
  "node_count": 116318,
  "edge_count": 218804,
  "generated": "2026-04-11",
  "generated_by": "OntoCartographer Studio"
}
```

Alle Felder optional. `node_count`/`edge_count` werden vom Explorer **nicht**
zur Steuerung verwendet — er zählt selbst.

---

## 2. Knoten

```json
"B_1989_2": {
  "l": "SE 2 (1989)",
  "t": "Befund",
  "a": {
    "ansprache": "Graben",
    "befundart": "Erdbefund",
    "jahr": "1989"
  },
  "o": {
    "VERORTET_IN": ["L_319_26"],
    "ENTHAELT_FN": ["FN_1115_89", "FN_1073_89"]
  },
  "i": {
    "HAT_BEFUND": ["K_1989"]
  }
}
```

| Schlüssel | Typ | Bedeutung |
|---|---|---|
| `l` | String | Label / Anzeigename (Primärsprache) |
| `t` | String | Typ — muss ein Schlüssel aus `node_types` sein |
| `a` | Objekt | Attribute als Schlüssel-Wert-Paare |
| `o` | Objekt | **Ausgehende** Kanten: Kantentyp → Liste von Knoten-IDs |
| `i` | Objekt | **Eingehende** Kanten: Kantentyp → Liste von Knoten-IDs |
| `l_i18n` | Objekt | *optional*: `{ Sprache: Label }` der Zusatzsprachen — siehe [Abschnitt 6](#6-mehrsprachige-labels) |

Die kurzen Schlüsselnamen sind Absicht: Bei ~120.000 Knoten spart das
mehrere Megabyte. Der Objekt-statt-Array-Aufbau erlaubt O(1)-Zugriff per ID
und Nachbarschaftsnavigation ohne Traversal-Algorithmus.

**Redundanz von `o` und `i`:** Beide Richtungen werden vollständig
materialisiert. Eine Kante A→B erscheint in `A.o` *und* in `B.i`. Produzenten
müssen beide Seiten konsistent schreiben.

**Die beiden Seiten dürfen verschieden heißen.** Das Studio trägt in `i` die
aufgelöste Inverse-Property ein: dieselbe Kante steht beim Ort als
`o: { "…#as:hat_pois": [POI] }` und beim POI als `i: { "Ist POI von": [Ort] }`.
Genau das macht die Detailansicht lesbar („Hat POIs →" hin, „Ist POI von ←"
zurück). Konsumenten dürfen `i` deshalb **nie** aus `o` ableiten — auch nicht
beim Umbauen des Graphen (siehe `src/lib/collapse.js`).

### 2.1 Attributwerte

Werte sollten **Strings** sein. Der Explorer verarbeitet Zahlen, `null`,
Arrays und Objekte ohne Absturz, stellt sie aber nur eingeschränkt dar —
Filter und Diagramme rechnen mit Skalarwerten.

Mehrfachbelegte Properties werden vom Produzenten zusammengeführt. Kollidieren
lokale Namen aus verschiedenen Namespaces, hängt der Produzent `#2`, `#3` …
an, statt still zu überschreiben.

### 2.2 Sonderfall Geodaten

Es gibt **kein eigenes Geometriefeld**. Koordinaten stehen als gewöhnliche
WKT-Zeichenketten in normalen Attributwerten:

```json
"a": { "geometrie": "POINT(16.3738 48.2082)" }
```

Der Explorer erkennt sie am WKT-Muster (`POINT`, `LINESTRING`, `POLYGON`,
`MULTIPOINT`, `MULTILINESTRING`, `MULTIPOLYGON`, optional mit Z/M-Marker) und
blendet daraufhin den Karten-Tab ein.

**WKT trägt keinen SRID.** Der Explorer fragt beim ersten Kartenaufruf per
Dialog nach dem EPSG-Code oder einer proj4-Definition. Produzenten müssen
sich also nicht auf ein Referenzsystem festlegen — sollten aber im
`meta.description` vermerken, welches verwendet wurde.

### 2.3 Sonderfall Freitext-Knoten

Modellierungsbedingt entstehen im Studio oft eigene Knoten für reine
Textwerte (z.B. eine Notiz über `P3_has_note` auf einen `rdfs:Literal`-Knoten).
Der Studio-Export **faltet diese in die Attribute des Elternknotens** ein,
statt sie als eigenständige Knoten zu exportieren. Als Attributschlüssel dient
der Explorer-Name des Literal-Knotens.

Für Konsumenten ist das transparent — es gibt schlicht keine solchen Knoten
im Ergebnis.

---

## 3. Kantentyp-Schlüssel

Ein Kantentyp-Schlüssel ist im Normalfall ein sprechender Name oder eine
Property-URI. Zwei Muster haben **Sonderbedeutung**:

### 3.1 Dot-One-Kanten (RDF-Star / Stratigrafie)

```
<PropertyURI>#dot1:<kanonisierterWert>
```

Beispiel:
`http://.../AP11_has_physical_relation_to#dot1:unter`

Entsteht aus RDF-Star-Annotationen der Form:

```turtle
<< :SU1002 ap:AP11_has_physical_relation_to :SU1001 >>
    ap:AP11.1_has_type "unter" .
```

Der Explorer erkennt den Marker `#dot1:` (Konstante `DOT1_MARK` in
`src/lib/harrisMatrix.js`) und schaltet daraufhin den Harris-Matrix-Tab frei.

**Kanonisiertes Vokabular** (Umlaute werden normalisiert, ü→ue):

| Kanonische Werte | Bedeutung in der Matrix |
|---|---|
| `unter`, `below`, `under`, `unten` | liegt tiefer / ist älter |
| `ueber`, `above`, `over`, `oben` | liegt höher / ist jünger |
| `gleichzeitig`, `zeitgleich`, `same time`, `contemporary with` | gleicher Rang, wird geclustert |
| `entspricht`, `equals`, `same as`, `corresponds to` | Gleichsetzung, wird geclustert |

Alle anderen Werte werden als „unklare Beziehung" dargestellt (rot gestrichelt)
— sie gehen nicht verloren, sind aber nicht sequenzierbar.

### 3.2 Anzeige-Aliase

```
<URI>#as:<slug>
```

Ein im Studio gesetzter **Explorer-Name** erzeugt einen eigenen Anzeige-
schlüssel, getrennt vom eigentlichen RDF-Typ. Damit lassen sich mehrere
Knoten derselben Ontologieklasse im Explorer als unterschiedliche,
getrennt gezählte Typen führen (z.B. `E55_Type#as:material` gegenüber
`E55_Type#as:erhaltungszustand`), ohne die RDF-Semantik anzutasten.

Gilt gleichermaßen für Knotentypen und für Kantentypen. Der Explorer
behandelt solche Schlüssel als ganz normale, opake Typschlüssel — die
Auflösung passiert ausschließlich über `schema.typeLabels` /
`schema.edgeLabels`.

---

## 4. Schema-Block

```json
"schema": {
  "typeColors": { "Befund": "#1d9e75", "Fundnummer": "#3888dd" },
  "typeLabels": { "Befund": "Befund", "Lokalitaet": "Lokalität" },
  "edgeLabels": { "HAT_BEFUND": "hat Befund", "VERORTET_IN": "verortet in" },
  "mainAttrs": { "Befund": ["ansprache", "befundart"] }
}
```

| Feld | Beschreibung |
|---|---|
| `typeColors` | Knotentyp → Hex-Farbe |
| `typeLabels` | Knotentyp → Anzeigename (Primärsprache) |
| `edgeLabels` | Kantentyp → Anzeigename (Primärsprache) |
| `mainAttrs` | Knotentyp → Attributschlüssel, die zuerst angezeigt werden |
| `typeLabelsI18n` | *optional*: `{ Sprache: { Knotentyp: Anzeigename } }` |
| `edgeLabelsI18n` | *optional*: `{ Sprache: { Kantentyp: Anzeigename } }` |

Alle Felder sind einzeln optional; fehlende werden als `{}` behandelt.

### 4.1 Farb- und Labelauflösung im Studio-Export

**Farbe** (höchste Priorität zuerst):
1. Explizit im Request mitgelieferte Canvas-Knotenfarbe
2. CIDOC-CRM-Ankerfarbe bei Namensübereinstimmung
3. Zyklische Vergabe aus einer 20-Farben-Palette

**Label** (höchste Priorität zuerst):
1. Im Studio gesetzter **Explorer-Name** → erzeugt `#as:`-Schlüssel (3.2)
2. Explizit mitgeliefertes Canvas-Label
3. `rdfs:label` aus der geladenen Ontologie (Deutsch bevorzugt)
4. Humanisierter lokaler URI-Name (Unterstriche → Leerzeichen)

### 4.2 Verhalten ohne Schema-Block

Der Explorer ist rückwärts- und fremdkompatibel. Ohne `schema` leitet
`src/lib/schema.js` ab:

- **Farben:** zyklisch aus `PALETTE` (20 Einträge, die ersten 11 entsprechen
  den CIDOC-Ankerfarben)
- **Labels:** Lokalname der URI, Unterstriche → Leerzeichen. Ein Schlüssel,
  der nicht wie eine URI aussieht (kein `://` und kein `#`), wird
  **unverändert** übernommen — ein Anzeigename wie `Straße/Ω` darf nicht auf
  sein letztes Pfadsegment gekürzt werden.

Damit lassen sich auch extern erzeugte Graph-JSON-Dateien laden, die nie
durch das Studio gelaufen sind.

### 4.3 Nutzer-Overrides (nicht Teil des Formats)

Farbanpassungen und die Sortierung von Attributen/Nachbarschaftsgruppen, die
Anwender:innen im Explorer vornehmen, landen im `localStorage` unter dem
Schlüssel `ge:explorerPrefs:v1`. Sie werden über das mitgelieferte Schema
gelegt und **nie in die Datei zurückgeschrieben**.

Dazu gehören auch Farben für **einzelne Knoten** (`nodeColors`, Knoten-ID →
Hex). Sie gewinnen gegen `typeColors` und sind bewusst kein Bestandteil des
Formats: Ein Produzent färbt Typen, ein einzelner Knoten wird im Explorer
hervorgehoben.

---

## 5. Vollständiges Minimalbeispiel

```json
{
  "meta": { "title": "Minimalbeispiel", "generated_by": "manuell" },
  "node_types": { "Ort": 1, "Fund": 1 },
  "edge_types": { "GEFUNDEN_IN": 1 },
  "schema": {
    "typeColors": { "Ort": "#94cc7d", "Fund": "#c78e66" },
    "typeLabels": { "Ort": "Ort", "Fund": "Fund" },
    "edgeLabels": { "GEFUNDEN_IN": "gefunden in" },
    "mainAttrs": { "Fund": ["material"] }
  },
  "nodes": {
    "O_1": {
      "l": "Grabungsfläche 1",
      "t": "Ort",
      "a": { "geometrie": "POINT(16.3738 48.2082)" },
      "o": {},
      "i": { "GEFUNDEN_IN": ["F_1"] }
    },
    "F_1": {
      "l": "Fibel 1",
      "t": "Fund",
      "a": { "material": "Bronze" },
      "o": { "GEFUNDEN_IN": ["O_1"] },
      "i": {}
    }
  }
}
```

---

## 6. Mehrsprachige Labels

Ein Graph kann seine Labels in mehreren Sprachen führen. Der Aufbau ist
**rein additiv**: Die bestehenden einwertigen Felder (`l`, `schema.typeLabels`,
`schema.edgeLabels`) tragen unverändert die Primärsprache, die Zusatzsprachen
kommen in parallele Maps. Ein Konsument, der davon nichts weiß, liest damit
genau das, was er immer gelesen hat.

```json
{
  "languages": { "primary": "de", "additional": ["en"] },
  "nodes": {
    "https://example.org/SE1001": {
      "l": "Grubenverfüllung",
      "l_i18n": { "en": "Pit fill" },
      "t": "…/A8_Stratigraphic_Unit#as:stratigrafische_einheit",
      "a": {}, "o": {}, "i": {}
    }
  },
  "schema": {
    "typeLabels":     { "…#as:stratigrafische_einheit": "Stratigrafische Einheit" },
    "typeLabelsI18n": { "en": { "…#as:stratigrafische_einheit": "Stratigraphic Unit" } },
    "edgeLabels":     { "…/P53": "verortet in" },
    "edgeLabelsI18n": { "en": { "…/P53": "has former or current location" } }
  }
}
```

**Auflösungsregel für Konsumenten:** `l_i18n[aktiveSprache] ?? l`, analog für
`typeLabelsI18n` / `edgeLabelsI18n`. Ein fehlender Eintrag ist kein Fehler,
sondern bedeutet „in dieser Sprache nicht übersetzt" — angezeigt wird dann die
Primärsprache.

Zwei Eigenschaften, auf die sich ein Konsument verlassen darf:

- **Typschlüssel sind sprachunabhängig.** Ein Schlüssel mit `#as:`-Marker
  leitet seinen Slug ausschließlich aus dem Namen in der Primärsprache ab. Ein
  Sprachwechsel benennt die Typgruppen also um, ohne sie neu zu gruppieren —
  Zählungen in `node_types`/`edge_types` bleiben gültig.
- **Keine Schein-Übersetzungen.** Ein Eintrag entsteht nur, wenn für diese
  Sprache tatsächlich ein eigener Text vorliegt (kuratierter Name oder ein
  `rdfs:label` mit exakt diesem Tag). Es wird nie derselbe Text in mehrere
  Sprachen kopiert.

Einsprachig bleiben: Attributwerte in `a` (das sind Daten, keine Labels) und
Kantennamen, die aus einem kuratierten Explorer-Namen stammen — dieser benennt
einen Property-Typ, nach dem gruppiert wird.

> **Stand der Implementierung:** Das Studio *schreibt* diese Felder seit 3.1.0.
> Der GraphExplorer *liest* sie noch nicht und zeigt die Primärsprache; da alle
> Felder additiv sind, ist das unschädlich. Hier fehlt lediglich der
> Sprachumschalter auf der Explorer-Seite.

---

## 7. Erwartungen an Produzenten

1. `nodes` schreiben; `node_types`/`edge_types` passend zu den tatsächlich
   vorkommenden Schlüsseln füllen.
2. `o` und `i` konsistent halten — jede Kante auf beiden Seiten eintragen.
3. Keine hängenden Referenzen: Jede ID in `o`/`i` muss in `nodes` existieren.
4. Attributwerte als Strings.
5. Bei Dot-One-Kanten das Vokabular aus 3.1 kanonisieren.
6. `schema` mitliefern, wenn Farben/Labels kuratiert sind — sonst weglassen
   und die Ableitung des Explorers wirken lassen.
7. Mehrsprachige Felder nur schreiben, wenn es sie gibt: `languages`,
   `l_i18n` und die `*I18n`-Maps bei einem einsprachigen Graphen weglassen
   statt leer schreiben.

## 8. Erwartungen an Konsumenten

1. Fehlende optionale Felder tolerieren (`meta`, `schema`, `node_types`,
   `edge_types`, `languages`, sowie `a`/`o`/`i` je Knoten).
2. Unbekannte Zusatzfelder ignorieren, nicht als Fehler behandeln.
3. Typschlüssel als **opak** behandeln — nie parsen, außer für die beiden
   dokumentierten Marker `#dot1:` und `#as:`.
4. Nicht-String-Attributwerte nicht als Absturzgrund behandeln.
