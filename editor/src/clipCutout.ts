import { frameTimes } from './animate';
import { Mask, ctx2d, newCanvas, type Brush } from './mask';
import type { Point } from './transform';

/** Anything that gives frames by time: a Clip, or a clip with its background removed. */
export interface FrameSource {
  width: number;
  height: number;
  frameAt(seconds: number): Promise<CanvasImageSource>;
}

/** Longest side of cut-out frames. ML Kit works at about this size, and stickers are 512 px. */
const WORK_SIDE = 640;
export const MAX_CUTOUT_FRAMES = 150;

/** Each mask is blended with its neighbors to keep edges from flickering. The weights add up to 1. */
const SMOOTHING: Array<[offset: number, weight: number]> = [
  [-1, 0.25],
  [0, 0.5],
  [1, 0.25],
];

/** Blend weights for frame i. At the first and last frame, the missing neighbor's weight is shared out. */
export function smoothingWeights(i: number, count: number): Array<[index: number, weight: number]> {
  const valid = SMOOTHING.map(([offset, w]) => [i + offset, w] as [number, number]).filter(
    ([j]) => j >= 0 && j < count,
  );
  const total = valid.reduce((sum, [, w]) => sum + w, 0);
  return valid.map(([j, w]) => [j, w / total]);
}

export interface CutoutProgress {
  done: number;
  total: number;
  /** Average seconds per frame so far. */
  secondsPerFrame: number;
}

/**
 * A trimmed clip with its background removed frame by frame.
 * `keep` is one extra mask for the brushes. It applies to every frame.
 */
export class ClipCutout {
  readonly keep: Mask;
  private readonly out: HTMLCanvasElement;

  private constructor(
    readonly start: number,
    readonly fps: number,
    readonly times: number[],
    private frames: ImageBitmap[],
  ) {
    this.keep = new Mask(frames[0].width, frames[0].height);
    this.out = newCanvas(frames[0].width, frames[0].height);
  }

  static async build(
    clip: FrameSource,
    start: number,
    end: number,
    fps: number,
    removeBackground: (jpeg: Blob) => Promise<Blob>,
    onProgress: (p: CutoutProgress) => void,
    signal?: AbortSignal,
  ): Promise<ClipCutout> {
    const times = frameTimes(start, end, fps);
    if (times.length > MAX_CUTOUT_FRAMES) {
      throw new Error(
        `This clip has ${times.length} frames. Background removal works on ${MAX_CUTOUT_FRAMES} frames at most, so shorten the clip or lower the frame rate.`,
      );
    }

    const scale = Math.min(1, WORK_SIDE / Math.max(clip.width, clip.height));
    const width = Math.max(1, Math.round(clip.width * scale));
    const height = Math.max(1, Math.round(clip.height * scale));
    const work = newCanvas(width, height);
    const workCtx = ctx2d(work);

    const sources: ImageBitmap[] = [];
    const masks: ImageBitmap[] = [];
    const frames: ImageBitmap[] = [];
    const began = performance.now();
    try {
      for (let i = 0; i < times.length; i++) {
        signal?.throwIfAborted();
        workCtx.clearRect(0, 0, width, height);
        workCtx.drawImage(await clip.frameAt(times[i]), 0, 0, width, height);
        sources.push(await createImageBitmap(work));
        const mask = await removeBackground(await toJpeg(work));
        masks.push(await createImageBitmap(mask, { resizeWidth: width, resizeHeight: height }));
        onProgress({ done: i + 1, total: times.length, secondsPerFrame: (performance.now() - began) / 1000 / (i + 1) });
      }

      const blended = newCanvas(width, height);
      const blendCtx = ctx2d(blended);
      for (let i = 0; i < times.length; i++) {
        signal?.throwIfAborted();
        // "lighter" adds alpha values, so weights that add up to 1 give a weighted average.
        blendCtx.globalCompositeOperation = 'source-over';
        blendCtx.globalAlpha = 1;
        blendCtx.clearRect(0, 0, width, height);
        blendCtx.globalCompositeOperation = 'lighter';
        for (const [j, weight] of smoothingWeights(i, times.length)) {
          blendCtx.globalAlpha = weight;
          blendCtx.drawImage(masks[j], 0, 0);
        }
        workCtx.globalCompositeOperation = 'source-over';
        workCtx.clearRect(0, 0, width, height);
        workCtx.drawImage(sources[i], 0, 0);
        workCtx.globalCompositeOperation = 'destination-in';
        workCtx.drawImage(blended, 0, 0);
        workCtx.globalCompositeOperation = 'source-over';
        frames.push(await createImageBitmap(work));
      }
      blended.width = 0;
    } catch (err) {
      for (const f of frames) f.close();
      throw err;
    } finally {
      for (const b of [...sources, ...masks]) b.close();
      work.width = 0;
    }
    return new ClipCutout(start, fps, times, frames);
  }

  get width(): number {
    return this.out.width;
  }

  get height(): number {
    return this.out.height;
  }

  get count(): number {
    return this.frames.length;
  }

  indexAt(seconds: number): number {
    return Math.max(0, Math.min(this.count - 1, Math.floor((seconds - this.start) * this.fps + 1e-6)));
  }

  /** One cut-out frame with the brush mask applied. The same canvas is reused, so draw it right away. */
  render(index: number): HTMLCanvasElement {
    const ctx = ctx2d(this.out);
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.drawImage(this.frames[index], 0, 0);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(this.keep.canvas, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    return this.out;
  }

  /** Frames for the encoder. Width and height stay in source pixels, so the editor transform still fits. */
  asSource(sourceWidth: number, sourceHeight: number): FrameSource {
    return {
      width: sourceWidth,
      height: sourceHeight,
      frameAt: async (seconds) => this.render(this.indexAt(seconds)),
    };
  }

  stroke(from: Point, to: Point, radius: number, brush: Brush): void {
    this.keep.stroke(from, to, radius, brush);
  }

  dispose(): void {
    for (const f of this.frames) f.close();
    this.frames = [];
    this.keep.dispose();
    this.out.width = 0;
  }
}

function toJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not read a frame.'))), 'image/jpeg', 0.9),
  );
}
