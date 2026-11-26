import { BACKDROPS, BACKDROP_LABEL, BACKDROP_ORIGIN, type Backdrop } from '../backdrops'
import { setPreference, usePreferences } from '../preferences'

// Each gradient as a split swatch, light side and dark side, painted by its own [data-backdrop].
function Swatch({ backdrop }: { backdrop: Backdrop }) {
  return (
    <span className="backdrop-swatch" data-backdrop={backdrop} aria-hidden="true">
      <span className="backdrop-swatch-half" data-scheme="light" />
      <span className="backdrop-swatch-half" data-scheme="dark" />
    </span>
  )
}

export function BackdropPicker({ labelId }: { labelId: string }) {
  const backdropMode = usePreferences((s) => s.backdropMode)
  const backdropPreset = usePreferences((s) => s.backdropPreset)
  return (
    <div className="palette-picker backdrop-picker" role="radiogroup" aria-labelledby={labelId}>
      {BACKDROPS.map((each) => {
        const name = BACKDROP_LABEL[each]
        return (
          <button
            key={each}
            type="button"
            role="radio"
            aria-checked={backdropMode === 'preset' && backdropPreset === each}
            className="palette-option"
            aria-label={name}
            title={BACKDROP_ORIGIN[each]}
            onClick={() => {
              setPreference('backdropPreset', each)
              setPreference('backdropMode', 'preset')
            }}
          >
            <Swatch backdrop={each} />
            <span className="palette-name">{name}</span>
          </button>
        )
      })}
    </div>
  )
}
