import { useEffect, useMemo, useState } from 'react';
import { FPS_CHOICES, MAX_SECONDS, makeAnimated, type Animated } from './animate';
import { bridge } from './bridge';
import type { Clip } from './clip';
import { kb } from './encode';
import { MoveControls } from './MoveControls';
import { Stage } from './Stage';
import { centered, type Transform } from './transform';
import type { EditorProps } from './types';

const MIN_LENGTH = 0.2;
const DEFAULT_LENGTH = 4;

interface Result {
  key: string;
  animated: Animated;
  url: string;
}

const noop = () => {};

function nearestFps(fps: number): number {
  return FPS_CHOICES.reduce((best, f) => (Math.abs(f - fps) < Math.abs(best - fps) ? f : best));
}

/** Trim, frame, and encode a video or GIF into an animated sticker. */
export function ClipEditor({ clip, busy, setStatus, onAdd }: EditorProps & { clip: Clip }) {
  const still = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = clip.width;
    c.height = clip.height;
    return c;
  }, [clip]);

  const [version, setVersion] = useState(0);
  const [transform, setTransform] = useState<Transform>(() => centered(clip.width, clip.height));
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(() => Math.min(clip.duration, DEFAULT_LENGTH));
  const [fps, setFps] = useState(() => nearestFps(clip.defaultFps));
  const [shownAt, setShownAt] = useState(0);
  const [making, setMaking] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const locked = busy || making;

  const key = JSON.stringify({ transform, start, end, fps });
  const fresh = result?.key === key ? result : null;

  // Shows the frame at shownAt. The still canvas keeps it while other frames are read.
  useEffect(() => {
    let cancelled = false;
    clip
      .frameAt(shownAt)
      .then((source) => {
        if (cancelled) return;
        const ctx = still.getContext('2d');
        if (!ctx) return;
        ctx.clearRect(0, 0, still.width, still.height);
        ctx.drawImage(source, 0, 0, still.width, still.height);
        setVersion((v) => v + 1);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [clip, still, shownAt]);

  useEffect(() => () => {
    if (result) URL.revokeObjectURL(result.url);
  }, [result]);

  const changeStart = (value: number) => {
    const s = Math.max(0, Math.min(value, clip.duration - MIN_LENGTH));
    const e = Math.min(Math.max(end, s + MIN_LENGTH), s + MAX_SECONDS, clip.duration);
    setStart(s);
    setEnd(e);
    setShownAt(s);
  };

  const changeEnd = (value: number) => {
    const e = Math.min(clip.duration, Math.max(value, MIN_LENGTH));
    const s = Math.max(0, Math.min(start, e - MIN_LENGTH), e - MAX_SECONDS);
    setEnd(e);
    setStart(s);
    setShownAt(Math.max(s, e - 0.05));
  };

  const make = async (): Promise<Result> => {
    if (fresh) return fresh;
    setMaking(true);
    try {
      const animated = await makeAnimated(clip, transform, start, end, fps, (text) =>
        setStatus({ kind: 'info', text }),
      );
      const next = { key, animated, url: URL.createObjectURL(animated.blob) };
      setResult(next);
      const lowered = animated.fps !== fps ? ` The frame rate went down to ${animated.fps} fps to fit 500 KB.` : '';
      setStatus({
        kind: 'ok',
        text: `${kb(animated.blob.size)}, ${animated.frames} frames at ${animated.fps} fps.${lowered}`,
      });
      return next;
    } finally {
      setMaking(false);
    }
  };

  const preview = async () => {
    try {
      await make();
    } catch (err) {
      setStatus({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  };

  const add = async () => {
    try {
      const r = await make();
      await onAdd(r.animated.blob, true);
    } catch (err) {
      setStatus({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  };

  const length = end - start;

  return (
    <>
      <Stage
        image={still}
        width={clip.width}
        height={clip.height}
        version={version}
        transform={transform}
        onChange={setTransform}
        tool="move"
        brushSize={0}
        onBrushStart={noop}
        onBrushMove={noop}
      />
      <p className="hint">
        {clip.kind === 'video' ? 'Video' : 'GIF'}, {clip.duration.toFixed(1)} s. Drag to move. Pinch to zoom and rotate.
      </p>

      <section className="controls">
        <label>
          <span>Start {start.toFixed(1)} s</span>
          <input
            type="range"
            min={0}
            max={clip.duration}
            step={0.05}
            value={start}
            disabled={locked}
            onChange={(e) => changeStart(Number(e.target.value))}
          />
        </label>
        <label>
          <span>End {end.toFixed(1)} s</span>
          <input
            type="range"
            min={0}
            max={clip.duration}
            step={0.05}
            value={end}
            disabled={locked}
            onChange={(e) => changeEnd(Number(e.target.value))}
          />
        </label>
        <p className="hint">
          Length {length.toFixed(1)} s. WhatsApp allows up to {MAX_SECONDS} s, and shorter clips look sharper.
        </p>
        <div className="segmented fps" role="tablist" aria-label="Frame rate">
          {FPS_CHOICES.map((f) => (
            <button
              key={f}
              role="tab"
              aria-selected={fps === f}
              className={fps === f ? 'on' : ''}
              disabled={locked}
              onClick={() => setFps(f)}
            >
              {f} fps
            </button>
          ))}
        </div>
      </section>

      <section className="controls">
        <MoveControls
          transform={transform}
          onChange={setTransform}
          width={clip.width}
          height={clip.height}
          onFrame={(mode) => setTransform(centered(clip.width, clip.height, mode))}
        />
      </section>

      {fresh && (
        <section className="result">
          <img src={fresh.url} alt="Preview of the animated sticker" />
          <p className="hint">This is the exact sticker that goes to WhatsApp.</p>
        </section>
      )}

      <div className="row">
        <button className="ghost" onClick={preview} disabled={locked || !!fresh}>
          Preview
        </button>
        <button className="primary add grow" onClick={add} disabled={locked}>
          {bridge.isNative ? 'Add to WhatsApp' : 'Download sticker'}
        </button>
      </div>
    </>
  );
}
