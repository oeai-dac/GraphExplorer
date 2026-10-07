import { Handle, Position } from 'reactflow'

// One box on the Graph canvas.
//
// Eight handles, four a side: the radial layout puts neighbours in every
// direction, so an edge has to be able to leave and arrive on whichever side
// actually faces the other box. With ReactFlow's single default source/target
// pair, half the lines would route the long way around their own node. Which
// pair an edge uses is decided in GraphTab from the two positions -- the same
// approach the Harris Matrix takes for its horizontal edges.
const SIDES = [
  ['top', Position.Top],
  ['right', Position.Right],
  ['bottom', Position.Bottom],
  ['left', Position.Left],
]

export function ExploreNode({ data, selected }) {
  const { label, type, color, expanded, hidden, root } = data
  return (
    <div
      className={'gx-node' + (selected ? ' sel' : '') + (root ? ' root' : '')}
      style={{ borderLeftColor: color }}
    >
      {SIDES.map(([id, pos]) => (
        <Handle key={'s' + id} type="source" id={'s-' + id} position={pos} style={{ visibility: 'hidden' }} />
      ))}
      {SIDES.map(([id, pos]) => (
        <Handle key={'t' + id} type="target" id={'t-' + id} position={pos} style={{ visibility: 'hidden' }} />
      ))}
      <span className="gx-node-dot" style={{ background: color }} />
      <span className="gx-node-main">
        <span className="gx-node-label">{label}</span>
        {type && <span className="gx-node-type">{type}</span>}
      </span>
      {/* Three distinct states, because "nothing happens on click" and "not
          opened yet" look identical otherwise: a count of neighbours still to
          come, a minus for an open node, and a muted dot for a node whose
          neighbours are all on the canvas already. */}
      <span className={'gx-node-badge' + (expanded ? ' open' : '') + (!hidden ? ' done' : '')}>
        {hidden ? (expanded ? '+' + hidden : hidden) : expanded ? '−' : '·'}
      </span>
    </div>
  )
}
