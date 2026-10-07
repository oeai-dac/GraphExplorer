import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../../store'
import { buildNodePreview } from '../../lib/nodePreview'
import { edgeLabel, fmt, humaniseKey } from '../../lib/schema'
import { Dot, Tag } from './TypeTag'
import { hideNodeHover, useHoverTarget } from './nodeHover'

const GAP = 12 // distance from the hovered element
const EDGE = 8 // keep this much clear of the viewport edge

// Rendered into document.body rather than next to the element it describes:
// node rows live inside panels with `overflow: hidden` (the detail column,
// the result lists, every Dashboard pane), which would clip a card
// positioned in place no matter how it's stacked.
function Card({ target }) {
  const graph = useStore((s) => s.graph)
  const schema = useStore((s) => s.schema)
  const prefs = useStore((s) => s.prefs)
  const ref = useRef(null)
  const [pos, setPos] = useState(null)

  const nodeType = graph?.nodes?.[target.nodeId]?.t
  const preview = useMemo(
    () => buildNodePreview(graph, schema, target.nodeId, { connOrder: prefs.connOrder[nodeType] }),
    [graph, schema, target.nodeId, prefs, nodeType]
  )

  // Position once the real size is known: preferably to the right of the
  // hovered element, flipped to its left when that would run off screen, and
  // nudged up when the card is taller than the space below it. Runs before
  // paint, so the provisional position is never visible.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const card = el.getBoundingClientRect()
    const r = target.rect
    const vw = window.innerWidth
    const vh = window.innerHeight

    let left = r.right + GAP
    if (left + card.width > vw - EDGE) left = r.left - GAP - card.width
    if (left < EDGE) left = Math.max(EDGE, vw - card.width - EDGE)

    let top = r.top
    if (top + card.height > vh - EDGE) top = vh - card.height - EDGE
    if (top < EDGE) top = EDGE

    setPos({ left, top })
  }, [target, preview])

  if (!preview) return null

  return (
    <div
      ref={ref}
      className="nhc"
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
    >
      <div className="nhc-hdr">
        <Dot schema={schema} type={preview.type} id={preview.id} />
        <strong className="nhc-title">{preview.label}</strong>
      </div>
      <div className="nhc-sub">
        <Tag schema={schema} type={preview.type} />
        <span className="nhc-id">{preview.id}</span>
      </div>

      {preview.image && <img className="nhc-img" src={preview.image} alt="" loading="lazy" />}

      {preview.attrs.length > 0 && (
        <dl className="nhc-dl">
          {preview.attrs.map((a) => (
            <Fragment key={a.key}>
              <dt>{humaniseKey(a.key)}</dt>
              <dd>{a.value}</dd>
            </Fragment>
          ))}
        </dl>
      )}
      {preview.moreAttrs > 0 && <div className="nhc-more">+{preview.moreAttrs} more attributes</div>}

      {preview.connections.length > 0 && (
        <div className="nhc-conns">
          {preview.connections.map((c) => (
            <div key={c.dir + c.etype} className="nhc-conn">
              <div className="nhc-conn-top">
                <span className="nhc-conn-dir">{c.dir === 'o' ? '→' : '←'}</span>
                <span className="nhc-conn-lbl">{edgeLabel(schema, c.etype)}</span>
                <span className="nhc-conn-cnt">{fmt(c.count)}</span>
              </div>
              <div className="nhc-conn-sample">
                {c.sample.join(' · ')}
                {c.count > c.sample.length ? ' …' : ''}
              </div>
            </div>
          ))}
        </div>
      )}
      {preview.moreConnections > 0 && (
        <div className="nhc-more">+{preview.moreConnections} more connection types</div>
      )}

      <div className="nhc-foot">Click to open</div>
    </div>
  )
}

export function NodeHoverCard() {
  const target = useHoverTarget()

  // The card is anchored to a viewport position, so anything that moves the
  // page underneath it makes that anchor a lie. Scrolling is captured rather
  // than bubbled so inner scroll containers count too. Clicking dismisses it
  // because a click usually navigates, and the element the card described is
  // then gone without ever firing mouseleave.
  useEffect(() => {
    if (!target) return
    window.addEventListener('scroll', hideNodeHover, true)
    window.addEventListener('resize', hideNodeHover)
    document.addEventListener('click', hideNodeHover, true)
    return () => {
      window.removeEventListener('scroll', hideNodeHover, true)
      window.removeEventListener('resize', hideNodeHover)
      document.removeEventListener('click', hideNodeHover, true)
    }
  }, [target])

  if (!target) return null
  // Keyed so each new node starts with a fresh, unmeasured position instead
  // of briefly inheriting the previous one.
  return createPortal(<Card key={target.nodeId} target={target} />, document.body)
}
