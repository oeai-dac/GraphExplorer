import { useStore } from '../store'
import { fmt } from '../lib/schema'
import { availableViews } from '../lib/views'

// The Dashboard isn't a view in its own right -- it hosts the others -- so it
// lives here rather than in the shared registry, and always comes last.
const DASHBOARD_TAB = { key: 'dashboard', icon: '▦', tabLabel: 'Dashboard' }

export function Tabs() {
  const activeTab = useStore((s) => s.activeTab)
  const setActiveTab = useStore((s) => s.setActiveTab)
  const nodeIds = useStore((s) => s.nodeIds)
  const graph = useStore((s) => s.graph)

  // Matrix, Karte and Zeitstrahl only show up when the graph carries the data
  // they need -- see lib/views.js, which the Dashboard's pane picker reads too.
  const tabs = [...availableViews(graph), DASHBOARD_TAB]

  return (
    <nav className="tabs">
      {tabs.map((t) => (
        <button
          key={t.key}
          className={'tab' + (activeTab === t.key ? ' on' : '')}
          onClick={() => setActiveTab(t.key)}
        >
          {t.icon} {t.tabLabel}
          {t.key === 'explore' && <span className="tab-cnt">{fmt(nodeIds.length)}</span>}
        </button>
      ))}
    </nav>
  )
}
