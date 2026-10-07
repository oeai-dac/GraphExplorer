import { Fragment, useState } from 'react'
import { useStore } from '../../store'
import { Tag, NodeColorDot } from '../shared/TypeTag'
import { NeighborGroup } from './NeighborGroup'
import { humaniseKey } from '../../lib/schema'
import { orderedAttrKeys } from '../../lib/nodePreview'
import { neighborsToCsv } from '../../lib/exportCsv'
import { isUrl, isImageUrl, isImageKey } from '../../lib/links'

// A URL that is (or is hinted to be) an image, embedded inline. Clicking opens
// the full image in a new tab. If the image can't be loaded (e.g. a localhost
// path that isn't currently being served, or a dead URL) we fall back to the
// plain link so the value is never silently lost.
function ImageValue({ url, alt }) {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return <a className="dd-link" href={url} target="_blank" rel="noopener noreferrer">{url}</a>
  }
  return (
    <a className="dd-img-link" href={url} target="_blank" rel="noopener noreferrer" title={url}>
      <img className="dd-img" src={url} alt={alt || 'Bild'} loading="lazy" onError={() => setFailed(true)} />
    </a>
  )
}

function Value({ value, attrKey, noImage }) {
  const v = String(value)
  // Show inline when the value clearly is an image URL, or when the attribute
  // name says "image" and the value is at least a URL (covers extensionless
  // endpoints). No Studio configuration required. `noImage` keeps structural
  // fields like the Node ID as a plain identifier/link even when the id itself
  // happens to be an image URL.
  if (!noImage && (isImageUrl(v) || (attrKey && isImageKey(attrKey) && isUrl(v)))) {
    return <ImageValue url={v} alt={attrKey} />
  }
  return isUrl(v) ? (
    <a className="dd-link" href={v} target="_blank" rel="noopener noreferrer">{v}</a>
  ) : v
}

const LONG_THRESHOLD = 80

const DIR_RANK = { o: 0, i: 1 } // default: outgoing groups before incoming, matching prior fixed behavior

export function NodeDetail({ graph, schema, nodeId, onNavigate }) {
  const [copied, setCopied] = useState(false)
  const [reordering, setReordering] = useState(false)
  const [reorderingConn, setReorderingConn] = useState(false)
  const prefs = useStore((s) => s.prefs)
  const setAttrOrder = useStore((s) => s.setAttrOrder)
  const resetAttrOrder = useStore((s) => s.resetAttrOrder)
  const setConnOrder = useStore((s) => s.setConnOrder)
  const resetConnOrder = useStore((s) => s.resetConnOrder)

  if (!nodeId) return <div className="det-empty">&larr; Select a node</div>
  const nd = graph.nodes[nodeId]
  if (!nd) return <div className="det-empty">Node not found</div>

  const attrs = nd.a || {}
  // One master order across ALL attributes (short + long-text), so a saved
  // custom order survives regardless of which values happen to be long
  // enough to render as a quote block. mainAttrs-listed keys first (in
  // their given order), then anything else alphabetically. Shared with the
  // hover quick-info card, which must show the same attributes first.
  const orderedKeys = orderedAttrKeys(schema, nd)

  const shortRows = []
  const longTexts = []
  orderedKeys.forEach((k) => {
    const v = attrs[k]
    if (String(v).length > LONG_THRESHOLD) longTexts.push([k, v])
    else shortRows.push([k, v])
  })

  // Moves are confined to the item's own visual bucket (the short dl-row
  // grid, or the long-text quote blocks) since those always render as two
  // separate sections -- reordering across the boundary wouldn't visibly
  // move anything. Both buckets share one saved order, so a move just
  // reshuffles that bucket's members within the master list.
  function moveAttr(key, direction, bucket) {
    const bucketKeys = (bucket === 'short' ? shortRows : longTexts).map(([k]) => k)
    const idx = bucketKeys.indexOf(key)
    const swapIdx = idx + direction
    if (idx < 0 || swapIdx < 0 || swapIdx >= bucketKeys.length) return
    const swapped = [...bucketKeys]
    ;[swapped[idx], swapped[swapIdx]] = [swapped[swapIdx], swapped[idx]]
    let bi = 0
    const newOrder = orderedKeys.map((k) => (bucketKeys.includes(k) ? swapped[bi++] : k))
    setAttrOrder(nd.t, newOrder)
  }

  const out = nd.o || {}
  const inc = nd.i || {}
  const hasNeighbors = Object.keys(out).length || Object.keys(inc).length

  // Connection/neighbor groups, in a user-customizable order (per node
  // type, like the attribute order above). Default order matches the
  // previous fixed behavior: all outgoing groups (alphabetical), then all
  // incoming groups (alphabetical).
  const rawConnGroups = [
    ...Object.keys(out).map((etype) => ({ key: 'o:' + etype, etype, dir: 'o', nodeIds: out[etype], dirSymbol: '→' })),
    ...Object.keys(inc).map((etype) => ({ key: 'i:' + etype, etype, dir: 'i', nodeIds: inc[etype], dirSymbol: '←' })),
  ]
  const savedConnOrder = prefs.connOrder[nd.t] || []
  const connSeen = new Set()
  const connGroups = []
  savedConnOrder.forEach((key) => {
    const g = rawConnGroups.find((r) => r.key === key)
    if (g && !connSeen.has(key)) { connGroups.push(g); connSeen.add(key) }
  })
  rawConnGroups
    .filter((g) => !connSeen.has(g.key))
    .sort((a, b) => DIR_RANK[a.dir] - DIR_RANK[b.dir] || a.etype.localeCompare(b.etype))
    .forEach((g) => connGroups.push(g))

  function moveConn(key, direction) {
    const order = connGroups.map((g) => g.key)
    const idx = order.indexOf(key)
    const swapIdx = idx + direction
    if (idx < 0 || swapIdx < 0 || swapIdx >= order.length) return
    ;[order[idx], order[swapIdx]] = [order[swapIdx], order[idx]]
    setConnOrder(nd.t, order)
  }

  function handleCopy() {
    const csv = neighborsToCsv(graph, nodeId)
    navigator.clipboard.writeText(csv).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      },
      () => window.prompt('Copy CSV:', csv.slice(0, 2000))
    )
  }

  return (
    <div className="det-inner">
      <div className="det-hdr">
        <h3>{nd.l}</h3>
        <Tag schema={schema} type={nd.t} />
        {/* Colors this ONE node everywhere it is drawn -- the type keeps its
            own color, which is set on the same kind of dot in der Übersicht. */}
        <NodeColorDot schema={schema} id={nodeId} type={nd.t} label="Colour" />
      </div>

      {orderedKeys.length > 1 && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 4 }}>
          {reordering && prefs.attrOrder[nd.t] && (
            <span className="copy-btn" onClick={() => resetAttrOrder(nd.t)}>&#8635; Default order</span>
          )}
          <span className="copy-btn" onClick={() => setReordering((r) => !r)}>
            {reordering ? '✔ Done' : '⇅ Edit order'}
          </span>
        </div>
      )}

      <dl className="dl">
        <dt>Node ID</dt>
        <dd><Value value={nodeId} noImage /></dd>
        {shortRows.map(([k, v], i) => (
          <Fragment key={k}>
            <dt>{humaniseKey(k)}</dt>
            <dd>
              <Value value={v} attrKey={k} />
              {reordering && (
                <span style={{ display: 'inline-flex', gap: 2, marginLeft: 8 }}>
                  <button type="button" className="copy-btn" disabled={i === 0} onClick={() => moveAttr(k, -1, 'short')} title="Move up">&#8593;</button>
                  <button type="button" className="copy-btn" disabled={i === shortRows.length - 1} onClick={() => moveAttr(k, 1, 'short')} title="Move down">&#8595;</button>
                </span>
              )}
            </dd>
          </Fragment>
        ))}
      </dl>

      {longTexts.map(([k, v], i) => (
        <div key={k}>
          <div className="det-quote-label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {humaniseKey(k)}
            {reordering && (
              <span style={{ display: 'inline-flex', gap: 2 }}>
                <button type="button" className="copy-btn" disabled={i === 0} onClick={() => moveAttr(k, -1, 'long')} title="Move up">&#8593;</button>
                <button type="button" className="copy-btn" disabled={i === longTexts.length - 1} onClick={() => moveAttr(k, 1, 'long')} title="Move down">&#8595;</button>
              </span>
            )}
          </div>
          <div className="det-quote"><Value value={v} attrKey={k} /></div>
        </div>
      ))}

      {hasNeighbors ? (
        <div className="sub">
          <h4>
            Connections
            <span className={'copy-btn' + (copied ? ' copied' : '')} onClick={handleCopy}>
              {copied ? '✔ Copied!' : '↘ Copy CSV'}
            </span>
          </h4>

          {connGroups.length > 1 && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 6 }}>
              {reorderingConn && prefs.connOrder[nd.t] && (
                <span className="copy-btn" onClick={() => resetConnOrder(nd.t)}>&#8635; Default order</span>
              )}
              <span className="copy-btn" onClick={() => setReorderingConn((r) => !r)}>
                {reorderingConn ? '✔ Done' : '⇅ Edit order'}
              </span>
            </div>
          )}

          {connGroups.map((g, i) => (
            <div key={g.key} style={{ display: 'flex', alignItems: 'flex-start', gap: 4 }}>
              {reorderingConn && (
                <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, marginTop: 2 }}>
                  <button type="button" className="copy-btn" disabled={i === 0} onClick={() => moveConn(g.key, -1)} title="Move up">&#8593;</button>
                  <button type="button" className="copy-btn" disabled={i === connGroups.length - 1} onClick={() => moveConn(g.key, 1)} title="Move down">&#8595;</button>
                </span>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <NeighborGroup graph={graph} schema={schema} etype={g.etype} nodeIds={g.nodeIds} dirSymbol={g.dirSymbol} onNavigate={onNavigate} />
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
