import { Dot } from '../shared/TypeTag'
import { nodeHoverProps } from '../shared/nodeHover'

const VISIBLE = 6

export function Breadcrumbs({ schema, trail, onBack, onSelect }) {
  const visible = trail.slice(-VISIBLE)
  const offset = trail.length - visible.length

  return (
    <div className="trail">
      <button className={'trail-back' + (trail.length <= 1 ? ' disabled' : '')} onClick={onBack}>
        &#8592; Back
      </button>
      {offset > 0 && <span className="trail-sep">…</span>}
      {visible.map((item, i) => {
        const realIdx = offset + i
        const isCurrent = realIdx === trail.length - 1
        return (
          <span key={item.id + realIdx} style={{ display: 'flex', alignItems: 'center', gap: '.3rem' }}>
            {(i > 0 || offset > 0) && <span className="trail-sep">›</span>}
            <span
              className={'trail-item' + (isCurrent ? ' current' : '')}
              onClick={() => onSelect(realIdx)}
              {...nodeHoverProps(item.id)}
            >
              <Dot schema={schema} type={item.type} id={item.id} />
              <span className="trail-label">{item.label}</span>
            </span>
          </span>
        )
      })}
    </div>
  )
}
