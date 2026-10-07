import { Dot, Tag } from '../shared/TypeTag'
import { Pagination } from '../shared/Pagination'
import { nodeHoverProps } from '../shared/nodeHover'
import { getNodeSubline } from '../../lib/subline'

const PAGE = 50

export function NodeList({ graph, schema, ids, page, onPageChange, selectedId, onSelect }) {
  const pageIds = ids.slice(page * PAGE, (page + 1) * PAGE)
  const pages = Math.ceil(ids.length / PAGE)

  if (!pageIds.length) {
    return (
      <div className="lst">
        <div className="empty">No results</div>
      </div>
    )
  }

  return (
    <div className="lst" style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {pageIds.map((id) => {
          const nd = graph.nodes[id]
          const sub = getNodeSubline(schema, nd)
          return (
            <div
              key={id}
              className={'li' + (id === selectedId ? ' on' : '')}
              onClick={() => onSelect(id)}
              {...nodeHoverProps(id)}
            >
              <div className="li-top">
                <Dot schema={schema} type={nd.t} id={id} /> <strong>{nd.l}</strong>
              </div>
              <div className="li-meta">
                <Tag schema={schema} type={nd.t} />
              </div>
              {sub && <span className="li-sub">{sub}</span>}
            </div>
          )
        })}
      </div>
      <Pagination page={page} pages={pages} onChange={onPageChange} />
    </div>
  )
}

export { PAGE }
