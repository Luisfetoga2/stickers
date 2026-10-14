import { frameTimes } from './animate';
import { ctx2d, newCanvas } from './mask';

/** Anything that gives frames by time: a Clip, or a clip with its background removed. */
export interface FrameSource {
  width: number;
  height: number;
  frameAt(seconds: number): Promise<CanvasImageSource>;
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

/** A trimmed clip with its background removed frame by frame, at work size. */
export class ClipCutout {
  private constructor(
    readonly start: number,
    readonly fps: number,
    readonly times: number[],
    private frames: ImageBitmap[],
  ) {}

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

    const frames: ImageBitmap[] = [];
    const began = performance.now();
    let modelMsTotal = 0;
    let modelReports = 0;
    try {
      for (let i = 0; i < times.length; i++) {
        signal?.throwIfAborted();
        workCtx.globalCompositeOperation = 'source-over';
        workCtx.clearRect(0, 0, width, height);
        workCtx.drawImage(await clip.frameAt(times[i]), 0, 0, width, height);
        modelCtx.drawImage(work, 0, 0, model.width, model.height);

        const { mask, modelMs } = await removeBackground(await toJpeg(model));
        if (modelMs !== null) {
          modelMsTotal += modelMs;
          modelReports++;
        }

        const maskBitmap = await createImageBitmap(mask);
        maskCtx.clearRect(0, 0, width, height);
        maskCtx.drawImage(maskBitmap, 0, 0, width, height);
        maskBitmap.close();
        const pixels = maskCtx.getImageData(0, 0, width, height);
        hardenAlpha(pixels.data);
        maskCtx.putImageData(pixels, 0, 0);

        workCtx.globalCompositeOperation = 'destination-in';
        workCtx.drawImage(maskCanvas, 0, 0);
        workCtx.globalCompositeOperation = 'source-over';
        frames.push(await createImageBitmap(work));

        onProgress({
          done: i + 1,
          total: times.length,
          secondsPerFrame: (performance.now() - began) / 1000 / (i + 1),
          modelSecondsPerFrame: modelReports ? modelMsTotal / 1000 / modelReports : null,
        });
      }
    } catch (err) {
      for (const f of frames) f.close();
      throw err;
    } finally {
      work.width = 0;
      model.width = 0;
      maskCanvas.width = 0;
    }
    return new ClipCutout(start, fps, times, frames);
  }

  get width(): number {
    return this.frames[0]?.width ?? 0;
  }

  get height(): number {
    return this.frames[0]?.height ?? 0;
  }

  get count(): number {
    return this.frames.length;
  }

  indexAt(seconds: number): number {
    return Math.max(0, Math.min(this.count - 1, Math.floor((seconds - this.start) * this.fps + 1e-6)));
  }

  frame(index: number): ImageBitmap {
    return this.frames[index];
  }

  dispose(): void {
    for (const f of this.frames) f.close();
    this.frames = [];
  }
}

function toJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not read a frame.'))), 'image/jpeg', 0.9),
  );
}
