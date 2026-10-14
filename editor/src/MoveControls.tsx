import { fitScale, normalizeAngle, type Transform } from './transform';

interface Props {
  transform: Transform;
  onChange(t: Transform): void;
  /** Source size, for the zoom slider. */
  width: number;
  height: number;
  onFrame(mode: 'fit' | 'fill'): void;
}

/** Zoom and rotate sliders plus Fit, Fill, and Turn 90° buttons. */
export function MoveControls({ transform, onChange, width, height, onFrame }: Props) {
  const fit = fitScale(width, height);
  const zoom = Math.log2(transform.scale / fit);
  const degrees = Math.round((transform.rotation * 180) / Math.PI);

  return (
    <>
      <label>
        <span>Zoom</span>
        <input
          type="range"
          min={-2}
          max={3}
          step={0.01}
          value={Math.min(3, Math.max(-2, zoom))}
          onChange={(e) => onChange({ ...transform, scale: fit * 2 ** Number(e.target.value) })}
        />
      </label>
      <label>
        <span>Rotate {degrees}°</span>
        <input
          type="range"
          min={-180}
          max={180}
          step={1}
          value={degrees}
          onChange={(e) => onChange({ ...transform, rotation: (Number(e.target.value) * Math.PI) / 180 })}
        />
      </label>
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
      </div>
    </>
  );
}
