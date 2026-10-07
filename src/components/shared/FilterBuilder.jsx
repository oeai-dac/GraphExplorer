import { useMemo, useState } from 'react'
import { edgeLabel, humaniseKey } from '../../lib/schema'
import { distinctConnectionTargets, distinctAttrValues } from '../../lib/filters'

const CHIP_STYLE = { color: 'var(--gold)', borderColor: 'rgba(31,141,166,.4)', background: 'rgba(31,141,166,.08)' }

const SUMMARY_VALUES = 3

function summariseValues(values = []) {
  if (values.length <= SUMMARY_VALUES) return values.join(', ')
  return `${values.slice(0, SUMMARY_VALUES).join(', ')} … (+${values.length - SUMMARY_VALUES})`
}

/** Multi-value chip builder: type a value (datalist-suggested from
    `options` when available), Enter/+ adds it to the draft list, chips are
    individually removable before the condition itself is added. Used for
    connection conditions (always multi/OR) and for attr/idLabel conditions
    when the "ist eine von" operator is picked -- one component instead of
    a single-value input duplicated per kind, since "pick N values" is the
    same interaction everywhere it appears. */
function MultiValuePicker({ id, options, draftValues, onAdd, onRemove }) {
  const [text, setText] = useState('')

  function commit() {
    const v = text.trim()
    if (v && !draftValues.includes(v)) onAdd(v)
    setText('')
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 220 }}>
      <div style={{ display: 'flex', gap: 4 }}>
        <input
          className="si"
          placeholder="Add value…"
          value={text}
          list={id}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit() } }}
        />
        <button type="button" className="act-btn" onClick={commit}>+</button>
        <datalist id={id}>
          {options.map((v) => <option key={v} value={v} />)}
        </datalist>
      </div>
      {draftValues.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {draftValues.map((v) => (
            <span key={v} className="tag" style={CHIP_STYLE}>
              {v} <span style={{ cursor: 'pointer' }} onClick={() => onRemove(v)}>&times;</span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/** Reusable AND-condition builder, shared between the Explorer tab's
    advanced filter panel and the Charts tab's scope filter -- both need
    the exact same "pick a property, pick/derive a value" UI.

    `poolIds` scopes which values show up in the dropdowns (e.g. only
    Materials actually used by the currently-selected node type), not
    which nodes end up filtered -- that's the caller's job via
    applyConditions(graph, ids, conditions) using the returned list. */
export function FilterBuilder({ graph, schema, poolIds, conditions, onChange }) {
  const [kind, setKind] = useState('connection')
  const [field, setField] = useState('')
  const [op, setOp] = useState('contains')
  const [value, setValue] = useState('')
  const [valueTo, setValueTo] = useState('')
  const [draftValues, setDraftValues] = useState([])

  const attrKeys = useMemo(() => {
    const keys = new Set()
    for (const id of poolIds) {
      for (const k in (graph.nodes[id]?.a || {})) keys.add(k)
    }
    return [...keys].sort()
  }, [graph, poolIds])

  const connectionProps = useMemo(() => {
    const keys = new Set()
    for (const id of poolIds) {
      const nd = graph.nodes[id]
      if (!nd) continue
      Object.keys(nd.o || {}).forEach((k) => keys.add(k))
      Object.keys(nd.i || {}).forEach((k) => keys.add(k))
    }
    return [...keys].sort((a, b) => edgeLabel(schema, a).localeCompare(edgeLabel(schema, b)))
  }, [graph, poolIds, schema])

  const valueOptions = useMemo(() => {
    if (kind === 'connection' && field) return distinctConnectionTargets(graph, poolIds, field)
    if (kind === 'attr' && field) return distinctAttrValues(graph, poolIds, field)
    return []
  }, [kind, field, graph, poolIds])

  const isMulti = kind === 'connection' || op === 'in'

  function resetDraft() {
    setValue('')
    setValueTo('')
    setDraftValues([])
  }

  function addCondition() {
    if (!field) return
    if (kind === 'connection') {
      if (!draftValues.length) return
      onChange([...conditions, { kind, propKey: field, matchLabels: [...draftValues] }])
    } else if (op === 'in') {
      if (!draftValues.length) return
      onChange([...conditions, { kind, ...(kind === 'attr' ? { key: field } : { field }), op, values: [...draftValues] }])
    } else {
      if (op !== 'between' && !value) return
      if (op === 'between' && !value && !valueTo) return
      onChange([...conditions, { kind, ...(kind === 'attr' ? { key: field } : { field }), op, value, valueTo: op === 'between' ? valueTo : undefined }])
    }
    resetDraft()
  }

  function removeCondition(idx) {
    onChange(conditions.filter((_, i) => i !== idx))
  }

  function describeCondition(c) {
    if (c.kind === 'connection') return `${edgeLabel(schema, c.propKey)} = ${c.matchLabels.join(' or ')}`
    const label = c.kind === 'attr' ? humaniseKey(c.key) : (c.field === 'id' ? 'ID' : 'Label')
    // A date bucket clicked in the Charts tab arrives here as an "is one of"
    // over every raw date string in that bucket -- listing all of them would
    // turn the chip into a paragraph.
    if (c.op === 'in') return `${label} is one of: ${summariseValues(c.values)}`
    if (c.op === 'between') return `${label}: ${c.value || '…'} – ${c.valueTo || '…'}`
    if (c.op === 'equals') return `${label} = "${c.value}"`
    return `${label} contains "${c.value}"`
  }

  return (
    <div style={{ border: '1px solid var(--bd)', borderRadius: 'var(--r)', padding: '.7rem', background: 'var(--bg2)', marginBottom: '.9rem' }}>
      {conditions.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.4rem', marginBottom: '.6rem' }}>
          {conditions.map((c, i) => (
            <span key={i} className="tag" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, ...CHIP_STYLE }}>
              {describeCondition(c)}
              <span style={{ cursor: 'pointer' }} onClick={() => removeCondition(i)} title="Remove">&times;</span>
            </span>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: '.4rem', flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <select className="sl" value={kind} onChange={(e) => { setKind(e.target.value); setField(''); resetDraft() }}>
          <option value="connection">Connection</option>
          <option value="attr">Attribute</option>
          <option value="idLabel">ID/Label</option>
        </select>

        {kind === 'connection' && (
          <select className="sl" value={field} onChange={(e) => { setField(e.target.value); resetDraft() }}>
            <option value="">Choose property…</option>
            {connectionProps.map((p) => <option key={p} value={p}>{edgeLabel(schema, p)}</option>)}
          </select>
        )}
        {kind === 'attr' && (
          <select className="sl" value={field} onChange={(e) => { setField(e.target.value); resetDraft() }}>
            <option value="">Choose attribute…</option>
            {attrKeys.map((k) => <option key={k} value={k}>{humaniseKey(k)}</option>)}
          </select>
        )}
        {kind === 'idLabel' && (
          <select className="sl" value={field || 'label'} onChange={(e) => setField(e.target.value)}>
            <option value="label">Label</option>
            <option value="id">ID</option>
          </select>
        )}

        {kind !== 'connection' && (
          <select className="sl" value={op} onChange={(e) => { setOp(e.target.value); resetDraft() }}>
            <option value="contains">contains</option>
            <option value="equals">equals</option>
            <option value="in">is one of (multiple choice)</option>
            <option value="between">between</option>
          </select>
        )}

        {isMulti ? (
          <MultiValuePicker
            id="fb-multi-values"
            options={valueOptions}
            draftValues={draftValues}
            onAdd={(v) => setDraftValues((vs) => [...vs, v])}
            onRemove={(v) => setDraftValues((vs) => vs.filter((x) => x !== v))}
          />
        ) : op === 'between' ? (
          <>
            <input className="si" style={{ minWidth: 90 }} placeholder="from" value={value} onChange={(e) => setValue(e.target.value)} list={kind === 'attr' ? 'fb-values' : undefined} />
            <input className="si" style={{ minWidth: 90 }} placeholder="to" value={valueTo} onChange={(e) => setValueTo(e.target.value)} list={kind === 'attr' ? 'fb-values' : undefined} />
          </>
        ) : (
          <input className="si" style={{ minWidth: 140 }} placeholder="Value" value={value} onChange={(e) => setValue(e.target.value)} list={kind === 'attr' ? 'fb-values' : undefined} />
        )}
        {kind === 'attr' && !isMulti && (
          <datalist id="fb-values">
            {valueOptions.map((v) => <option key={v} value={v} />)}
          </datalist>
        )}

        {!isMulti && <button type="button" className="act-btn" onClick={addCondition}>+ Add</button>}
      </div>
      {isMulti && (
        <div style={{ marginTop: '.5rem' }}>
          <button type="button" className="act-btn" onClick={addCondition}>+ Add{draftValues.length > 0 ? ` (${draftValues.length})` : ''}</button>
        </div>
      )}
    </div>
  )
}
