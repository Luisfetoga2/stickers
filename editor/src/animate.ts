import { readFrames, type FrameSource } from './clipCutout';
import { TooBigError, kb } from './encode';
import { FramePlanner, type Rect } from './framePlan';
import { SIZE, draw, type Transform } from './transform';
import { frameDurations, muxAnimatedWebp } from './webp';

/** WhatsApp's limits for one animated sticker. */
export const ANIMATED_LIMIT = 500 * 1024;
export const MAX_SECONDS = 10;

export const FPS_CHOICES = [8, 10, 12, 15, 20];

/** Tried from best to worst until the file fits. The top ones fit when only small areas change. */
const QUALITIES = [0.95, 0.9, 0.85, 0.75, 0.65, 0.55, 0.45, 0.35, 0.25];

/** Aim a little under the limit, because the estimate from sample frames is not exact. */
const ESTIMATE_TARGET = 0.9;

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

/** Lower frame rates to try when the file is still too big. */
export function fallbackFps(fps: number): number[] {
  return [fps, ...[10, 8, 6, 5].filter((f) => f < fps)];
}

/**
 * Picks the best quality whose estimated size fits the limit.
 * sampleSizes maps quality to the summed size of the sample frames.
 * scale turns a sample size into a full size, for example total area divided by sample area.
 */
export function pickQuality(sampleSizes: Map<number, number>, scale: number, limit: number) {
  for (const q of QUALITIES) {
    const size = sampleSizes.get(q);
    if (size !== undefined && size * scale <= limit * ESTIMATE_TARGET) return q;
  }
  return QUALITIES[QUALITIES.length - 1];
}

/** One stored frame: the changed area of a sticker frame, and how long it shows. */
interface Part {
  bitmap: Promise<ImageBitmap>;
  rect: Rect;
  durationMs: number;
}

/** Renders the trimmed clip into one animated WebP under 500 KB. */
export async function makeAnimated(
  clip: FrameSource,
  transform: Transform,
  start: number,
  end: number,
  fps: number,
  onProgress: (message: string) => void,
  signal?: AbortSignal,
): Promise<Animated> {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const out = document.createElement('canvas');
  const outCtx = out.getContext('2d');
  if (!ctx || !outCtx) throw new Error('Canvas is not available.');

  let smallest = Infinity;
  try {
    for (const tryFps of fallbackFps(fps)) {
      const times = frameTimes(start, end, tryFps);
      const durations = frameDurations(times.length, tryFps);
      const planner = new FramePlanner(SIZE);
      const parts: Part[] = [];
      const bitmaps: ImageBitmap[] = [];
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
                parts.push({
                  bitmap: createImageBitmap(canvas, rect.x, rect.y, rect.width, rect.height),
                  rect,
                  durationMs: durations[i],
                });
              } else {
                parts[parts.length - 1].durationMs += durations[i];
              }
            },
            signal,
          );
        } finally {
          for (const r of await Promise.allSettled(parts.map((p) => p.bitmap))) {
            if (r.status === 'fulfilled') bitmaps.push(r.value);
          }
        }
        if (bitmaps.length !== parts.length) throw new Error('Some frames could not be read.');

        // Encode a few sample parts at each quality, and scale by area to guess the full size.
        onProgress('Finding the best quality…');
        const area = (r: Rect) => r.width * r.height;
        const step = Math.max(1, Math.floor(parts.length / 6));
        const sample = parts.map((_, i) => i).filter((i) => i % step === 0);
        const sampleArea = sample.reduce((sum, i) => sum + area(parts[i].rect), 0);
        const totalArea = parts.reduce((sum, p) => sum + area(p.rect), 0);
        const sampleSizes = new Map<number, number>();
        for (const q of QUALITIES) {
          let total = 0;
          for (const i of sample) {
            signal?.throwIfAborted();
            total += (await encodeFrame(outCtx, out, bitmaps[i], q)).length;
          }
          sampleSizes.set(q, total);
        }
        const firstTry = pickQuality(sampleSizes, totalArea / sampleArea, ANIMATED_LIMIT);

        for (const q of QUALITIES.slice(QUALITIES.indexOf(firstTry))) {
          const encoded = [];
          for (let i = 0; i < parts.length; i++) {
            signal?.throwIfAborted();
            onProgress(`Encoding frame ${i + 1} of ${parts.length}…`);
            const { rect, durationMs } = parts[i];
            encoded.push({ webp: await encodeFrame(outCtx, out, bitmaps[i], q), durationMs, ...rect });
          }
          const file = muxAnimatedWebp(encoded, SIZE, SIZE);
          if (file.length <= ANIMATED_LIMIT) {
            return {
              blob: new Blob([file], { type: 'image/webp' }),
              fps: tryFps,
              frames: times.length,
              stored: parts.length,
              quality: q,
            };
          }
          smallest = Math.min(smallest, file.length);
          onProgress(`${kb(file.length)} is over the limit. Trying a lower quality…`);
        }
      } finally {
        for (const b of bitmaps) b.close();
      }
    }
  } finally {
    canvas.width = 0;
    out.width = 0;
  }
  throw new TooBigError(smallest, ANIMATED_LIMIT, 'Make the clip shorter.');
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
