import type { Box, Point } from './transform';

export type Brush = 'erase' | 'restore';

const UNDO_LIMIT = 6;

/**
 * The smallest box around pixels with alpha above the threshold, from RGBA data.
 * Returns null when every pixel is transparent.
 */
export function alphaBounds(data: Uint8ClampedArray, width: number, height: number, threshold = 16): Box | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

export function newCanvas(width: number, height: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

export function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available.');
  return ctx;
}

/** An editable alpha mask with undo. White pixels keep the image, transparent ones remove it. */
export class Mask {
  readonly canvas: HTMLCanvasElement;
  private undoStack: HTMLCanvasElement[] = [];

  constructor(width: number, height: number) {
    this.canvas = newCanvas(width, height);
    this.fill();
  }

  get width(): number {
    return this.canvas.width;
  }

  get height(): number {
    return this.canvas.height;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /** Saves the mask so that undo() can bring it back. Call it before each change. */
  snapshot(): void {
    const copy = newCanvas(this.width, this.height);
    ctx2d(copy).drawImage(this.canvas, 0, 0);
    this.undoStack.push(copy);
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift()!.width = 0;
  }

  undo(): boolean {
    const previous = this.undoStack.pop();
    if (!previous) return false;
    const m = ctx2d(this.canvas);
    m.save();
    m.globalCompositeOperation = 'copy';
    m.drawImage(previous, 0, 0);
    m.restore();
    previous.width = 0;
    return true;
  }

  /** Replaces the mask with another image. Only its alpha matters. */
  replace(source: CanvasImageSource): void {
    this.snapshot();
    const m = ctx2d(this.canvas);
    m.clearRect(0, 0, this.width, this.height);
    m.drawImage(source, 0, 0, this.width, this.height);
  }

  reset(): void {
    this.snapshot();
    this.fill();
  }

  /** Paints one brush segment in mask pixels and returns the area it touched. */
  stroke(from: Point, to: Point, radius: number, brush: Brush): Box {
    const m = ctx2d(this.canvas);
    m.save();
    m.globalCompositeOperation = brush === 'erase' ? 'destination-out' : 'source-over';
    m.strokeStyle = '#fff';
    m.fillStyle = '#fff';
    m.lineWidth = radius * 2;
    m.lineCap = 'round';
    m.beginPath();
    m.moveTo(from.x, from.y);
    m.lineTo(to.x, to.y);
    m.stroke();
    // A tap with no movement still leaves a dot.
    m.beginPath();
    m.arc(to.x, to.y, radius, 0, Math.PI * 2);
    m.fill();
    m.restore();
    const pad = radius + 2;
    return {
      x: Math.min(from.x, to.x) - pad,
      y: Math.min(from.y, to.y) - pad,
      width: Math.abs(to.x - from.x) + pad * 2,
      height: Math.abs(to.y - from.y) + pad * 2,
    };
  }

  /** The box around the kept area, or null when nothing is kept. */
  contentBounds(): Box | null {
    const scale = Math.min(1, 256 / Math.max(this.width, this.height));
    const small = newCanvas(Math.max(1, Math.round(this.width * scale)), Math.max(1, Math.round(this.height * scale)));
    const ctx = small.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(this.canvas, 0, 0, small.width, small.height);
    const box = alphaBounds(ctx.getImageData(0, 0, small.width, small.height).data, small.width, small.height);
    small.width = 0;
    if (!box) return null;
    const x = Math.max(0, (box.x - 1) / scale);
    const y = Math.max(0, (box.y - 1) / scale);
    return {
      x,
      y,
      width: Math.min(this.width - x, (box.width + 2) / scale),
      height: Math.min(this.height - y, (box.height + 2) / scale),
    };
  }

  /** Cheap test for removed areas: the kept box is smaller than the mask. A hole in the middle is missed. */
  hasTransparency(): boolean {
    const box = this.contentBounds();
    return !box || box.width < this.width - 2 || box.height < this.height - 2;
  }

  dispose(): void {
    for (const c of this.undoStack) c.width = 0;
    this.undoStack = [];
    this.canvas.width = 0;
  }

  private fill(): void {
    const m = ctx2d(this.canvas);
    m.save();
    m.globalCompositeOperation = 'copy';
    m.fillStyle = '#fff';
    m.fillRect(0, 0, this.width, this.height);
    m.restore();
  }
}
