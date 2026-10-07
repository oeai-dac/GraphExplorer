import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../../store'
import { availableViewKeys } from '../../lib/views'
import {
  PRESETS,
  buildPreset,
  closePane,
  countPanes,
  setPaneView,
  setSplitRatio,
  splitPane,
  MAX_PANES,
} from '../../lib/dashboardLayout'
import { SplitView } from './SplitView'

// Read-modify-write against the store instead of through props: this keeps
// the `actions` object below referentially stable for the whole session,
// which is what lets DashboardPane's memo() actually bite during a drag.
function updateLayout(fn) {
  const s = useStore.getState()
  s.setDashboardLayout(fn(s.dashboardLayout))
}

const actions = {
  setView: (paneId, view) => updateLayout((t) => setPaneView(t, paneId, view)),
  split: (paneId, dir) => updateLayout((t) => splitPane(t, paneId, dir)),
  close: (paneId) => updateLayout((t) => closePane(t, paneId)),
  setRatio: (splitId, ratio) => updateLayout((t) => setSplitRatio(t, splitId, ratio)),
}

export function DashboardTab({ active }) {
  const graph = useStore((s) => s.graph)
  const layout = useStore((s) => s.dashboardLayout)
  const setDashboardLayout = useStore((s) => s.setDashboardLayout)

  // Every pane is a full view -- a Leaflet map, a ReactFlow canvas -- and the
  // classic tabs all stay mounted alongside. Building the arrangement only
  // once the user actually opens the Dashboard avoids paying for a second
  // copy of all that for people who never do. Once mounted it stays, so pane
  // state (map zoom, layer visibility) survives a trip to another tab.
  const [mounted, setMounted] = useState(active)
  useEffect(() => {
    if (active) setMounted(true)
  }, [active])

  const allowedViews = useMemo(() => availableViewKeys(graph), [graph])
  const paneCount = countPanes(layout)

  if (!graph) return null

  return (
    <div className={'panel dash-panel' + (active ? ' on' : '')} id="tab-dashboard">
      <div className="dash-bar">
        <span className="dash-bar-lbl">Layout</span>
        {PRESETS.map((p) => (
          <button
            key={p.key}
            className="dash-preset"
            onClick={() => {
              const next = buildPreset(p.key, allowedViews)
              if (next) setDashboardLayout(next)
            }}
            title="Replace layout"
          >
            {p.label}
          </button>
        ))}
        <span className="dash-hint">
          {paneCount} of {MAX_PANES} panes · selection and filters apply to all
        </span>
      </div>

      <div className="dash-root">
        {mounted && (
          <SplitView
            node={layout}
            graph={graph}
            active={active}
            canClose={paneCount > 1}
            actions={actions}
          />
        )}
      </div>
    </div>
  )
}
