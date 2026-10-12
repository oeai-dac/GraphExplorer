// Maps a view key from lib/views.js to the component that renders it. Kept
// apart from the registry itself so lib/ stays free of React imports.
//
// The tab components take an `active` flag and fill their container, which is
// exactly what a Dashboard pane needs -- they are used here as-is, no
// dashboard-specific variants.

import { OverviewTab } from '../overview/OverviewTab'
import { ExplorerTab } from '../explorer/ExplorerTab'
import { GraphTab } from '../graph/GraphTab'
import { MatrixTab } from '../matrix/MatrixTab'
import { MapTab } from '../map/MapTab'
import { Scene3dTab } from '../scene3d/Scene3dTab'
import { TimelineTab } from '../timeline/TimelineTab'
import { ChartsTab } from '../charts/ChartsTab'

export const VIEW_COMPONENTS = {
  overview: OverviewTab,
  explore: ExplorerTab,
  graph: GraphTab,
  matrix: MatrixTab,
  map: MapTab,
  scene3d: Scene3dTab,
  timeline: TimelineTab,
  charts: ChartsTab,
}
