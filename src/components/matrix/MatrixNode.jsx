import { Handle, Position } from 'reactflow'

// Four dedicated handles so rank edges (vertical) and same-rank/equals
// edges (horizontal) each connect via the two box edges that actually face
// each other, instead of ReactFlow's single default source/target pair
// routing the "long way around" the box.
//
//   top    (source) -- rank edges leave here towards the node above
//   bottom (target) -- rank edges arrive here from the node below
//   right  (source) -- same-rank/equals edges leave here towards the
//                       neighbour positioned to the right
//   left   (target) -- same-rank/equals edges arrive here from the
//                       neighbour positioned to the left
export function MatrixNode({ data, selected }) {
  return (
    <div
      style={{
        width: '100%', height: '100%',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: data.color, color: '#1e2d33',
        border: selected ? '2px solid var(--gold)' : '1px solid rgba(0,0,0,.25)',
        borderRadius: 4,
        boxShadow: selected ? '0 0 0 3px rgba(31,141,166,.35), 0 0 14px rgba(31,141,166,.5)' : 'none',
        fontSize: 11, fontFamily: "'IBM Plex Mono',monospace",
        fontWeight: selected ? 700 : 400,
        padding: '0 6px', textAlign: 'center',
        zIndex: selected ? 10 : 0,
      }}
    >
      <Handle type="source" position={Position.Top} id="top" style={{ visibility: 'hidden' }} />
      <Handle type="target" position={Position.Bottom} id="bottom" style={{ visibility: 'hidden' }} />
      <Handle type="source" position={Position.Right} id="right" style={{ visibility: 'hidden' }} />
      <Handle type="target" position={Position.Left} id="left" style={{ visibility: 'hidden' }} />
      {data.label}
    </div>
  )
}
