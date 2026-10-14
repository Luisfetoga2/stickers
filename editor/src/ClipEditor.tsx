import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FPS_CHOICES, MAX_SECONDS, makeAnimated } from './animate';
import { bridge } from './bridge';
import type { Clip } from './clip';
import { MoveControls } from './MoveControls';
import { Stage } from './Stage';
import { centered, type Transform } from './transform';
import type { EditorProps } from './types';

const MIN_LENGTH = 0.2;
const DEFAULT_LENGTH = 4;

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
  const [shownTime, setShownTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [making, setMaking] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const locked = busy || making;

  /** Copies a frame into the still canvas that the stage shows. */
  const paint = useCallback(
    (source: CanvasImageSource) => {
      const ctx = still.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, still.width, still.height);
      ctx.drawImage(source, 0, 0, still.width, still.height);
      setVersion((v) => v + 1);
    },
    [still],
  );

  // Shows the exact frame at a time. While a seek runs, only the newest request waits, so dragging stays responsive.
  const pendingTime = useRef<number | null>(null);
  const showing = useRef(false);
  const show = useCallback(
    (seconds: number) => {
      pendingTime.current = seconds;
      if (showing.current) return;
      showing.current = true;
      void (async () => {
        while (pendingTime.current !== null) {
          const t = pendingTime.current;
          pendingTime.current = null;
          try {
            paint(await clip.frameAt(t));
            setShownTime(t);
          } catch {
            // A failed seek leaves the last frame on screen.
          }
        }
        showing.current = false;
      })();
    },
    [clip, paint],
  );

  useEffect(() => {
    show(0);
  }, [show]);

  // Plays the trimmed clip in a loop inside the stage, at the chosen frame rate.
  // A timer drives it instead of requestAnimationFrame, which pauses in some embedded views.
  useEffect(() => {
    if (!playing) return;
    let timer = 0;
    let stopped = false;
    let restarting: Promise<void> | null = null;
    let lastIndex = -1;

    const restart = () => {
      lastIndex = -1;
      restarting = clip
        .play(start)
        .catch(() => {
          if (!stopped) setPlaying(false);
        })
        .finally(() => {
          restarting = null;
        });
    };

    const tick = () => {
      if (stopped) return;
      if (!restarting) {
        const t = clip.time();
        if (t >= end || t < start - 0.1) {
          restart();
        } else {
          const index = Math.floor((t - start) * fps);
          if (index !== lastIndex) {
            lastIndex = index;
            paint(clip.current());
            setShownTime(t);
          }
        }
      }
      timer = window.setTimeout(tick, 15);
    };

    restart();
    tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
      clip.pause();
    };
  }, [playing, clip, start, end, fps, paint]);

  const changeStart = (value: number) => {
    setPlaying(false);
    const s = Math.max(0, Math.min(value, clip.duration - MIN_LENGTH));
    const e = Math.min(Math.max(end, s + MIN_LENGTH), s + MAX_SECONDS, clip.duration);
    setStart(s);
    setEnd(e);
    show(s);
  };

  const changeEnd = (value: number) => {
    setPlaying(false);
    const e = Math.min(clip.duration, Math.max(value, MIN_LENGTH));
    const s = Math.max(0, Math.min(start, e - MIN_LENGTH), e - MAX_SECONDS);
    setEnd(e);
    setStart(s);
    // The last frame of the sticker starts one frame before the end.
    show(Math.max(s, e - 1 / fps));
  };

  const add = async () => {
    setPlaying(false);
    const controller = new AbortController();
    abortRef.current = controller;
    setMaking(true);
    try {
      const animated = await makeAnimated(
        clip,
        transform,
        start,
        end,
        fps,
        (text) => setStatus({ kind: 'info', text }),
        controller.signal,
      );
      await onAdd(animated.blob, true);
    } catch (err) {
      if (controller.signal.aborted) {
        setStatus({ kind: 'info', text: 'Cancelled.' });
      } else {
        setStatus({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      abortRef.current = null;
      setMaking(false);
    }
  };

  const cancel = () => abortRef.current?.abort();

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

      <div className="row playbar">
        <button className="secondary" onClick={() => setPlaying((p) => !p)} disabled={locked}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <p className="hint">
          {shownTime.toFixed(2)} s of {clip.duration.toFixed(1)} s. Drag to move. Pinch to zoom and rotate.
        </p>
      </div>

      <section className="controls">
        <label>
          <span>Start {start.toFixed(2)} s</span>
          <input
            type="range"
            min={0}
            max={clip.duration}
            step={0.01}
            value={start}
            disabled={locked}
            onChange={(e) => changeStart(Number(e.target.value))}
          />
        </label>
        <label>
          <span>End {end.toFixed(2)} s</span>
          <input
            type="range"
            min={0}
            max={clip.duration}
            step={0.01}
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

      {making ? (
        <button className="ghost add" onClick={cancel}>
          Cancel
        </button>
      ) : (
        <button className="primary add" onClick={add} disabled={locked}>
          {bridge.isNative ? 'Add to WhatsApp' : 'Download sticker'}
        </button>
      )}
    </>
  );
}
