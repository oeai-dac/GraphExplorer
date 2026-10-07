import { fmt } from '../../lib/schema'
import { NO_VALUE } from '../../lib/chartData'

const MAX_BARS = 30

// Share of the nodes in scope, not of the largest bar. A node with two
// materials is counted under both, so these can add up to more than 100% --
// which is the honest reading of "how many of the nodes have this value".
function percent(count, total) {
  if (!total) return ''
  return (count / total * 100).toLocaleString('en-US', { maximumFractionDigits: 1 }) + ' %'
}

/** Horizontal bar list for "count per category" -- reuses the app's existing
    .blist/.brow/.btrk/.bfill/.bcnt pattern (the Overview tab's distributions)
    instead of a bespoke chart component, for visual consistency. One accent
    color for the whole chart: this is a single series, and position plus the
    always-visible count already tell the bars apart, so color here would be
    decoration rather than meaning. */
export function BarChart({ data, total, onBarClick }) {
  if (!data.length) return <div className="empty">No data for this selection</div>

  // Which bars to drop is decided by size, in what order to draw them by the
  // caller's sort. Slicing the incoming order instead would, under "sort by
  // category", show the alphabetically first 30 -- an arbitrary sample
  // presented as if it were the whole picture.
  let shown = data
  let overflow = 0
  if (data.length > MAX_BARS) {
    const keep = new Set([...data].sort((a, b) => b.count - a.count).slice(0, MAX_BARS).map((d) => d.label))
    shown = data.filter((d) => keep.has(d.label))
    overflow = data.length - shown.length
  }
  const max = Math.max(...shown.map((d) => d.count), 1)

  return (
    <div style={{ overflowY: 'auto' }}>
      <div className="blist" style={{ gap: '.6rem' }}>
        {shown.map((d) => {
          const pct = ((d.count / max) * 100).toFixed(1)
          // "(kein Wert)" is the absence of a category, so it is muted and
          // inert rather than looking like every other, drillable bar.
          const empty = d.label === NO_VALUE
          return (
            <div
              key={d.label}
              className={'brow' + (onBarClick && !empty ? ' clickable' : '')}
              style={{ gridTemplateColumns: '1fr 3fr auto auto', opacity: empty ? 0.55 : 1 }}
              onClick={() => !empty && onBarClick?.(d)}
              title={empty ? `${d.label}: ${fmt(d.count)} — without a value` : `${d.label}: ${fmt(d.count)} — click to filter in the Explorer`}
            >
              <span className="blbl">{d.label}</span>
              <div className="btrk" style={{ height: 10 }}>
                <div className="bfill" style={{ width: pct + '%', background: empty ? 'var(--tx3)' : 'var(--gold)' }} />
              </div>
              <span className="bcnt">{fmt(d.count)}</span>
              <span className="bcnt bpct">{percent(d.count, total)}</span>
            </div>
          )
        })}
      </div>
      {overflow > 0 && (
        <div className="chart-note" style={{ marginTop: '.6rem' }}>
          + {fmt(overflow)} more categories not shown (showing the {MAX_BARS} most frequent)
        </div>
      )}
    </div>
  )
}
