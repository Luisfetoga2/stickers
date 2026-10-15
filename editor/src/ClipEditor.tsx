import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ANIMATED_LIMIT,
  FPS_CHOICES,
  MAX_SECONDS,
  QUALITIES,
  bestQuality,
  encodePrepared,
  fits,
  frameTimes,
  prepareAnimated,
  tooBigAtAnyLevel,
  type Prepared,
} from './animate';
import { bridge } from './bridge';
import { DEFAULT_CHROMA, chromaKey, detectKeyColor, toHex, type ChromaSettings } from './chroma';
import type { Clip } from './clip';
import { ClipCutout, workSize, type FrameSource } from './clipCutout';
import { Mask, ctx2d, newCanvas } from './mask';
import { MoveControls } from './MoveControls';
import { SliderField } from './SliderField';
import { Stage, type Tool } from './Stage';
import { followOffsets } from './follow';
import { strokePoints, trackObject } from './tapTrack';
import { LOOP_SCAN_FPS, LOOP_SEARCH_MARGIN, MIN_LOOP_SECONDS, THUMB_SIDE, describeLoop, findLoop, toThumb } from './loop';
import { centered, sourceDeltaToSticker, toSource, type Point, type Transform } from './transform';
import { kb } from './encode';
import type { EditorProps } from './types';

const MIN_LENGTH = 0.2;
const DEFAULT_LENGTH = 4;

/** How the background is removed: not at all, by color (green screen), or by ML Kit, frame by frame. */
type Matte = 'none' | 'chroma' | 'ai';

const TOOLS: Array<{ id: Tool; label: string }> = [
  { id: 'move', label: 'Move' },
  { id: 'erase', label: 'Erase' },
  { id: 'restore', label: 'Restore' },
];

/** After an AI cutout, Keep and Remove come first: they fix whole objects in every frame. */
const AI_TOOLS: Array<{ id: Tool; label: string }> = [
  { id: 'move', label: 'Move' },
  { id: 'keep', label: 'Keep' },
  { id: 'remove', label: 'Remove' },
  { id: 'erase', label: 'Erase' },
  { id: 'restore', label: 'Restore' },
];

/** Scribble points closer than this, in work pixels, add nothing. */
const SCRIBBLE_STEP = 4;

function nearestFps(fps: number): number {
  return FPS_CHOICES.reduce((best, f) => (Math.abs(f - fps) < Math.abs(best - fps) ? f : best));
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Scales a mask to another size, by nearest pixel. Magic Touch answers at the frame's size, so this rarely runs. */
function fitMask(data: Uint8Array, w: number, h: number, width: number, height: number): Uint8Array {
  if (w === width && h === height) return data;
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(h - 1, Math.floor((y * h) / height));
    for (let x = 0; x < width; x++) out[y * width + x] = data[sy * w + Math.min(w - 1, Math.floor((x * w) / width))];
  }
  return out;
}

/** The sharpness levels from lowest to highest, for the slider. */
const LEVELS_UP = [...QUALITIES].reverse();

function nearestLevel(q: number): number {
  return QUALITIES.reduce((best, level) => (Math.abs(level - q) < Math.abs(best - q) ? level : best));
}

/** The estimated size at the chosen sharpness, green when it fits and red when it does not. */
function SizeLine({ estimate }: { estimate: number }) {
  const ok = fits(estimate);
  return (
    <p className={`size-line ${ok ? 'ok' : 'error'}`}>
      About {kb(estimate)} of {kb(ANIMATED_LIMIT)}.{' '}
      {ok ? 'It fits.' : 'Too big. Lower the sharpness, the frame rate, or the length.'}
    </p>
  );
}

/** Trim, frame, remove the background of, and encode a video or GIF into an animated sticker. */
export function ClipEditor({ clip, busy, setStatus, onAdd }: EditorProps & { clip: Clip }) {
  const still = useMemo(() => newCanvas(clip.width, clip.height), [clip]);

  // Green screen and AI cutout work at a smaller size. `raw` holds the current frame before keying.
  const work = useMemo(() => {
    const { width, height } = workSize(clip.width, clip.height);
    const raw = newCanvas(width, height);
    const rawCtx = raw.getContext('2d', { willReadFrequently: true });
    const out = newCanvas(width, height);
    if (!rawCtx) throw new Error('Canvas is not available.');
    return { width, height, raw, rawCtx, out, outCtx: ctx2d(out), keep: new Mask(width, height) };
  }, [clip]);

  const [version, setVersion] = useState(0);
  const [transform, setTransform] = useState<Transform>(() => centered(clip.width, clip.height));
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(() => Math.min(clip.duration, DEFAULT_LENGTH));
  const [fps, setFps] = useState(() => nearestFps(clip.defaultFps));
  const [shownTime, setShownTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [working, setWorking] = useState<'cutout' | 'encode' | 'loop' | 'measure' | null>(null);
  const [matte, setMatte] = useState<Matte>('none');
  const [chroma, setChroma] = useState<ChromaSettings | null>(null);
  const [cutout, setCutout] = useState<ClipCutout | null>(null);
  const [tool, setTool] = useState<Tool>('move');
  const [follow, setFollow] = useState(false);
  /** The last Check size result, with the settings it belongs to. */
  const [prepared, setPrepared] = useState<{ key: string; data: Prepared } | null>(null);
  /** The chosen sharpness level, one of QUALITIES. Null means the sharpest level that fits. */
  const [quality, setQuality] = useState<number | null>(null);
  /** Goes up when the frames change in ways the other settings do not show, such as brush strokes. */
  const [contentVersion, setContentVersion] = useState(0);
  const [brushSize, setBrushSize] = useState(24);
  const [, setUndoVersion] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const shownIndex = useRef(0);
  const locked = busy || working !== null;

  useEffect(() => () => cutout?.dispose(), [cutout]);

  // The play loop and the encoder read the matte through this ref, so slider changes apply at once.
  const matteRef = useRef({ matte, chroma, cutout });
  matteRef.current = { matte, chroma, cutout };

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

  const applyKeep = useCallback(() => {
    const ctx = work.outCtx;
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(work.keep.canvas, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
  }, [work]);

  /** Keys the frame in `raw` with the current settings into `out`. */
  const keyFromRaw = useCallback((): HTMLCanvasElement => {
    const pixels = work.rawCtx.getImageData(0, 0, work.width, work.height);
    const settings = matteRef.current.chroma;
    if (settings) chromaKey(pixels.data, settings);
    work.outCtx.putImageData(pixels, 0, 0);
    applyKeep();
    return work.out;
  }, [work, applyKeep]);

  /** Turns a source frame, or a cut-out frame index, into what the sticker shows. */
  const processFrame = useCallback(
    (source: CanvasImageSource | null, index: number): CanvasImageSource => {
      const { matte: m, cutout: c } = matteRef.current;
      if (m === 'ai' && c) {
        work.outCtx.clearRect(0, 0, work.width, work.height);
        work.outCtx.drawImage(c.frame(index), 0, 0);
        applyKeep();
        return work.out;
      }
      if (!source) throw new Error('No frame to show.');
      if (m === 'chroma') {
        work.rawCtx.clearRect(0, 0, work.width, work.height);
        work.rawCtx.drawImage(source, 0, 0, work.width, work.height);
        return keyFromRaw();
      }
      return source;
    },
    [work, applyKeep, keyFromRaw],
  );

  // Shows the exact frame at a time. While a seek runs, only the newest request waits, so dragging stays responsive.
  const pendingTime = useRef<number | null>(null);
  const showing = useRef(false);
  const show = useCallback(
    (seconds: number) => {
      const c = matteRef.current.matte === 'ai' ? matteRef.current.cutout : null;
      if (c) {
        const index = c.indexAt(seconds);
        shownIndex.current = index;
        paint(processFrame(null, index));
        setShownTime(c.times[index]);
        return;
      }
      pendingTime.current = seconds;
      if (showing.current) return;
      showing.current = true;
      void (async () => {
        while (pendingTime.current !== null) {
          const t = pendingTime.current;
          pendingTime.current = null;
          try {
            paint(processFrame(await clip.frameAt(t), 0));
            setShownTime(t);
          } catch {
            // A failed seek leaves the last frame on screen.
          }
        }
        showing.current = false;
      })();
    },
    [clip, paint, processFrame],
  );

  /** Redraws the frame on screen after a matte or brush change, without seeking. */
  const repaint = useCallback(() => {
    const { matte: m } = matteRef.current;
    if (m === 'ai') paint(processFrame(null, shownIndex.current));
    else if (m === 'chroma') paint(keyFromRaw());
  }, [paint, processFrame, keyFromRaw]);

  useEffect(() => {
    show(0);
  }, [show]);

  useEffect(() => {
    if (!playing) repaint();
    // Repaint only when the green screen settings change.
  }, [chroma]);

  // Plays the trimmed clip in a loop inside the stage, at the chosen frame rate.
  // A timer drives it instead of requestAnimationFrame, which pauses in some embedded views.
  useEffect(() => {
    if (!playing) return;
    let timer = 0;
    let stopped = false;

    if (matte === 'ai' && cutout) {
      const began = performance.now() - shownIndex.current * (1000 / cutout.fps);
      let last = -1;
      const tick = () => {
        if (stopped) return;
        const index = Math.floor(((performance.now() - began) / 1000) * cutout.fps) % cutout.count;
        if (index !== last) {
          last = index;
          shownIndex.current = index;
          paint(processFrame(null, index));
          setShownTime(cutout.times[index]);
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
            paint(processFrame(clip.current(), 0));
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
  }, [playing, clip, matte, cutout, start, end, fps, paint, processFrame]);

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

  const startGreenScreen = async () => {
    setPlaying(false);
    try {
      const frame = await clip.frameAt(shownTime);
      work.rawCtx.clearRect(0, 0, work.width, work.height);
      work.rawCtx.drawImage(frame, 0, 0, work.width, work.height);
      const pixels = work.rawCtx.getImageData(0, 0, work.width, work.height);
      const key = detectKeyColor(pixels.data, work.width, work.height);
      matteRef.current = { ...matteRef.current, matte: 'chroma' };
      setMatte('chroma');
      setChroma({ ...DEFAULT_CHROMA, key });
      setContentVersion((v) => v + 1);
      setStatus({
        kind: 'ok',
        text: 'Green screen on. If the wrong color is gone, tap Pick color and tap the screen in the video.',
      });
    } catch (err) {
      setStatus({ kind: 'error', text: errorText(err) });
    }
  };

  const startAiCutout = async () => {
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
        ({ phase, done, total, secondsPerFrame, modelSecondsPerFrame }) =>
          setStatus({
            kind: 'info',
            text:
              phase === 'reading'
                ? `Reading frames: ${done} of ${total}…`
                : `AI cutout: frame ${done} of ${total}, ${secondsPerFrame.toFixed(2)} s per frame` +
              (modelSecondsPerFrame !== null ? ` (ML Kit ${modelSecondsPerFrame.toFixed(2)} s)` : '') +
              `, about ${Math.ceil((total - done) * secondsPerFrame)} s left.`,
          }),
        controller.signal,
      );
      matteRef.current = { ...matteRef.current, matte: 'ai', cutout: built };
      setCutout(built);
      setMatte('ai');
      setContentVersion((v) => v + 1);
      setTool('move');
      show(start);
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

  const turnOffMatte = () => {
    setPlaying(false);
    matteRef.current = { matte: 'none', chroma: null, cutout: null };
    setMatte('none');
    setChroma(null);
    setCutout(null);
    setTool('move');
    setFollow(false);
    history.current = [];
    work.keep.reset();
    setContentVersion((v) => v + 1);
    setStatus(null);
    show(matte === 'ai' ? start : shownTime);
  };

  // Follow the subject: each frame's content moves so the subject stays at its average position.
  const offsets = useMemo(() => {
    if (!cutout) return null;
    const k = work.width / clip.width;
    return followOffsets(cutout.centers).map((o) => ({ x: o.x / k, y: o.y / k }));
  }, [cutout, work, clip]);
  const following = follow && matte === 'ai' && offsets !== null;

  const followAt = useCallback(
    (index: number, base: Transform): Transform => {
      if (!offsets) return base;
      const o = offsets[Math.max(0, Math.min(offsets.length - 1, index))];
      const d = sourceDeltaToSticker(base, o.x, o.y);
      return { ...base, x: base.x + d.x, y: base.y + d.y };
    },
    [offsets],
  );

  const followIndex = cutout ? cutout.indexAt(shownTime) : 0;
  /** What the stage shows: the user's framing, moved for the frame on screen when following. */
  const displayTransform = following ? followAt(followIndex, transform) : transform;

  /** The stage reports moves in shown coordinates. The stored framing is the one without the follow shift. */
  const onStageChange = (t: Transform) => {
    if (!following || !offsets) {
      setTransform(t);
      return;
    }
    const o = offsets[followIndex];
    const d = sourceDeltaToSticker(t, o.x, o.y);
    setTransform({ ...t, x: t.x - d.x, y: t.y - d.y });
  };

  /** Maps a sticker point to a pixel of the work-size frames. */
  const toWork = (p: Point): Point => {
    const s = toSource(displayTransform, p, clip.width, clip.height);
    const k = work.width / clip.width;
    return { x: s.x * k, y: s.y * k };
  };
  const workRadius = () => (brushSize / transform.scale) * (work.width / clip.width);

  const pickColor = (p: Point) => {
    const f = toWork(p);
    const x = Math.round(Math.max(0, Math.min(work.width - 1, f.x)));
    const y = Math.round(Math.max(0, Math.min(work.height - 1, f.y)));
    const [r, g, b] = work.rawCtx.getImageData(x, y, 1, 1).data;
    setChroma((c) => (c ? { ...c, key: [r, g, b] } : c));
    setTool('move');
    setStatus({ kind: 'ok', text: `Screen color set to ${toHex([r, g, b])}.` });
  };

  /** The Keep or Remove scribble in progress, in work pixels. */
  const scribble = useRef<Point[]>([]);
  /** One undo list for brush strokes and Keep or Remove, newest last. */
  const history = useRef<Array<'brush' | 'object'>>([]);

  const onBrushStart = (p: Point) => {
    if (matte === 'none') return;
    if (tool === 'pick') {
      pickColor(p);
      return;
    }
    if (tool === 'keep' || tool === 'remove') {
      setPlaying(false);
      scribble.current = [toWork(p)];
      return;
    }
    if (tool !== 'erase' && tool !== 'restore') return;
    setPlaying(false);
    work.keep.snapshot();
    history.current.push('brush');
    setUndoVersion((v) => v + 1);
    setContentVersion((v) => v + 1);
    const f = toWork(p);
    work.keep.stroke(f, f, workRadius(), tool);
    repaint();
  };

  const onBrushMove = (from: Point, to: Point) => {
    if (tool === 'keep' || tool === 'remove') {
      const p = toWork(to);
      const last = scribble.current[scribble.current.length - 1];
      if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= SCRIBBLE_STEP) scribble.current.push(p);
      return;
    }
    if (matte === 'none' || (tool !== 'erase' && tool !== 'restore')) return;
    work.keep.stroke(toWork(from), toWork(to), workRadius(), tool);
    repaint();
  };

  const onBrushEnd = (completed: boolean) => {
    const points = scribble.current;
    scribble.current = [];
    if (completed && points.length > 0 && (tool === 'keep' || tool === 'remove')) void markObject(points, tool);
  };

  /**
   * Keep or Remove: Magic Touch finds the object under the scribble in the frame on screen,
   * then follows it through the other frames.
   */
  const markObject = async (points: Point[], mode: 'keep' | 'remove') => {
    if (!cutout) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setWorking('cutout');
    const verb = mode === 'keep' ? 'Keep' : 'Remove';
    try {
      const { width, height, count } = cutout;
      const began = performance.now();
      let modelMs = 0;
      let delegate = '';
      const frameCanvas = newCanvas(width, height);
      const frameCtx = ctx2d(frameCanvas);
      const result = await trackObject(
        count,
        cutout.indexAt(shownTime),
        points,
        width,
        height,
        async (i, framePoints) => {
          frameCtx.drawImage(cutout.source(i), 0, 0);
          const jpeg = await new Promise<Blob>((resolve, reject) =>
            frameCanvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not read a frame.'))), 'image/jpeg', 0.9),
          );
          const stroke = strokePoints(framePoints.map((p) => ({ x: p.x / width, y: p.y / height })));
          const result = await bridge.segmentObject(jpeg, stroke, (text) => setStatus({ kind: 'info', text }));
          modelMs += result.modelMs;
          delegate = result.delegate;
          return fitMask(result.mask, result.width, result.height, width, height);
        },
        (done) => {
          const perFrame = (performance.now() - began) / 1000 / done;
          setStatus({
            kind: 'info',
            text:
              `${verb}: frame ${done} of ${count}, ${perFrame.toFixed(2)} s per frame` +
              ` (Magic Touch ${(modelMs / 1000 / done).toFixed(2)} s on ${delegate}),` +
              ` about ${Math.ceil((count - done) * perFrame)} s left.`,
          });
        },
        controller.signal,
      );
      cutout.snapshot();
      history.current.push('object');
      cutout.applyObjects(result.masks, mode);
      setUndoVersion((v) => v + 1);
      setContentVersion((v) => v + 1);
      repaint();
      const missed = count - result.found;
      setStatus({
        kind: 'ok',
        text:
          `${mode === 'keep' ? 'Kept' : 'Removed'} it in ${result.found} of ${count} frames.` +
          (missed
            ? ' In the other frames it left the picture or changed too much. Go to one of them and mark it again.'
            : ''),
      });
    } catch (err) {
      setStatus(controller.signal.aborted ? { kind: 'info', text: 'Cancelled.' } : { kind: 'error', text: errorText(err) });
    } finally {
      abortRef.current = null;
      setWorking(null);
    }
  };

  const undo = () => {
    const last = history.current.pop();
    const undone = last === 'object' ? cutout?.undo() : work.keep.undo();
    if (undone) {
      setUndoVersion((v) => v + 1);
      setContentVersion((v) => v + 1);
      repaint();
    }
  };

  /** The frames as the sticker shows them: plain, keyed, or cut out, and moved when following. */
  const buildSource = (): FrameSource =>
    matte === 'none'
      ? clip
      : {
          width: clip.width,
          height: clip.height,
          frameAt: async (t) =>
            matte === 'ai' && cutout ? processFrame(null, cutout.indexAt(t)) : processFrame(await clip.frameAt(t), 0),
          // Green screen keys each frame as the clip plays through.
          readFrames:
            matte === 'chroma'
              ? (times, onFrame, signal) =>
                  clip.readFrames(times, (frame, i) => onFrame(processFrame(frame, 0), i), signal)
              : undefined,
          transformAt: following && cutout ? (t, base) => followAt(cutout.indexAt(t), base) : undefined,
        };

  // Everything that changes the sticker's frames. A Check size result is only valid for the same key.
  const settingsKey = JSON.stringify({ transform, start, end, fps, matte, chroma, follow, contentVersion });
  const fresh = prepared?.key === settingsKey ? prepared.data : null;
  useEffect(() => () => prepared?.data.dispose(), [prepared]);

  const prepare = async (signal: AbortSignal): Promise<Prepared> => {
    const data = await prepareAnimated(
      buildSource(),
      transform,
      start,
      end,
      fps,
      (text) => setStatus({ kind: 'info', text }),
      signal,
    );
    setPrepared({ key: settingsKey, data });
    return data;
  };

  /** Runs a task that reads the clip, with Cancel, and shows the current frame again after it. */
  const runTask = async (kind: 'encode' | 'measure', task: (signal: AbortSignal) => Promise<void>) => {
    setPlaying(false);
    const controller = new AbortController();
    abortRef.current = controller;
    setWorking(kind);
    try {
      await task(controller.signal);
    } catch (err) {
      setStatus(controller.signal.aborted ? { kind: 'info', text: 'Cancelled.' } : { kind: 'error', text: errorText(err) });
    } finally {
      abortRef.current = null;
      setWorking(null);
      // Reading reused the work canvases and moved the video, so show the current frame again.
      show(shownTime);
    }
  };

  const checkSize = () =>
    runTask('measure', async (signal) => {
      const data = await prepare(signal);
      const best = bestQuality(data.estimates);
      setQuality(best ?? QUALITIES[QUALITIES.length - 1]);
      setStatus(
        best === null
          ? { kind: 'error', text: tooBigAtAnyLevel(data) }
          : {
              kind: 'ok',
              text: `At ${fps} fps, the sharpest level that fits is ${Math.round(best * 100)}%. Move Sharpness to see other sizes.`,
            },
      );
    });

  const add = () =>
    runTask('encode', async (signal) => {
      const data = fresh ?? (await prepare(signal));
      // After Check size, use the level the user chose. Otherwise, the sharpest level that fits.
      const level = fresh && quality !== null ? quality : bestQuality(data.estimates);
      if (!fresh) setQuality(level ?? QUALITIES[QUALITIES.length - 1]);
      if (level === null) {
        setStatus({ kind: 'error', text: tooBigAtAnyLevel(data) });
        return;
      }
      const animated = await encodePrepared(data, level, (text) => setStatus({ kind: 'info', text }), signal);
      await onAdd(animated.blob, true);
    });

  const cancel = () => abortRef.current?.abort();

  /** Reads small thumbnails around the trim and moves Start and End to the two frames that match best. */
  const findLoopPoint = async () => {
    setPlaying(false);
    const controller = new AbortController();
    abortRef.current = controller;
    setWorking('loop');
    try {
      const times = frameTimes(
        Math.max(0, start - LOOP_SEARCH_MARGIN),
        Math.min(clip.duration, end + LOOP_SEARCH_MARGIN),
        LOOP_SCAN_FPS,
      );
      const scale = THUMB_SIDE / Math.max(clip.width, clip.height);
      const thumb = newCanvas(Math.max(1, Math.round(clip.width * scale)), Math.max(1, Math.round(clip.height * scale)));
      const ctx = thumb.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('Canvas is not available.');
      const thumbs: Uint8Array[] = [];
      await clip.readFrames(
        times,
        (frame, i) => {
          if (i % 10 === 0) setStatus({ kind: 'info', text: `Looking for a loop: frame ${i + 1} of ${times.length}…` });
          ctx.clearRect(0, 0, thumb.width, thumb.height);
          // With a green screen, compare the keyed frames, so the subject's shape counts and the screen does not.
          ctx.drawImage(matte === 'chroma' ? processFrame(frame, 0) : frame, 0, 0, thumb.width, thumb.height);
          thumbs.push(toThumb(ctx.getImageData(0, 0, thumb.width, thumb.height).data));
        },
        controller.signal,
      );
      const loop = findLoop(thumbs, times, MIN_LOOP_SECONDS, MAX_SECONDS, end - start);
      if (!loop) {
        setStatus({ kind: 'error', text: 'This part of the video is too short to loop.' });
        return;
      }
      setStart(loop.start);
      setEnd(loop.end);
      show(loop.start);
      setStatus({
        kind: 'ok',
        text: `Loop from ${loop.start.toFixed(2)} s to ${loop.end.toFixed(2)} s. ${describeLoop(loop.difference)}`,
      });
    } catch (err) {
      setStatus(controller.signal.aborted ? { kind: 'info', text: 'Cancelled.' } : { kind: 'error', text: errorText(err) });
    } finally {
      abortRef.current = null;
      setWorking(null);
    }
  };

  const length = end - start;
  const brushing = matte !== 'none' && (tool === 'erase' || tool === 'restore');

  return (
    <>
      <Stage
        image={still}
        width={clip.width}
        height={clip.height}
        version={version}
        transform={displayTransform}
        onChange={onStageChange}
        tool={matte === 'none' ? 'move' : tool}
        brushSize={tool === 'pick' || tool === 'keep' || tool === 'remove' ? 8 : brushSize}
        onBrushStart={onBrushStart}
        onBrushMove={onBrushMove}
        onBrushEnd={onBrushEnd}
      />

      <div className="row playbar">
        <button className="secondary" onClick={() => setPlaying((p) => !p)} disabled={locked}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <p className="hint">
          {shownTime.toFixed(2)} s of {clip.duration.toFixed(1)} s.{' '}
          {tool === 'pick'
            ? 'Tap the green screen in the video.'
            : tool === 'keep'
              ? 'Tap or scribble on something to keep it in every frame.'
              : tool === 'remove'
                ? 'Tap or scribble on something to remove it from every frame.'
                : brushing
              ? 'One finger paints on every frame. Two fingers move and zoom.'
              : 'Drag to move. Pinch to zoom and rotate.'}
        </p>
      </div>

      {matte === 'none' && (
        <div className="row">
          <button className="secondary grow" onClick={startGreenScreen} disabled={locked}>
            Green screen
          </button>
          <button className="secondary grow" onClick={startAiCutout} disabled={locked}>
            AI cutout
          </button>
        </div>
      )}

      {matte === 'chroma' && chroma && (
        <section className="controls">
          <div className="row key-row">
            <span className="swatch" style={{ background: toHex(chroma.key) }} />
            <span className="grow">Screen color</span>
            <button className="ghost" onClick={() => setTool(tool === 'pick' ? 'move' : 'pick')} disabled={locked}>
              {tool === 'pick' ? 'Tap the video' : 'Pick color'}
            </button>
          </div>
          <SliderField
            label="Tolerance"
            value={chroma.tolerance}
            min={0}
            max={1}
            decimals={2}
            onChange={(v) => setChroma({ ...chroma, tolerance: v })}
          />
          <SliderField
            label="Softness"
            value={chroma.softness}
            min={0}
            max={0.6}
            decimals={2}
            onChange={(v) => setChroma({ ...chroma, softness: v })}
          />
          <label className="check">
            <input
              type="checkbox"
              checked={chroma.despill}
              onChange={(e) => setChroma({ ...chroma, despill: e.target.checked })}
            />
            <span>Remove the green tint at the edges</span>
          </label>
          <div className="row">
            <button className="ghost" onClick={turnOffMatte} disabled={locked}>
              Turn off green screen
            </button>
          </div>
        </section>
      )}

      {matte === 'ai' && (
        <>
          <div className="row">
            <button className="ghost grow" onClick={turnOffMatte} disabled={locked}>
              Bring back the background
            </button>
            <button className="ghost" onClick={undo} disabled={history.current.length === 0 || locked}>
              Undo
            </button>
          </div>
          <section className="controls">
            <label className="check">
              <input type="checkbox" checked={follow} disabled={locked} onChange={(e) => setFollow(e.target.checked)} />
              <span>Follow the subject</span>
            </label>
          </section>
        </>
      )}

      {matte !== 'none' && (
        <div className="row">
          <div className={`segmented grow${matte === 'ai' ? ' tools-5' : ''}`} role="tablist" style={{ gridTemplateColumns: `repeat(${matte === 'ai' ? 5 : 3}, 1fr)` }}>
            {(matte === 'ai' ? AI_TOOLS : TOOLS).map((t) => (
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
          {matte !== 'ai' && (
            <button className="ghost" onClick={undo} disabled={history.current.length === 0 || locked}>
              Undo
            </button>
          )}
        </div>
      )}

      <section className="controls">
        <SliderField
          label="Start s"
          value={start}
          min={0}
          max={clip.duration}
          decimals={2}
          disabled={locked || matte === 'ai'}
          onChange={changeStart}
        />
        <SliderField
          label="End s"
          value={end}
          min={0}
          max={clip.duration}
          decimals={2}
          disabled={locked || matte === 'ai'}
          onChange={changeEnd}
        />
        <p className="hint">
          {matte === 'ai'
            ? 'Trim and frame rate are locked while the AI cutout is on. Bring the background back to change them.'
            : `Length ${length.toFixed(1)} s. WhatsApp allows up to ${MAX_SECONDS} s, and shorter clips look sharper.`}
        </p>
        <div className="row">
          <button className="ghost" onClick={findLoopPoint} disabled={locked || matte === 'ai'}>
            Find loop
          </button>
        </div>
        <div className="segmented fps" role="tablist" aria-label="Frame rate">
          {FPS_CHOICES.map((f) => (
            <button
              key={f}
              role="tab"
              aria-selected={fps === f}
              className={fps === f ? 'on' : ''}
              disabled={locked || matte === 'ai'}
              onClick={() => setFps(f)}
            >
              {f} fps
            </button>
          ))}
        </div>
      </section>

      <section className="controls">
        {brushing ? (
          <SliderField label="Brush" value={brushSize} min={4} max={80} decimals={0} onChange={setBrushSize} />
        ) : (
          <MoveControls
            transform={transform}
            onChange={setTransform}
            width={clip.width}
            height={clip.height}
            onFrame={(mode) => setTransform({ ...centered(clip.width, clip.height, mode), flip: transform.flip })}
          />
        )}
      </section>

      <section className="controls">
        {fresh && quality !== null ? (
          <>
            <SliderField
              label="Sharpness"
              value={Math.round(quality * 100)}
              min={25}
              max={95}
              decimals={0}
              disabled={locked}
              // The slider moves between the levels, lowest on the left. The box snaps to the nearest level.
              toSlider={(v) => LEVELS_UP.indexOf(nearestLevel(v / 100))}
              fromSlider={(p) => LEVELS_UP[Math.round(p)] * 100}
              sliderMin={0}
              sliderMax={LEVELS_UP.length - 1}
              onChange={(v) => setQuality(nearestLevel(v / 100))}
            />
            <SizeLine estimate={fresh.estimates.get(quality) ?? 0} />
          </>
        ) : (
          <div className="row size-row">
            <button className="ghost" onClick={checkSize} disabled={locked}>
              Check size
            </button>
            <p className="hint">
              {prepared
                ? 'The settings changed. Check the size again.'
                : `See how sharp this sticker can be at ${fps} fps.`}
            </p>
          </div>
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
