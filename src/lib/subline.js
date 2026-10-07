// One line of content for a node reference, so a list row says something about
// the node instead of only naming it. Used by the Explorer's node list and by
// the neighbour rows of the detail view -- a dependent node (a CIDOC Time-Span
// whose label is just its id) otherwise shows nothing but that id, and the
// value it exists to carry stays invisible until you navigate into it.
export function getNodeSubline(schema, nd) {
  const mainAttrs = schema?.mainAttrs?.[nd?.t]
  if (mainAttrs && mainAttrs.length) {
    const main = mainAttrs.slice(0, 3).map((k) => nd?.a?.[k]).filter(Boolean).join(' · ')
    // Fall through when the type's configured main attributes are all empty on
    // THIS node -- an empty line is worse than an unconfigured one.
    if (main) return main
  }
  const vals = Object.values(nd?.a || {}).filter((v) => v && String(v).length < 60)
  return vals.slice(0, 2).join(' · ')
}
