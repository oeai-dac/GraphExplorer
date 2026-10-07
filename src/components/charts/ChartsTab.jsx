import { useMemo, useState } from 'react'
import { useStore } from '../../store'
import { fmt, typeLabel } from '../../lib/schema'
import { applyConditions } from '../../lib/filters'
import {
  DATE_BUCKETS,
  DEFAULT_DATE_BUCKET,
  NO_VALUE,
  conditionForCategory,
  dimForProperty,
  groupAndCount,
  listChartProperties,
  pivotCount,
} from '../../lib/chartData'
import { FilterBuilder } from '../shared/FilterBuilder'
import { BarChart } from './BarChart'
import { PivotTable } from './PivotTable'

// One picker per axis: which property to group by, plus -- only for
// properties whose values are dates -- how finely to bucket them.
function PropertyPicker({ label, propId, bucket, prop, properties, onPropChange, onBucketChange }) {
  return (
    <div className="frow chart-ctl">
      <span className="chart-ctl-lbl">{label}</span>
      <select
        className="sl"
        value={prop ? propId : ''}
        title="The number in brackets shows how many of the nodes in scope have a value for this property."
        onChange={(e) => onPropChange(e.target.value)}
      >
        <option value="">Choose property…</option>
        {properties.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label} ({fmt(p.coverage)})
          </option>
        ))}
      </select>
      {prop?.temporal && (
        <select className="sl" value={bucket} onChange={(e) => onBucketChange(e.target.value)} title="Time resolution">
          {DATE_BUCKETS.map((b) => (
            <option key={b.key} value={b.key}>{b.label}</option>
          ))}
        </select>
      )}
    </div>
  )
}

// Plain-language description of one axis, assembled from the actual
// selection -- a fixed example sentence would name properties the loaded
// graph may not even have.
function describeDim(prop, bucket) {
  if (!prop) return null
  if (prop.kind === 'connection') return `the linked node via “${prop.label}”`
  if (prop.temporal && bucket) {
    return `“${prop.label}”, grouped ${DATE_BUCKETS.find((b) => b.key === bucket)?.label}`
  }
  return `the value of “${prop.label}”`
}

export function ChartsTab({ active, domId = 'tab-charts' }) {
  const graph = useStore((s) => s.graph)
  const schema = useStore((s) => s.schema)
  const nodeIds = useStore((s) => s.nodeIds)
  const typeIndex = useStore((s) => s.typeIndex)
  const openExplorerWithFilter = useStore((s) => s.openExplorerWithFilter)

  const [type, setType] = useState('')
  const [conditions, setConditions] = useState([])
  const [chartType, setChartType] = useState('bar')
  const [sortMode, setSortMode] = useState('count')
  const [rowPropId, setRowPropId] = useState('')
  const [rowBucket, setRowBucket] = useState('')
  const [colPropId, setColPropId] = useState('')
  const [colBucket, setColBucket] = useState('')

  const types = useMemo(() => Object.keys(graph?.node_types || typeIndex || {}).sort(), [graph, typeIndex])
  const typePool = useMemo(() => (type ? typeIndex[type] || [] : nodeIds), [type, typeIndex, nodeIds])

  const scopedIds = useMemo(() => {
    if (!graph) return []
    return applyConditions(graph, typePool, conditions)
  }, [graph, typePool, conditions])

  const properties = useMemo(() => (graph ? listChartProperties(graph, typePool, schema) : []), [graph, typePool, schema])

  const rowProp = properties.find((p) => p.id === rowPropId) || null
  const colProp = properties.find((p) => p.id === colPropId) || null
  const rowBy = useMemo(() => dimForProperty(rowProp, rowBucket), [rowProp, rowBucket])
  const colBy = useMemo(() => dimForProperty(colProp, colBucket), [colProp, colBucket])

  const chartData = useMemo(() => {
    if (chartType !== 'bar' || !graph || !rowBy || !scopedIds.length) return []
    return groupAndCount(graph, scopedIds, rowBy, { sort: sortMode })
  }, [chartType, graph, rowBy, scopedIds, sortMode])

  const pivotData = useMemo(() => {
    if (chartType !== 'pivot' || !graph || !rowBy || !colBy || !scopedIds.length) return null
    return pivotCount(graph, scopedIds, rowBy, colBy, { sort: sortMode })
  }, [chartType, graph, rowBy, colBy, scopedIds, sortMode])

  if (!graph) return null

  // A date property starts out bucketed: grouping raw date strings produces
  // one category per distinct spelling, which is never what anyone wants.
  function pickProp(id, setId, setBucket) {
    setId(id)
    setBucket(properties.find((p) => p.id === id)?.temporal ? DEFAULT_DATE_BUCKET : '')
  }

  function resetScope(nextType) {
    setType(nextType)
    setConditions([])
    setRowPropId('')
    setRowBucket('')
    setColPropId('')
    setColBucket('')
  }

  // Re-expresses a bar as an Explorer filter: the chart's own scope and
  // conditions, plus one condition pinning down exactly that category.
  function handleBarClick(bucket) {
    const extra = conditionForCategory(graph, rowBy, bucket.label, bucket.ids)
    if (!extra) return
    openExplorerWithFilter(type, [...conditions, extra])
  }

  function handlePivotCellClick(rowLabel, colLabel) {
    const ids = pivotData.getCellIds(rowLabel, colLabel)
    const extra = [
      conditionForCategory(graph, rowBy, rowLabel, ids),
      conditionForCategory(graph, colBy, colLabel, ids),
    ].filter(Boolean)
    openExplorerWithFilter(type, [...conditions, ...extra])
  }

  const scopeNoun = type ? `nodes of type “${typeLabel(schema, type)}”` : 'nodes'
  const explanation =
    chartType === 'bar'
      ? rowBy && `Counts ${fmt(scopedIds.length)} ${scopeNoun} by ${describeDim(rowProp, rowBucket)}.`
      : rowBy && colBy &&
        `Cross-tabulates ${fmt(scopedIds.length)} ${scopeNoun}: rows by ${describeDim(rowProp, rowBucket)}, columns by ${describeDim(colProp, colBucket)}.`

  // Warned about only once it is actually picked, rather than cluttering
  // every dropdown entry with a second number nobody asked for. A date
  // property that is being bucketed is fine -- the bucketing is the fix.
  const weakProp = [rowProp, chartType === 'pivot' ? colProp : null].find(
    (p) => p && p.poorGrouping && !(p.temporal && (p === rowProp ? rowBucket : colBucket))
  )

  const hasNoValueBucket =
    chartType === 'bar'
      ? chartData.some((d) => d.label === NO_VALUE)
      : !!pivotData && (pivotData.rowLabels.includes(NO_VALUE) || pivotData.colLabels.includes(NO_VALUE))

  return (
    <div className={'panel' + (active ? ' on' : '')} id={domId}>
      <div className="sec-hdr">
        <h2>Charts</h2>
        {chartType === 'bar' && chartData.length > 0 && (
          <span className="badge">{fmt(scopedIds.length)} nodes &middot; {fmt(chartData.length)} categories</span>
        )}
        {chartType === 'pivot' && pivotData && (
          <span className="badge">{fmt(scopedIds.length)} nodes &middot; {fmt(pivotData.rowLabels.length)} × {fmt(pivotData.colLabels.length)}</span>
        )}
      </div>

      <div className="frow chart-ctl">
        <span className="chart-ctl-lbl">Scope</span>
        <select className="sl" value={type} onChange={(e) => resetScope(e.target.value)}>
          <option value="">All nodes</option>
          {types.map((t) => <option key={t} value={t}>Only {typeLabel(schema, t)}</option>)}
        </select>
        <span className="chart-ctl-lbl">Display</span>
        <select className="sl" value={chartType} onChange={(e) => setChartType(e.target.value)}>
          <option value="bar">Bar chart</option>
          <option value="pivot">Pivot table (cross-tabulation)</option>
        </select>
        <span className="chart-ctl-lbl">Sort</span>
        <select className="sl" value={sortMode} onChange={(e) => setSortMode(e.target.value)}>
          <option value="count">by count</option>
          <option value="label">by label</option>
        </select>
      </div>

      <PropertyPicker
        label={chartType === 'pivot' ? 'Rows' : 'Group by'}
        propId={rowPropId} bucket={rowBucket} prop={rowProp} properties={properties}
        onPropChange={(id) => pickProp(id, setRowPropId, setRowBucket)}
        onBucketChange={setRowBucket}
      />
      {chartType === 'pivot' && (
        <PropertyPicker
          label="Columns"
          propId={colPropId} bucket={colBucket} prop={colProp} properties={properties}
          onPropChange={(id) => pickProp(id, setColPropId, setColBucket)}
          onBucketChange={setColBucket}
        />
      )}

      <div className="chart-note">
        {explanation || 'Choose a property — the number after it tells how many of the nodes in scope have a value for it.'}
      </div>
      {weakProp && (
        <div className="chart-warn">
          {weakProp.distinctCapped
            ? `“${weakProp.label}” has more than ${fmt(2000)} distinct values — only the most frequent are shown.`
            : `“${weakProp.label}” has a value of its own for almost every node (${fmt(weakProp.distinct)} distinct) — that gives almost only bars of height 1.`}
          {weakProp.temporal
            ? ' With a time resolution it becomes a meaningful chart.'
            : ' A narrower scope above may help.'}
        </div>
      )}

      <FilterBuilder graph={graph} schema={schema} poolIds={typePool} conditions={conditions} onChange={setConditions} />

      {chartType === 'bar' ? (
        !rowBy ? <div className="empty">Please choose a property to group by</div>
          : <BarChart data={chartData} total={scopedIds.length} onBarClick={handleBarClick} />
      ) : (
        !rowBy || !colBy ? <div className="empty">Please choose one property each for rows and columns</div>
          : pivotData ? <PivotTable pivot={pivotData} onCellClick={handlePivotCellClick} />
            : <div className="empty">No data for this selection</div>
      )}

      {hasNoValueBucket && (
        <div className="chart-note" style={{ marginTop: '.5rem' }}>
          “{NO_VALUE}” collects the nodes without a value. Not clickable — the filter has no equivalent for it.
        </div>
      )}
    </div>
  )
}
