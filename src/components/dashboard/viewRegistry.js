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
import { TimelineTab } from '../timeline/TimelineTab'
import { ChartsTab } from '../charts/ChartsTab'
import { SearchTab } from '../search/SearchTab'

export const VIEW_COMPONENTS = {
  overview: OverviewTab,
  explore: ExplorerTab,
  graph: GraphTab,
  matrix: MatrixTab,
  map: MapTab,
  timeline: TimelineTab,
  charts: ChartsTab,
  search: SearchTab,
}
