import { Component } from 'react'

// Keeps one broken view from costing the whole session.
//
// Every tab is mounted at once, so an exception anywhere in the tree unmounts
// the entire app -- a blank page, with the loaded graph gone and re-importing
// the file the only way back. That is a heavy price for a view that merely
// stumbled over one node, and it really happened: Leaflet threw on a stale
// container size when the map tab was opened with a node selected.
//
// The graph is the expensive thing here, not the view, so a failing view now
// says so in its own panel and leaves everything else standing. React has no
// hook form of this; an error boundary has to be a class.
export class ViewBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
    this.retry = () => this.setState({ error: null })
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    // Kept in the console in full: the message below is deliberately short,
    // but a bug report needs the stack.
    console.error(`View "${this.props.name}" crashed:`, error, info?.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className={this.props.className}>
        <div className="det-empty" style={{ flexDirection: 'column', gap: '.5rem', textAlign: 'center', padding: '1rem' }}>
          <div>The view “{this.props.name}” could not be displayed.</div>
          <div style={{ fontSize: '.7rem', color: 'var(--tx3)', fontFamily: "'IBM Plex Mono', monospace" }}>
            {String(error?.message || error)}
          </div>
          <button type="button" className="copy-btn" onClick={this.retry}>&#8635; Try again</button>
          <div style={{ fontSize: '.68rem', color: 'var(--tx3)' }}>
            The loaded graph and all other views are unaffected.
          </div>
        </div>
      </div>
    )
  }
}
