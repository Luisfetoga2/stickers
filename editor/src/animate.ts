import type { FrameSource } from './clipCutout';
import { TooBigError, kb } from './encode';
import { SIZE, draw, type Transform } from './transform';
import { frameDurations, muxAnimatedWebp } from './webp';

/** WhatsApp's limits for one animated sticker. */
export const ANIMATED_LIMIT = 500 * 1024;
export const MAX_SECONDS = 10;

export const FPS_CHOICES = [8, 10, 12, 15, 20];

/** Tried from best to worst until the file fits. */
const QUALITIES = [0.85, 0.75, 0.65, 0.55, 0.45, 0.35, 0.25];

/** Aim a little under the limit, because the estimate from sample frames is not exact. */
const ESTIMATE_TARGET = 0.9;

export interface Animated {
  blob: Blob;
  fps: number;
  frames: number;
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
 */
export function pickQuality(sampleSizes: Map<number, number>, sampleCount: number, frameCount: number, limit: number) {
  for (const q of QUALITIES) {
    const size = sampleSizes.get(q);
    if (size !== undefined && (size / sampleCount) * frameCount <= limit * ESTIMATE_TARGET) return q;
  }
  return QUALITIES[QUALITIES.length - 1];
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
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available.');

  let smallest = Infinity;
  try {
    for (const tryFps of fallbackFps(fps)) {
      const times = frameTimes(start, end, tryFps);
      const frames: ImageBitmap[] = [];
      try {
        for (let i = 0; i < times.length; i++) {
          signal?.throwIfAborted();
          onProgress(`Reading frame ${i + 1} of ${times.length}…`);
          const source = await clip.frameAt(times[i]);
          ctx.clearRect(0, 0, SIZE, SIZE);
          draw(ctx, source, clip.width, clip.height, transform);
          frames.push(await createImageBitmap(canvas));
        }

        // Encode a few sample frames at each quality to guess the full size.
        onProgress('Finding the best quality…');
        const step = Math.max(1, Math.floor(frames.length / 6));
        const sample = frames.filter((_, i) => i % step === 0);
        const sampleSizes = new Map<number, number>();
        for (const q of QUALITIES) {
          let total = 0;
          for (const f of sample) {
            signal?.throwIfAborted();
            total += (await encodeFrame(ctx, canvas, f, q)).length;
          }
          sampleSizes.set(q, total);
        }
        const firstTry = pickQuality(sampleSizes, sample.length, frames.length, ANIMATED_LIMIT);

        const durations = frameDurations(frames.length, tryFps);
        for (const q of QUALITIES.slice(QUALITIES.indexOf(firstTry))) {
          const encoded = [];
          for (let i = 0; i < frames.length; i++) {
            signal?.throwIfAborted();
            onProgress(`Encoding frame ${i + 1} of ${frames.length}…`);
            encoded.push({ webp: await encodeFrame(ctx, canvas, frames[i], q), durationMs: durations[i] });
          }
          const file = muxAnimatedWebp(encoded, SIZE, SIZE);
          if (file.length <= ANIMATED_LIMIT) {
            return { blob: new Blob([file], { type: 'image/webp' }), fps: tryFps, frames: frames.length, quality: q };
          }
          smallest = Math.min(smallest, file.length);
          onProgress(`${kb(file.length)} is over the limit. Trying a lower quality…`);
        }
      } finally {
        for (const f of frames) f.close();
      }
    }
  } finally {
    canvas.width = 0;
  }
  throw new TooBigError(smallest, ANIMATED_LIMIT, 'Make the clip shorter.');
}

async function encodeFrame(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  frame: ImageBitmap,
  quality: number,
): Promise<Uint8Array> {
  ctx.clearRect(0, 0, SIZE, SIZE);
  ctx.drawImage(frame, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', quality));
  if (!blob || blob.type !== 'image/webp') throw new Error('This browser cannot make WebP files.');
  return new Uint8Array(await blob.arrayBuffer());
}
