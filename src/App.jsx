import { useEffect, useRef } from 'react'
import { useStore } from './store'
import { Landing } from './components/Landing'
import { Header } from './components/Header'
import { Tabs } from './components/Tabs'
import { OverviewTab } from './components/overview/OverviewTab'
import { ExplorerTab } from './components/explorer/ExplorerTab'
import { GraphTab } from './components/graph/GraphTab'
import { MatrixTab } from './components/matrix/MatrixTab'
import { MapTab } from './components/map/MapTab'
import { TimelineTab } from './components/timeline/TimelineTab'
import { ChartsTab } from './components/charts/ChartsTab'
import { SearchTab } from './components/search/SearchTab'
import { DashboardTab } from './components/dashboard/DashboardTab'
import { NodeHoverCard } from './components/shared/NodeHoverCard'
import { ViewBoundary } from './components/shared/ViewBoundary'

export default function App() {
  const graph = useStore((s) => s.graph)
  const activeTab = useStore((s) => s.activeTab)
  const setActiveTab = useStore((s) => s.setActiveTab)
  const trail = useStore((s) => s.trail)
  const navigateBack = useStore((s) => s.navigateBack)
  const loadGraph = useStore((s) => s.loadGraph)
  const searchInputRef = useRef(null)

  // Accept data pushed via postMessage (from a future OntoCartographer Studio "Explore" button)
  useEffect(() => {
    function handler(e) {
      if (e.data && e.data.type === 'graph-explorer-load') {
        try {
          loadGraph(e.data.graph)
        } catch (err) {
          console.error('postMessage load error:', err)
        }
      }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [loadGraph])

  // Keyboard shortcuts: Escape = back, "/" or Ctrl+K = focus search
  useEffect(() => {
    function handler(e) {
      if (!graph) return
      const isInput = document.activeElement?.tagName === 'INPUT'
      if (e.key === 'Escape') {
        if (isInput) {
          document.activeElement.blur()
          return
        }
        if (trail.length > 1) {
          navigateBack()
          e.preventDefault()
        }
      }
      if ((e.key === '/' || (e.ctrlKey && e.key === 'k')) && !isInput) {
        e.preventDefault()
        setActiveTab('search')
        setTimeout(() => searchInputRef.current?.focus(), 0)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [graph, trail, navigateBack, setActiveTab])

  if (!graph) return <Landing />

  // Each view gets its own error boundary: they are all mounted at the same
  // time, so without one a single stumbling view takes the loaded graph with
  // it (see components/shared/ViewBoundary.jsx). The boundary's fallback
  // stands in for the view's own `.panel`, hence the same active class.
  const is = (tab) => activeTab === tab
  const panelClass = (tab) => 'panel' + (is(tab) ? ' on' : '')

  return (
    <div id="app" className="show">
      <Header />
      <Tabs />
      <div className="content">
        <ViewBoundary name="Overview" className={panelClass('overview')}>
          <OverviewTab active={is('overview')} />
        </ViewBoundary>
        <ViewBoundary name="Explorer" className={panelClass('explore')}>
          <ExplorerTab active={is('explore')} />
        </ViewBoundary>
        <ViewBoundary name="Graph" className={panelClass('graph')}>
          <GraphTab active={is('graph')} />
        </ViewBoundary>
        <ViewBoundary name="Matrix" className={panelClass('matrix')}>
          <MatrixTab active={is('matrix')} />
        </ViewBoundary>
        <ViewBoundary name="Map" className={panelClass('map')}>
          <MapTab active={is('map')} />
        </ViewBoundary>
        <ViewBoundary name="Timeline" className={panelClass('timeline')}>
          <TimelineTab active={is('timeline')} />
        </ViewBoundary>
        <ViewBoundary name="Charts" className={panelClass('charts')}>
          <ChartsTab active={is('charts')} />
        </ViewBoundary>
        <ViewBoundary name="Search" className={panelClass('search')}>
          <SearchTab active={is('search')} searchInputRef={searchInputRef} />
        </ViewBoundary>
        <ViewBoundary name="Dashboard" className={panelClass('dashboard')}>
          <DashboardTab active={is('dashboard')} />
        </ViewBoundary>
      </div>
      <NodeHoverCard />
    </div>
  )
}
