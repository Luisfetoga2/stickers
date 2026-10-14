import { readFrames, type FrameSource } from './clipCutout';
import { kb } from './encode';
import { FramePlanner, type Rect } from './framePlan';
import { SIZE, draw, type Transform } from './transform';
import { frameDurations, muxAnimatedWebp } from './webp';

/** WhatsApp's limits for one animated sticker. */
export const ANIMATED_LIMIT = 500 * 1024;
export const MAX_SECONDS = 10;

export const FPS_CHOICES = [8, 10, 12, 15, 20];

/** The sharpness levels, from best to worst. They are WebP quality values. */
export const QUALITIES = [0.95, 0.9, 0.85, 0.75, 0.65, 0.55, 0.45, 0.35, 0.25];

/** Aim a little under the limit, because the estimate from sample frames is not exact. */
const ESTIMATE_TARGET = 0.9;
/** Stored frames encoded at every level to estimate the full size. */
const SAMPLE_COUNT = 10;
/** Container bytes for each stored frame (ANMF header) and for the file (RIFF, VP8X, ANIM). */
const FRAME_OVERHEAD = 24;
const FILE_OVERHEAD = 40;

export interface Animated {
  blob: Blob;
  fps: number;
  /** Frames in the clip. */
  frames: number;
  /** Frames actually stored, after unchanged frames merged. */
  stored: number;
  quality: number;
}

/** The times, in seconds, of the frames between start and end. */
export function frameTimes(start: number, end: number, fps: number): number[] {
  const count = Math.max(1, Math.floor((end - start) * fps + 1e-6));
  return Array.from({ length: count }, (_, i) => start + i / fps);
}

/**
 * Turns the sizes of the sample frames into estimated file sizes.
 * scale is the total stored area divided by the sample area.
 */
export function estimateSizes(sampleSizes: Map<number, number>, scale: number, overhead: number): Map<number, number> {
  const estimates = new Map<number, number>();
  for (const [q, size] of sampleSizes) estimates.set(q, Math.round(size * scale + overhead));
  return estimates;
}

/** The sharpest level whose estimate fits with a margin, or null when even the lowest is too big. */
export function bestQuality(estimates: Map<number, number>, limit = ANIMATED_LIMIT): number | null {
  for (const q of QUALITIES) {
    const size = estimates.get(q);
    if (size !== undefined && size <= limit * ESTIMATE_TARGET) return q;
  }
  return null;
}

/** True when an estimate is under the limit with the margin. */
export function fits(estimate: number, limit = ANIMATED_LIMIT): boolean {
  return estimate <= limit * ESTIMATE_TARGET;
}

/** One stored frame: the changed area of a sticker frame, and how long it shows. */
interface Part {
  bitmap: ImageBitmap;
  rect: Rect;
  durationMs: number;
}

/** A clip read, planned, and measured, ready to encode at any sharpness. */
export interface Prepared {
  fps: number;
  /** Frames in the clip. */
  frames: number;
  /** Estimated file size in bytes for each level in QUALITIES. */
  estimates: Map<number, number>;
  parts: Part[];
  dispose(): void;
}

/**
 * Reads the trimmed clip at the chosen frame rate, decides what each frame stores, and estimates the file size
 * at every sharpness level. The frame rate never changes here: the user picks it.
 */
export async function prepareAnimated(
  clip: FrameSource,
  transform: Transform,
  start: number,
  end: number,
  fps: number,
  onProgress: (message: string) => void,
  signal?: AbortSignal,
): Promise<Prepared> {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const out = document.createElement('canvas');
  const outCtx = out.getContext('2d');
  if (!ctx || !outCtx) throw new Error('Canvas is not available.');

  const times = frameTimes(start, end, fps);
  const durations = frameDurations(times.length, fps);
  const planner = new FramePlanner(SIZE);
  const planned: Array<{ bitmap: Promise<ImageBitmap>; rect: Rect; durationMs: number }> = [];
  const parts: Part[] = [];
  const dispose = () => {
    for (const p of parts) p.bitmap.close();
  };

  try {
    try {
      await readFrames(
        clip,
        times,
        (source, i) => {
          onProgress(`Reading frame ${i + 1} of ${times.length}…`);
          ctx.clearRect(0, 0, SIZE, SIZE);
          draw(ctx, source, clip.width, clip.height, clip.transformAt?.(times[i], transform) ?? transform);
          const rect = planner.next(ctx.getImageData(0, 0, SIZE, SIZE).data);
          if (rect) {
            // createImageBitmap copies the area at once, so the next frame can be drawn before it resolves.
            planned.push({
              bitmap: createImageBitmap(canvas, rect.x, rect.y, rect.width, rect.height),
              rect,
              durationMs: durations[i],
            });
          } else {
            planned[planned.length - 1].durationMs += durations[i];
          }
        },
        signal,
      );
    } finally {
      const settled = await Promise.allSettled(planned.map((p) => p.bitmap));
      settled.forEach((r, i) => {
        if (r.status === 'fulfilled') parts.push({ bitmap: r.value, rect: planned[i].rect, durationMs: planned[i].durationMs });
      });
    }
    if (parts.length !== planned.length) throw new Error('Some frames could not be read.');

    // Encode sample parts at every level, and scale by area to estimate the full size.
    const area = (r: Rect) => r.width * r.height;
    const step = Math.max(1, Math.floor(parts.length / SAMPLE_COUNT));
    const sample = parts.filter((_, i) => i % step === 0);
    const scale = parts.reduce((s, p) => s + area(p.rect), 0) / sample.reduce((s, p) => s + area(p.rect), 0);
    const sampleSizes = new Map<number, number>();
    for (let q = 0; q < QUALITIES.length; q++) {
      onProgress(`Measuring sharpness levels: ${q + 1} of ${QUALITIES.length}…`);
      let total = 0;
      for (const p of sample) {
        signal?.throwIfAborted();
        total += (await encodeFrame(outCtx, out, p.bitmap, QUALITIES[q])).length;
      }
      sampleSizes.set(QUALITIES[q], total);
    }
    const estimates = estimateSizes(sampleSizes, scale, FILE_OVERHEAD + FRAME_OVERHEAD * parts.length);
    return { fps, frames: times.length, estimates, parts, dispose };
  } catch (err) {
    dispose();
    throw err;
  } finally {
    canvas.width = 0;
    out.width = 0;
  }
}

/** Encodes a prepared clip at one sharpness level. It never lowers the level or the frame rate on its own. */
export async function encodePrepared(
  prepared: Prepared,
  quality: number,
  onProgress: (message: string) => void,
  signal?: AbortSignal,
): Promise<Animated> {
  const out = document.createElement('canvas');
  const outCtx = out.getContext('2d');
  if (!outCtx) throw new Error('Canvas is not available.');
  try {
    const encoded = [];
    for (let i = 0; i < prepared.parts.length; i++) {
      signal?.throwIfAborted();
      onProgress(`Encoding frame ${i + 1} of ${prepared.parts.length}…`);
      const { bitmap, rect, durationMs } = prepared.parts[i];
      encoded.push({ webp: await encodeFrame(outCtx, out, bitmap, quality), durationMs, ...rect });
    }
    const file = muxAnimatedWebp(encoded, SIZE, SIZE);
    if (file.length > ANIMATED_LIMIT) {
      throw new Error(
        `At ${Math.round(quality * 100)}% sharpness and ${prepared.fps} fps, the sticker came out at ${kb(file.length)}. ` +
          `The limit is ${kb(ANIMATED_LIMIT)}. Lower the sharpness one step, or lower the frame rate or the length.`,
      );
    }
    return {
      blob: new Blob([file], { type: 'image/webp' }),
      fps: prepared.fps,
      frames: prepared.frames,
      stored: prepared.parts.length,
      quality,
    };
  } finally {
    out.width = 0;
  }
}

/** The message when no sharpness level fits at the chosen frame rate. */
export function tooBigAtAnyLevel(prepared: Prepared): string {
  const lowest = prepared.estimates.get(QUALITIES[QUALITIES.length - 1]) ?? 0;
  return (
    `At ${prepared.fps} fps, this sticker is about ${kb(lowest)} even at the lowest sharpness. ` +
    `The limit is ${kb(ANIMATED_LIMIT)}. Lower the frame rate or make the clip shorter.`
  );
}

/** Encodes one stored area as a WebP image of its own size. */
async function encodeFrame(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  frame: ImageBitmap,
  quality: number,
): Promise<Uint8Array> {
  if (canvas.width !== frame.width || canvas.height !== frame.height) {
    canvas.width = frame.width;
    canvas.height = frame.height;
  } else {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(frame, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', quality));
  if (!blob || blob.type !== 'image/webp') throw new Error('This browser cannot make WebP files.');
  return new Uint8Array(await blob.arrayBuffer());
}
