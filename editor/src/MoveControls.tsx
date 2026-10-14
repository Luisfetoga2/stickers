import { SliderField } from './SliderField';
import { fitScale, normalizeAngle, type Transform } from './transform';

interface Props {
  transform: Transform;
  onChange(t: Transform): void;
  /** Source size, for the zoom value. */
  width: number;
  height: number;
  onFrame(mode: 'fit' | 'fill'): void;
}

/** Zoom and rotate fields plus Fit, Fill, and Turn 90° buttons. Zoom is a percent of the Fit size. */
export function MoveControls({ transform, onChange, width, height, onFrame }: Props) {
  const fit = fitScale(width, height);
  const zoomPercent = (transform.scale / fit) * 100;
  const degrees = (transform.rotation * 180) / Math.PI;

  return (
    <>
      <SliderField
        label="Zoom %"
        value={zoomPercent}
        min={25}
        max={800}
        decimals={0}
        // The slider moves in powers of two, so small and large zooms are both easy to reach.
        toSlider={(v) => Math.log2(v / 100)}
        fromSlider={(p) => 100 * 2 ** p}
        sliderMin={-2}
        sliderMax={3}
        onChange={(v) => onChange({ ...transform, scale: (fit * v) / 100 })}
      />
      <SliderField
        label="Rotate °"
        value={degrees}
        min={-180}
        max={180}
        decimals={0}
        onChange={(v) => onChange({ ...transform, rotation: (v * Math.PI) / 180 })}
      />
      <div className="row">
        <button className="ghost" onClick={() => onFrame('fit')}>
          Fit
        </button>
        <button className="ghost" onClick={() => onFrame('fill')}>
          Fill
        </button>
        <button
          className="ghost"
          onClick={() => onChange({ ...transform, rotation: normalizeAngle(transform.rotation + Math.PI / 2) })}
        >
          Turn 90°
        </button>
        <button
          className={transform.flip ? 'secondary' : 'ghost'}
          aria-pressed={!!transform.flip}
          onClick={() => onChange({ ...transform, flip: !transform.flip })}
        >
          Flip
        </button>
      </div>
    </>
  );
}
