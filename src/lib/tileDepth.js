/**
 * Bis zu welcher Zoomstufe ein selbst erzeugtes Kachelraster Kacheln hat.
 *
 * Bei den Online-Anbietern ist diese Tiefe bekannt und fest eingetragen. Ein
 * eigenes Raster aus QGIS oder gdal2tiles reicht dagegen genau so weit, wie es
 * beim Export gewaehlt wurde -- und das weiss die App nicht. Unter file://
 * laesst es sich auch nicht nachsehen: Verzeichnisse lassen sich nicht lesen,
 * und fetch() ist dort blockiert. Bleibt: beim Laden zuschauen.
 *
 * Zu niedrig angesetzt bleibt vorhandene Aufloesung ungenutzt. Zu hoch
 * angesetzt fordert Leaflet Kacheln an, die es nicht gibt, und die Karte wird
 * beim Hineinzoomen leer statt unscharf -- das ist die schlechtere Haelfte,
 * denn "unscharf" ist eine Aussage ueber die Daten, "leer" sieht aus wie ein
 * Fehler.
 */

/**
 * Entscheidet nach einer fehlgeschlagenen Kachel, welche Tiefe ab jetzt gilt.
 *
 * @param {object}  args
 * @param {number}  args.current      bisher angenommene Tiefe
 * @param {number}  args.errorZoom    Stufe, auf der eine Kachel gefehlt hat
 * @param {Set<number>|number[]} args.loadedZooms  Stufen mit erfolgreichem Laden
 * @returns {number} die neue Tiefe (unveraendert, wenn nichts zu schliessen ist)
 */
export function nextTileDepth({ current, errorZoom, loadedZooms }) {
  if (typeof errorZoom !== 'number' || !Number.isFinite(errorZoom)) return current

  const loaded = [...(loadedZooms || [])].filter((z) => typeof z === 'number')

  // Noch nie eine Kachel bekommen? Dann ist unklar, ob das Raster hier ueberhaupt
  // etwas hat oder ob nur dieser Ausschnitt leer ist. Nichts aendern: so fordert
  // Leaflet weiterhin auf der jeweils angezeigten Stufe an, und sobald irgendwo
  // eine Kachel sitzt, greift die Regel unten. Wuerde man stattdessen blind
  // Stufe fuer Stufe grober werden, liefe ein Raster, das erst bei einer
  // tieferen Stufe beginnt, endgueltig ins Leere.
  if (loaded.length === 0) return current

  const deepest = Math.max(...loaded)

  // Nur was TIEFER liegt als alles bisher Geladene, beweist das Ende der
  // Pyramide. Luecken auf oder ueber der bereits belegten Stufe sind bloss
  // Loecher am Rand des abgedeckten Gebiets -- daraus darf keine Tiefe folgen.
  if (errorZoom <= deepest) return current

  return Math.min(current, deepest)
}
