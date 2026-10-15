import { frameTimes } from './animate';
import type { FrameCallback } from './clip';
import { fillGaps } from './follow';
import { ctx2d, newCanvas } from './mask';
import type { Point, Transform } from './transform';

/** Anything that gives frames by time: a Clip, or a clip with its background removed. */
export interface FrameSource {
  width: number;
  height: number;
  frameAt(seconds: number): Promise<CanvasImageSource>;
  /** Reads many frames in order, faster than frameAt in a loop. */
  readFrames?(times: number[], onFrame: FrameCallback, signal?: AbortSignal): Promise<void>;
  /** The transform for the frame at a time, when it differs per frame, as with Follow the subject. */
  transformAt?(seconds: number, base: Transform): Transform;
}

/** Reads frames with readFrames when the source has it, otherwise one at a time. */
export async function readFrames(
  source: FrameSource,
  times: number[],
  onFrame: FrameCallback,
  signal?: AbortSignal,
): Promise<void> {
  if (source.readFrames) return source.readFrames(times, onFrame, signal);
  for (let i = 0; i < times.length; i++) {
    signal?.throwIfAborted();
    onFrame(await source.frameAt(times[i]), i);
  }
}

/** Longest side of the frames the editor processes. Stickers are 512 px, so this leaves a little room to zoom. */
export const WORK_SIDE = 640;
/** Longest side of the frames sent to ML Kit. Smaller is faster, and the mask is scaled back up. */
const MODEL_SIDE = 512;
export const MAX_CUTOUT_FRAMES = 150;

/** Mask confidence below EDGE_LOW is removed and above EDGE_HIGH is kept, with a short fade between. */
const EDGE_LOW = 0.35;
const EDGE_HIGH = 0.65;

/**
 * Sharpens a soft mask in place. ML Kit gives a wide band of half-sure pixels around the subject.
 * In a video that band changes every frame, so it shows the old background and flickers.
 */
export function hardenAlpha(data: Uint8ClampedArray, low = EDGE_LOW, high = EDGE_HIGH): void {
  const lo = low * 255;
  const span = (high - low) * 255;
  for (let i = 3; i < data.length; i += 4) {
    const t = (data[i] - lo) / span;
    data[i] = t <= 0 ? 0 : t >= 1 ? 255 : Math.round(t * 255);
  }
}

export interface CutoutProgress {
  /** Reading plays the clip once. Cutting sends each frame to ML Kit. */
  phase: 'reading' | 'cutting';
  done: number;
  total: number;
  /** Average seconds per frame so far. */
  secondsPerFrame: number;
  /** Average seconds per frame inside ML Kit, when the app reports it. */
  modelSecondsPerFrame: number | null;
}

export type RemoveBackground = (jpeg: Blob) => Promise<{ mask: Blob; modelMs: number | null }>;

export function workSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, WORK_SIDE / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Undo steps kept for Keep and Remove. Each one copies every frame's mask. */
const MASK_UNDO_LIMIT = 3;

/** The alpha-weighted center of a mask, or null when it is empty. Every second pixel is enough. */
export function maskCenter(mask: Uint8Array, width: number, height: number): Point | null {
  let sum = 0;
  let sx = 0;
  let sy = 0;
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const a = mask[y * width + x];
      if (a === 0) continue;
      sum += a;
      sx += x * a;
      sy += y * a;
    }
  }
  return sum === 0 ? null : { x: sx / sum + 0.5, y: sy / sum + 0.5 };
}

/** Changes a mask in place: Keep adds an object to it, and Remove cuts an object out of it. */
export function applyObject(mask: Uint8Array, object: Uint8Array, mode: 'keep' | 'remove'): void {
  if (mode === 'keep') {
    for (let i = 0; i < mask.length; i++) if (object[i] > mask[i]) mask[i] = object[i];
  } else {
    for (let i = 0; i < mask.length; i++) {
      const left = 255 - object[i];
      if (left < mask[i]) mask[i] = left;
    }
  }
}

/**
 * A trimmed clip with its background removed frame by frame, at work size.
 * It keeps each frame's picture and its mask apart, so Keep can bring back pixels that the first cutout removed.
 */
export class ClipCutout {
  /** The subject's center in each frame, in work pixels. Follow the subject uses it. */
  centers: Point[];
  private undoStack: Uint8Array[][] = [];
  private readonly out: HTMLCanvasElement;
  private readonly outCtx: CanvasRenderingContext2D;
  private readonly maskCanvas: HTMLCanvasElement;
  private readonly maskCtx: CanvasRenderingContext2D;
  private readonly maskImage: ImageData;

  private constructor(
    readonly start: number,
    readonly fps: number,
    readonly times: number[],
    private sources: ImageBitmap[],
    private masks: Uint8Array[],
    readonly width: number,
    readonly height: number,
  ) {
    this.out = newCanvas(width, height);
    this.outCtx = ctx2d(this.out);
    this.maskCanvas = newCanvas(width, height);
    this.maskCtx = ctx2d(this.maskCanvas);
    this.maskImage = this.maskCtx.createImageData(width, height);
    this.maskImage.data.fill(255);
    this.centers = this.findCenters();
  }

  static async build(
    clip: FrameSource,
    start: number,
    end: number,
    fps: number,
    removeBackground: RemoveBackground,
    onProgress: (p: CutoutProgress) => void,
    signal?: AbortSignal,
  ): Promise<ClipCutout> {
    const times = frameTimes(start, end, fps);
    if (times.length > MAX_CUTOUT_FRAMES) {
      throw new Error(
        `This clip has ${times.length} frames. Background removal works on ${MAX_CUTOUT_FRAMES} frames at most, so shorten the clip or lower the frame rate.`,
      );
    }

    const { width, height } = workSize(clip.width, clip.height);
    const work = newCanvas(width, height);
    const workCtx = ctx2d(work);
    const modelScale = Math.min(1, MODEL_SIDE / Math.max(width, height));
    const model = newCanvas(Math.round(width * modelScale), Math.round(height * modelScale));
    const modelCtx = ctx2d(model);
    const maskCanvas = newCanvas(width, height);
    const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });
    if (!maskCtx) throw new Error('Canvas is not available.');

    let sources: ImageBitmap[] = [];
    const masks: Uint8Array[] = [];
    let modelMsTotal = 0;
    let modelReports = 0;
    try {
      const pending: Promise<ImageBitmap>[] = [];
      try {
        await readFrames(
          clip,
          times,
          (source, i) => {
            workCtx.clearRect(0, 0, width, height);
            workCtx.drawImage(source, 0, 0, width, height);
            pending.push(createImageBitmap(work));
            onProgress({ phase: 'reading', done: i + 1, total: times.length, secondsPerFrame: 0, modelSecondsPerFrame: null });
          },
          signal,
        );
      } finally {
        const settled = await Promise.allSettled(pending);
        sources = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
      }
      if (sources.length !== times.length) throw new Error('Some frames could not be read.');

      const began = performance.now();
      for (let i = 0; i < times.length; i++) {
        signal?.throwIfAborted();
        modelCtx.drawImage(sources[i], 0, 0, model.width, model.height);
        const { mask, modelMs } = await removeBackground(await toJpeg(model));
        if (modelMs !== null) {
          modelMsTotal += modelMs;
          modelReports++;
        }

        const maskBitmap = await createImageBitmap(mask);
        maskCtx.clearRect(0, 0, width, height);
        maskCtx.drawImage(maskBitmap, 0, 0, width, height);
        maskBitmap.close();
        const pixels = maskCtx.getImageData(0, 0, width, height).data;
        hardenAlpha(pixels);
        const alpha = new Uint8Array(width * height);
        for (let p = 0; p < alpha.length; p++) alpha[p] = pixels[p * 4 + 3];
        masks.push(alpha);

        onProgress({
          phase: 'cutting',
          done: i + 1,
          total: times.length,
          secondsPerFrame: (performance.now() - began) / 1000 / (i + 1),
          modelSecondsPerFrame: modelReports ? modelMsTotal / 1000 / modelReports : null,
        });
      }
    } catch (err) {
      for (const b of sources) b.close();
      throw err;
    } finally {
      work.width = 0;
      model.width = 0;
      maskCanvas.width = 0;
    }
    return new ClipCutout(start, fps, times, sources, masks, width, height);
  }

  get count(): number {
    return this.sources.length;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  indexAt(seconds: number): number {
    return Math.max(0, Math.min(this.count - 1, Math.floor((seconds - this.start) * this.fps + 1e-6)));
  }

  /** The frame's original picture, before any cutout. */
  source(index: number): ImageBitmap {
    return this.sources[index];
  }

  /** One cut-out frame. The same canvas is reused, so draw it right away. */
  frame(index: number): HTMLCanvasElement {
    const mask = this.masks[index];
    const data = this.maskImage.data;
    for (let i = 0; i < mask.length; i++) data[i * 4 + 3] = mask[i];
    this.maskCtx.putImageData(this.maskImage, 0, 0);
    const ctx = this.outCtx;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.drawImage(this.sources[index], 0, 0);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(this.maskCanvas, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    return this.out;
  }

  /** Saves every mask, so undo() can bring them back. Call it before Keep or Remove. */
  snapshot(): void {
    this.undoStack.push(this.masks.map((m) => m.slice()));
    if (this.undoStack.length > MASK_UNDO_LIMIT) this.undoStack.shift();
  }

  undo(): boolean {
    const previous = this.undoStack.pop();
    if (!previous) return false;
    this.masks = previous;
    this.centers = this.findCenters();
    return true;
  }

  /** Applies Keep or Remove with one mask per frame. Frames with no mask stay as they are. */
  applyObjects(objects: Array<Uint8Array | null>, mode: 'keep' | 'remove'): void {
    objects.forEach((object, i) => {
      if (object) applyObject(this.masks[i], object, mode);
    });
    this.centers = this.findCenters();
  }

  dispose(): void {
    for (const b of this.sources) b.close();
    this.sources = [];
    this.masks = [];
    this.undoStack = [];
  }

  private findCenters(): Point[] {
    const centers = this.masks.map((m) => maskCenter(m, this.width, this.height));
    return fillGaps(centers, { x: this.width / 2, y: this.height / 2 });
  }
}

function toJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not read a frame.'))), 'image/jpeg', 0.9),
  );
}
