export function neighborsToCsv(graph, nodeId) {
  const nd = graph.nodes[nodeId]
  if (!nd) return ''
  const lines = ['Direction\tEdge Type\tNode ID\tLabel\tNode Type']
  Object.entries(nd.o || {}).forEach(([et, nids]) => {
    nids.forEach((nid) => {
      const nn = graph.nodes[nid]
      lines.push(`→\t${et}\t${nid}\t${nn ? nn.l : ''}\t${nn ? nn.t : ''}`)
    })
  })
  Object.entries(nd.i || {}).forEach(([et, nids]) => {
    nids.forEach((nid) => {
      const nn = graph.nodes[nid]
      lines.push(`←\t${et}\t${nid}\t${nn ? nn.l : ''}\t${nn ? nn.t : ''}`)
    })
  })
  return lines.join('\n')
}
