import { useEffect, useRef, useState } from 'react'
import { fmt } from '../../lib/schema'

function LayerRow({ item, checked, onToggle, indent }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0', paddingLeft: indent ? 16 : 0, cursor: 'pointer' }}>
      <input type="checkbox" checked={checked} onChange={onToggle} style={{ margin: 0, flexShrink: 0 }} />
      <span style={{ width: 10, height: 10, borderRadius: 2, background: item.color, flexShrink: 0 }} />
      <span style={{ flex: 1, color: 'var(--tx)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }} title={item.label}>
        {item.label}
      </span>
      <span style={{ color: 'var(--tx3)', fontFamily: "'IBM Plex Mono', monospace", fontSize: '.66rem', flexShrink: 0 }}>{fmt(item.count)}</span>
    </label>
  )
}

// A categorized base layer's header: one master checkbox for all its
// sub-category children (indeterminate when only some are hidden), so
// toggling the whole "Einmessung Fund" group is still a single click even
// though it's now made of a dozen material sub-layers.
function GroupHeader({ label, total, allVisible, someVisible, onToggleAll }) {
  const ref = useRef(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = someVisible && !allVisible
  }, [someVisible, allVisible])
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0', cursor: 'pointer', fontWeight: 600 }}>
      <input ref={ref} type="checkbox" checked={allVisible} onChange={onToggleAll} style={{ margin: 0, flexShrink: 0 }} />
      <span style={{ flex: 1, color: 'var(--tx)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }} title={label}>
        {label}
      </span>
      <span style={{ color: 'var(--tx3)', fontFamily: "'IBM Plex Mono', monospace", fontSize: '.66rem', flexShrink: 0 }}>{fmt(total)}</span>
    </label>
  )
}

/** Custom layer toggle panel, replacing react-leaflet's built-in
    LayersControl -- that one only supports a flat overlay list, but a
    per-layer-categorized map needs a categorized layer's sub-values
    (e.g. every material) grouped/indented under their parent type instead
    of appearing as unrelated flat entries.
    `groups`: [{ key, label, color, count, children: [{key,label,color,count}] | null }]
    `hiddenKeys`: Set of currently-hidden layer keys (leaf keys only). */
export function LayerControlPanel({ groups, hiddenKeys, onToggle, onToggleGroup }) {
  const [collapsed, setCollapsed] = useState(false)

  return (
    <div
      style={{
        position: 'absolute', top: 10, right: 10, zIndex: 1000,
        background: 'var(--bg2)', border: '1px solid var(--bd)', borderRadius: 'var(--r)',
        boxShadow: '0 2px 8px rgba(0,0,0,.15)', fontSize: '.74rem',
        width: collapsed ? 34 : 240, maxHeight: collapsed ? 34 : 340,
        overflow: collapsed ? 'hidden' : 'auto',
      }}
    >
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '.4rem .5rem', cursor: 'pointer',
          borderBottom: collapsed ? 'none' : '1px solid var(--bd)', color: 'var(--tx)', fontWeight: 600,
        }}
        onClick={() => setCollapsed((c) => !c)}
        title={collapsed ? 'Show layers' : 'Hide layers'}
      >
        &#9776;{!collapsed && ' Layer'}
      </div>
      {!collapsed && (
        <div style={{ padding: '.4rem .5rem' }}>
          {groups.map((g) => (
            <div key={g.key} style={{ marginBottom: 3 }}>
              {g.children ? (
                <>
                  <GroupHeader
                    label={g.label}
                    total={g.count}
                    allVisible={g.children.every((c) => !hiddenKeys.has(c.key))}
                    someVisible={g.children.some((c) => !hiddenKeys.has(c.key))}
                    onToggleAll={() => onToggleGroup(g)}
                  />
                  {g.children.map((c) => (
                    <LayerRow key={c.key} item={c} checked={!hiddenKeys.has(c.key)} onToggle={() => onToggle(c.key)} indent />
                  ))}
                </>
              ) : (
                <LayerRow item={g} checked={!hiddenKeys.has(g.key)} onToggle={() => onToggle(g.key)} />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
