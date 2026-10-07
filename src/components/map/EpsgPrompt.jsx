import { useState } from 'react'

/**
 * Asks for the CRS the loaded dataset's WKT coordinates are in. Required
 * because raw WKT never carries an SRID here (no "SRID=32635;..." prefix in
 * the source data) -- guessing would risk silently placing geometries in
 * the wrong place on the map.
 */
export function EpsgPrompt({ onSubmit, error }) {
  const [value, setValue] = useState('')

  const submit = () => {
    if (value.trim()) onSubmit(value.trim())
  }

  return (
    <div className="det-empty" style={{ flexDirection: 'column', gap: '1rem', padding: '2rem' }}>
      <div style={{ maxWidth: 460, textAlign: 'center' }}>
        <p style={{ color: 'var(--tx)', marginBottom: '.6rem', fontSize: '.9rem' }}>
          Coordinate reference system of the geodata
        </p>
        <p style={{ fontSize: '.78rem', lineHeight: 1.6, marginBottom: '1rem' }}>
          The WKT coordinates in this dataset do not state their coordinate system.
          Please enter the EPSG code (e.g. <code>32635</code> for UTM zone 35N) so that the geometries
          can be placed correctly on the map.
        </p>
        <div className="frow" style={{ justifyContent: 'center' }}>
          <input
            className="si"
            style={{ maxWidth: 220, textAlign: 'center' }}
            placeholder="e.g. 32635 or EPSG:32635"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
            autoFocus
          />
          <button className="act-btn" onClick={submit}>Apply</button>
        </div>
        {error && <div className="err" style={{ marginTop: '.8rem' }}>{error}</div>}
        <p style={{ fontSize: '.68rem', color: 'var(--tx3)', marginTop: '1.2rem' }}>
          Unknown code? Copy the matching proj4 definition from <span style={{ color: 'var(--tx2)' }}>epsg.io</span>
          (it starts with <code>+proj=</code>) and paste it here.
        </p>
      </div>
    </div>
  )
}
