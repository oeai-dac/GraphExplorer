import { fmt } from '../../lib/schema'

const MAX_ROWS = 20
const MAX_COLS = 12

const thStyle = {
  padding: '.35rem .5rem', fontSize: '.66rem', color: 'var(--tx3)', textTransform: 'uppercase',
  letterSpacing: '.04em', whiteSpace: 'nowrap', borderBottom: '1px solid var(--bd)',
  maxWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis',
}
const totalCellStyle = {
  textAlign: 'center', fontWeight: 600, color: 'var(--tx2)',
  borderLeft: '1px solid var(--bd)', borderTop: '1px solid var(--bd)',
}

/** Cross-tab grid for pivotCount() output -- rows x columns, cell shading
    by count (single accent hue, opacity scaled to the cell's share of the
    visible grid's max -- this is a magnitude encoding within ONE series
    per the dataviz method, not a categorical rainbow). Row/column totals
    on the edges; clicking a non-empty cell drills into the Explorer
    filtered to exactly that row+column combination. */
// Which rows/columns to drop is decided by their totals, the order to draw
// them by the caller's sort. Slicing the incoming order instead would, under
// "sort by category", show the alphabetically first 20 rows as if they were
// the whole table.
function capBySize(labels, totalOf, max) {
  if (labels.length <= max) return labels
  const keep = new Set([...labels].sort((a, b) => totalOf(b) - totalOf(a)).slice(0, max))
  return labels.filter((l) => keep.has(l))
}

export function PivotTable({ pivot, onCellClick }) {
  const rows = capBySize(pivot.rowLabels, pivot.rowTotal, MAX_ROWS)
  const cols = capBySize(pivot.colLabels, pivot.colTotal, MAX_COLS)
  const rowOverflow = pivot.rowLabels.length - rows.length
  const colOverflow = pivot.colLabels.length - cols.length

  if (!rows.length || !cols.length) return <div className="empty">No data for this selection</div>

  let max = 0
  for (const r of rows) for (const c of cols) max = Math.max(max, pivot.getCell(r, c))
  max = max || 1

  function cellStyle(count) {
    if (!count) return { background: 'transparent' }
    const alpha = 0.08 + 0.55 * (count / max)
    return { background: `rgba(31,141,166,${alpha.toFixed(2)})` }
  }

  return (
    <div>
      <div style={{ overflow: 'auto', border: '1px solid var(--bd)', borderRadius: 'var(--r)', background: 'var(--bg2)' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '.76rem' }}>
          <thead>
            <tr>
              <th style={thStyle} />
              {cols.map((c) => <th key={c} style={thStyle} title={c}>{c}</th>)}
              <th style={thStyle}>&Sigma;</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r}>
                <th style={{ ...thStyle, textAlign: 'left', position: 'sticky', left: 0, background: 'var(--bg2)' }} title={r}>{r}</th>
                {cols.map((c) => {
                  const count = pivot.getCell(r, c)
                  return (
                    <td
                      key={c}
                      style={{
                        ...cellStyle(count), textAlign: 'center', padding: '.35rem .5rem',
                        cursor: count && onCellClick ? 'pointer' : 'default',
                        borderLeft: '1px solid var(--bd)', borderTop: '1px solid var(--bd)',
                      }}
                      onClick={() => count && onCellClick?.(r, c)}
                      title={count ? `${r} × ${c}: ${fmt(count)}` : undefined}
                    >
                      {count || ''}
                    </td>
                  )
                })}
                <td style={totalCellStyle}>{fmt(pivot.rowTotal(r))}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th style={{ ...thStyle, textAlign: 'left' }}>&Sigma;</th>
              {cols.map((c) => <td key={c} style={totalCellStyle}>{fmt(pivot.colTotal(c))}</td>)}
              <td style={{ ...totalCellStyle, fontWeight: 700 }}>{fmt(pivot.grandTotal)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      {(rowOverflow > 0 || colOverflow > 0) && (
        <div style={{ fontSize: '.7rem', color: 'var(--tx3)', marginTop: '.5rem' }}>
          {rowOverflow > 0 && `+ ${fmt(rowOverflow)} more rows`}{rowOverflow > 0 && colOverflow > 0 && ' · '}
          {colOverflow > 0 && `+ ${fmt(colOverflow)} more columns`} not shown (showing the most frequent)
        </div>
      )}
    </div>
  )
}
