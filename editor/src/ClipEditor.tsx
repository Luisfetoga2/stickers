import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FPS_CHOICES, MAX_SECONDS, makeAnimated } from './animate';
import { bridge } from './bridge';
import type { Clip } from './clip';
import { ClipCutout } from './clipCutout';
import { MoveControls } from './MoveControls';
import { Stage, type Tool } from './Stage';
import { centered, toSource, type Point, type Transform } from './transform';
import type { EditorProps } from './types';

const MIN_LENGTH = 0.2;
const DEFAULT_LENGTH = 4;

const TOOLS: Array<{ id: Tool; label: string }> = [
  { id: 'move', label: 'Move' },
  { id: 'erase', label: 'Erase' },
  { id: 'restore', label: 'Restore' },
];

function nearestFps(fps: number): number {
  return FPS_CHOICES.reduce((best, f) => (Math.abs(f - fps) < Math.abs(best - fps) ? f : best));
}

/** Trim, frame, cut out, and encode a video or GIF into an animated sticker. */
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
  const [working, setWorking] = useState<'cutout' | 'encode' | null>(null);
  const [cutout, setCutout] = useState<ClipCutout | null>(null);
  const [tool, setTool] = useState<Tool>('move');
  const [brushSize, setBrushSize] = useState(24);
  const abortRef = useRef<AbortController | null>(null);
  const shownIndex = useRef(0);
  const locked = busy || working !== null;

  useEffect(() => () => cutout?.dispose(), [cutout]);

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

  const paintCutout = useCallback(
    (c: ClipCutout, index: number) => {
      shownIndex.current = index;
      paint(c.render(index));
      setShownTime(c.times[index]);
    },
    [paint],
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

    if (cutout) {
      const began = performance.now() - cutout.indexAt(shownTime) * (1000 / cutout.fps);
      let last = -1;
      const tick = () => {
        if (stopped) return;
        const index = Math.floor(((performance.now() - began) / 1000) * cutout.fps) % cutout.count;
        if (index !== last) {
          last = index;
          paintCutout(cutout, index);
        }
        timer = window.setTimeout(tick, 15);
      };
      tick();
      return () => {
        stopped = true;
        clearTimeout(timer);
      };
    }

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
    // shownTime is only read when playback starts.
  }, [playing, clip, cutout, start, end, fps, paint, paintCutout]);

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

  const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

  const removeBackground = async () => {
    setPlaying(false);
    const controller = new AbortController();
    abortRef.current = controller;
    setWorking('cutout');
    const began = performance.now();
    try {
      const built = await ClipCutout.build(
        clip,
        start,
        end,
        fps,
        (jpeg) =>
          bridge.removeBackground(jpeg, (text) => {
            // Per-frame messages would hide the frame count. Only the one-time model download matters.
            if (text.startsWith('Downloading')) setStatus({ kind: 'info', text });
          }),
        ({ done, total, secondsPerFrame }) =>
          setStatus({
            kind: 'info',
            text: `Removing the background: frame ${done} of ${total}, ${secondsPerFrame.toFixed(2)} s per frame, about ${Math.ceil((total - done) * secondsPerFrame)} s left.`,
          }),
        controller.signal,
      );
      setCutout(built);
      paintCutout(built, 0);
      const seconds = ((performance.now() - began) / 1000).toFixed(1);
      setStatus({
        kind: 'ok',
        text: `Background removed from ${built.count} frames in ${seconds} s. Erase and Restore change every frame.`,
      });
    } catch (err) {
      setStatus(controller.signal.aborted ? { kind: 'info', text: 'Cancelled.' } : { kind: 'error', text: errorText(err) });
    } finally {
      abortRef.current = null;
      setWorking(null);
    }
  };

  const clearCutout = () => {
    setPlaying(false);
    setCutout(null);
    setTool('move');
    setStatus(null);
    show(start);
  };

  /** Maps a sticker point to a pixel of the cut-out frames. */
  const toFrame = (c: ClipCutout, p: Point): Point => {
    const s = toSource(transform, p, clip.width, clip.height);
    const k = c.width / clip.width;
    return { x: s.x * k, y: s.y * k };
  };
  const frameRadius = (c: ClipCutout) => (brushSize / transform.scale) * (c.width / clip.width);

  const onBrushStart = (p: Point) => {
    if (!cutout || tool === 'move') return;
    setPlaying(false);
    cutout.keep.snapshot();
    const f = toFrame(cutout, p);
    cutout.stroke(f, f, frameRadius(cutout), tool);
    paintCutout(cutout, shownIndex.current);
  };

  const onBrushMove = (from: Point, to: Point) => {
    if (!cutout || tool === 'move') return;
    cutout.stroke(toFrame(cutout, from), toFrame(cutout, to), frameRadius(cutout), tool);
    paintCutout(cutout, shownIndex.current);
  };

  const undo = () => {
    if (cutout?.keep.undo()) paintCutout(cutout, shownIndex.current);
  };

  const add = async () => {
    setPlaying(false);
    const controller = new AbortController();
    abortRef.current = controller;
    setWorking('encode');
    try {
      const source = cutout ? cutout.asSource(clip.width, clip.height) : clip;
      const animated = await makeAnimated(
        source,
        transform,
        start,
        end,
        fps,
        (text) => setStatus({ kind: 'info', text }),
        controller.signal,
      );
      await onAdd(animated.blob, true);
    } catch (err) {
      setStatus(controller.signal.aborted ? { kind: 'info', text: 'Cancelled.' } : { kind: 'error', text: errorText(err) });
    } finally {
      abortRef.current = null;
      setWorking(null);
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
        tool={cutout ? tool : 'move'}
        brushSize={brushSize}
        onBrushStart={onBrushStart}
        onBrushMove={onBrushMove}
      />

      <div className="row playbar">
        <button className="secondary" onClick={() => setPlaying((p) => !p)} disabled={locked}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <p className="hint">
          {shownTime.toFixed(2)} s of {clip.duration.toFixed(1)} s.{' '}
          {cutout && tool !== 'move'
            ? 'One finger paints on every frame. Two fingers move and zoom.'
            : 'Drag to move. Pinch to zoom and rotate.'}
        </p>
      </div>

      <div className="row">
        {cutout ? (
          <button className="ghost grow" onClick={clearCutout} disabled={locked}>
            Bring back the background
          </button>
        ) : (
          <button className="secondary grow" onClick={removeBackground} disabled={locked}>
            Remove background
          </button>
        )}
        {cutout && (
          <button className="ghost" onClick={undo} disabled={!cutout.keep.canUndo || locked}>
            Undo
          </button>
        )}
      </div>

      {cutout && (
        <div className="segmented" role="tablist">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tool === t.id}
              className={tool === t.id ? 'on' : ''}
              onClick={() => setTool(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      <section className="controls">
        <label>
          <span>Start {start.toFixed(2)} s</span>
          <input
            type="range"
            min={0}
            max={clip.duration}
            step={0.01}
            value={start}
            disabled={locked || !!cutout}
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
            disabled={locked || !!cutout}
            onChange={(e) => changeEnd(Number(e.target.value))}
          />
        </label>
        <p className="hint">
          {cutout
            ? 'Trim and frame rate are locked while the background is removed. Bring the background back to change them.'
            : `Length ${length.toFixed(1)} s. WhatsApp allows up to ${MAX_SECONDS} s, and shorter clips look sharper.`}
        </p>
        <div className="segmented fps" role="tablist" aria-label="Frame rate">
          {FPS_CHOICES.map((f) => (
            <button
              key={f}
              role="tab"
              aria-selected={fps === f}
              className={fps === f ? 'on' : ''}
              disabled={locked || !!cutout}
              onClick={() => setFps(f)}
            >
              {f} fps
            </button>
          ))}
        </div>
      </section>

      <section className="controls">
        {cutout && tool !== 'move' ? (
          <label>
            <span>Brush {brushSize}</span>
            <input
              type="range"
              min={4}
              max={80}
              step={1}
              value={brushSize}
              onChange={(e) => setBrushSize(Number(e.target.value))}
            />
          </label>
        ) : (
          <MoveControls
            transform={transform}
            onChange={setTransform}
            width={clip.width}
            height={clip.height}
            onFrame={(mode) => setTransform(centered(clip.width, clip.height, mode))}
          />
        )}
      </section>

      {working ? (
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
