import { useStore } from '../../store'
import { typeColor, nodeColor, typeLabel, readableTextColor } from '../../lib/schema'

// `id` is optional: pass it wherever the dot stands for one concrete node, so
// a color given to that node wins over its type's. A legend entry or a type
// bar has no id and stays on the type color.
export function Dot({ schema, type, id }) {
  return <span className="dot" style={{ background: nodeColor(schema, id, type) }} />
}

// Same visual as Dot, but a real (invisibly-styled) native color input, so
// clicking it opens the browser's own color picker. The saved override is
// layered onto the schema in the store, so every other typeColor()/nodeColor()
// call site (Map, Matrix, Explorer tags, ...) picks it up automatically.
function ColorSwatch({ color, title, resetTitle, label, onPick, onReset, onStop }) {
  return (
    <span className="dot-edit-wrap" onClick={(e) => { e.stopPropagation(); onStop?.() }}>
      {/* Wrapped in a label so the caption opens the picker too -- a bare 12px
          swatch is findable in a list of them, but not on its own. */}
      <label className={label ? 'dot-edit-chip' : undefined} title={title}>
        <input
          type="color"
          className="dot-edit"
          value={color}
          onChange={(e) => onPick(e.target.value)}
        />
        {label}
      </label>
      {onReset && (
        <button
          type="button"
          className="dot-edit-reset"
          title={resetTitle}
          onClick={(e) => { e.stopPropagation(); onReset() }}
        >
          &#8635;
        </button>
      )}
    </span>
  )
}

export function ColorDot({ schema, type, hasOverride, onStop }) {
  const setTypeColor = useStore((s) => s.setTypeColor)
  const resetTypeColor = useStore((s) => s.resetTypeColor)
  return (
    <ColorSwatch
      color={typeColor(schema, type)}
      title="Change the colour of this type"
      resetTitle="Reset to default colour"
      onPick={(c) => setTypeColor(type, c)}
      onReset={hasOverride ? () => resetTypeColor(type) : null}
      onStop={onStop}
    />
  )
}

// The same picker for a SINGLE node -- for picking one node out of its type
// ("Bronze/Kupfer" among all materials) rather than recoloring the whole type.
export function NodeColorDot({ schema, id, type, label, onStop }) {
  const hasOverride = useStore((s) => !!s.prefs.nodeColors?.[id])
  const setNodeColor = useStore((s) => s.setNodeColor)
  const resetNodeColor = useStore((s) => s.resetNodeColor)
  return (
    <ColorSwatch
      color={nodeColor(schema, id, type)}
      label={label}
      title="Give this single node its own colour"
      resetTitle="Use the node type colour again"
      onPick={(c) => setNodeColor(id, c)}
      onReset={hasOverride ? () => resetNodeColor(id) : null}
      onStop={onStop}
    />
  )
}

export function Tag({ schema, type }) {
  const color = typeColor(schema, type)
  return (
    <span className="tag" style={{ color: readableTextColor(color), borderColor: color + '66', background: color + '18' }}>
      {typeLabel(schema, type)}
    </span>
  )
}
