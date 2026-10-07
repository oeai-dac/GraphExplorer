import { useId, useState } from 'react'
import { Dot } from '../shared/TypeTag'
import { nodeHoverProps } from '../shared/nodeHover'
import { edgeLabel, fmt } from '../../lib/schema'
import { isUrl, isImageUrl, isImageKey } from '../../lib/links'
import { getNodeSubline } from '../../lib/subline'

const SHOW = 8

// The image URL to embed for a neighbour, or null if it isn't an image.
// Signals, in order: the neighbour's id IS an image URL (the common case --
// an image link modelled as an edge whose TARGET NODE ID is the image URL,
// e.g. P1_is_identified_by "hat_bildlink" -> https://.../image/png); an image
// URL sits in one of the neighbour node's attributes; or the connection itself
// is named like an image link (e.g. "hat_bildlink") and the target is at least
// a URL (covers fully opaque image URLs with no extension/MIME segment).
function neighborImageSrc(nid, nn, imageEdge) {
  if (isImageUrl(nid)) return nid
  if (nn && nn.a) {
    for (const [k, v] of Object.entries(nn.a)) {
      if (isImageUrl(v) || (isImageKey(k) && isUrl(v))) return String(v)
    }
  }
  if (imageEdge && isUrl(nid)) return nid
  return null
}

// One neighbour row. Kept as its own component so each can hold its own
// image-load-failure state and fall back to the normal node row independently.
function NeighborItem({ graph, schema, nid, onNavigate, imgSrc }) {
  const [failed, setFailed] = useState(false)
  const nn = graph.nodes[nid]

  if (imgSrc && !failed) {
    // Clicking opens the full image in a new tab (image nodes are dead-ends,
    // so navigating into them isn't useful); on load error we fall back to
    // the normal, navigable node row so the link is never lost.
    return (
      <div className="nb-item nb-item-img">
        <a className="nb-img-link" href={imgSrc} target="_blank" rel="noopener noreferrer" title={(nn && nn.l) || imgSrc}>
          <img className="nb-img" src={imgSrc} alt={(nn && nn.l) || 'Bild'} loading="lazy" onError={() => setFailed(true)} />
        </a>
      </div>
    )
  }

  // Hovering a neighbour shows its quick-info card, so following a lead no
  // longer means clicking away from the node you're reading. An id the graph
  // doesn't carry has nothing to preview.
  //
  // The second line shows what the neighbour actually holds. Dependent nodes
  // (a Time-Span whose label IS its id) carry their content only in attributes
  // -- without this line a find's dating reads as a bare identifier, and the
  // year is only reachable by navigating into the node.
  const sub = nn ? getNodeSubline(schema, nn) : ''
  return (
    <div className="nb-item" onClick={() => onNavigate(nid)} {...nodeHoverProps(nid, !!nn)}>
      {nn ? (
        <>
          <Dot schema={schema} type={nn.t} id={nid} />
          <span className="nb-item-main">
            <span className="nb-item-label">{nn.l}</span>
            {sub && <span className="nb-item-sub">{sub}</span>}
          </span>
          <span className="nb-item-id">{nid}</span>
        </>
      ) : (
        <span className="nb-item-id">{nid}</span>
      )}
    </div>
  )
}

export function NeighborGroup({ graph, schema, etype, nodeIds, dirSymbol, onNavigate }) {
  const gid = useId()
  const [open, setOpen] = useState(true)
  const [expanded, setExpanded] = useState(false)
  const visible = expanded ? nodeIds : nodeIds.slice(0, SHOW)
  const imageEdge = isImageKey(edgeLabel(schema, etype))

  return (
    <div className="nb-group">
      <div className="nb-hdr" onClick={() => setOpen((o) => !o)}>
        <span className={'nb-arrow' + (open ? ' open' : '')}>&#9658;</span>
        <span className="nb-label">{edgeLabel(schema, etype)}</span>
        <span className="nb-cnt">{fmt(nodeIds.length)}</span>
        <span className="nb-dir">{dirSymbol}</span>
      </div>
      {open && (
        <div className="nb-list">
          {visible.map((nid) => (
            <NeighborItem
              key={gid + nid}
              graph={graph}
              schema={schema}
              nid={nid}
              onNavigate={onNavigate}
              imgSrc={neighborImageSrc(nid, graph.nodes[nid], imageEdge)}
            />
          ))}
          {!expanded && nodeIds.length > SHOW && (
            <div className="nb-more" onClick={() => setExpanded(true)}>
              + {nodeIds.length - SHOW} more
            </div>
          )}
        </div>
      )}
    </div>
  )
}
