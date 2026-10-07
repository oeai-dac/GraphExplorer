import { useRef } from 'react'
import { DashboardPane } from './DashboardPane'

// Draggable edge between two areas. Uses pointer capture, so once the drag
// starts every move lands here regardless of what it passes over -- without
// it, the pointer entering a Leaflet map or a ReactFlow canvas would hand the
// drag to them mid-gesture.
function Splitter({ dir, onDrag }) {
  const rectRef = useRef(null)

  function down(e) {
    e.preventDefault()
    // The parent is the .dash-split we divide; its box is what the ratio is
    // measured against.
    rectRef.current = e.currentTarget.parentElement.getBoundingClientRect()
    e.currentTarget.setPointerCapture(e.pointerId)
    document.body.classList.add('dash-dragging')
  }

  function move(e) {
    const r = rectRef.current
    if (!r) return
    onDrag(dir === 'row' ? (e.clientX - r.left) / r.width : (e.clientY - r.top) / r.height)
  }

  function up(e) {
    if (!rectRef.current) return
    rectRef.current = null
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      // pointer already released (cancelled gesture) -- nothing to undo
    }
    document.body.classList.remove('dash-dragging')
  }

  return (
    <div
      className={'dash-splitter ' + dir}
      title="Drag to move · double-click to split evenly"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onDoubleClick={() => onDrag(0.5)}
    />
  )
}

// Renders the layout tree. `a` gets a fixed share of the parent, `b` takes
// whatever is left, so rounding never leaves a seam.
export function SplitView({ node, graph, active, canClose, actions }) {
  if (node.type === 'pane') {
    return <DashboardPane node={node} graph={graph} active={active} canClose={canClose} actions={actions} />
  }

  const share = `calc(${(node.ratio * 100).toFixed(3)}% - 3px)`

  return (
    <div className={'dash-split ' + node.dir}>
      <div className="dash-slot" style={{ flexBasis: share }}>
        <SplitView node={node.a} graph={graph} active={active} canClose={canClose} actions={actions} />
      </div>
      <Splitter dir={node.dir} onDrag={(ratio) => actions.setRatio(node.id, ratio)} />
      <div className="dash-slot dash-slot-rest">
        <SplitView node={node.b} graph={graph} active={active} canClose={canClose} actions={actions} />
      </div>
    </div>
  )
}
