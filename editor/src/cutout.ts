import type { Box, Point } from './transform';

export type Brush = 'erase' | 'restore';

/** Longest side of the working photo. Stickers are 512 px, so this leaves room to zoom in. */
const MAX_SIDE = 1600;
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

function newCanvas(width: number, height: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available.');
  return ctx;
}

/**
 * A photo plus an editable mask. White mask pixels keep the photo, transparent ones remove it.
 * `view` is the photo with the mask applied, and it is what the editor shows and exports.
 */
export class Cutout {
  readonly photo: HTMLCanvasElement;
  readonly mask: HTMLCanvasElement;
  readonly view: HTMLCanvasElement;
  private undoStack: HTMLCanvasElement[] = [];
  /** True when part of the photo is removed. */
  edited = false;

  private constructor(photo: HTMLCanvasElement) {
    this.photo = photo;
    this.mask = newCanvas(photo.width, photo.height);
    this.view = newCanvas(photo.width, photo.height);
    this.fillMask();
    this.compose();
  }

  static fromImage(image: CanvasImageSource & { width: number; height: number }): Cutout {
    const scale = Math.min(1, MAX_SIDE / Math.max(image.width, image.height));
    const photo = newCanvas(Math.round(image.width * scale), Math.round(image.height * scale));
    ctx2d(photo).drawImage(image, 0, 0, photo.width, photo.height);
    return new Cutout(photo);
  }

  get width(): number {
    return this.photo.width;
  }

  get height(): number {
    return this.photo.height;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /** Saves the mask so that undo() can bring it back. Call it before each change. */
  snapshot(): void {
    const copy = newCanvas(this.width, this.height);
    ctx2d(copy).drawImage(this.mask, 0, 0);
    this.undoStack.push(copy);
    if (this.undoStack.length > UNDO_LIMIT) {
      const dropped = this.undoStack.shift()!;
      dropped.width = 0;
    }
  }

  undo(): boolean {
    const previous = this.undoStack.pop();
    if (!previous) return false;
    const m = ctx2d(this.mask);
    m.save();
    m.globalCompositeOperation = 'copy';
    m.drawImage(previous, 0, 0);
    m.restore();
    previous.width = 0;
    this.edited = this.hasTransparency();
    this.compose();
    return true;
  }

  /** Replaces the mask with one from background removal. Only its alpha matters. */
  applyMask(source: CanvasImageSource): void {
    this.snapshot();
    const m = ctx2d(this.mask);
    m.clearRect(0, 0, this.width, this.height);
    m.drawImage(source, 0, 0, this.width, this.height);
    this.edited = true;
    this.compose();
  }

  reset(): void {
    this.snapshot();
    this.fillMask();
    this.edited = false;
    this.compose();
  }

  /** Paints one brush segment in source pixels. */
  stroke(from: Point, to: Point, radius: number, brush: Brush): void {
    const m = ctx2d(this.mask);
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
    if (brush === 'erase') this.edited = true;

    const pad = radius + 2;
    this.compose({
      x: Math.min(from.x, to.x) - pad,
      y: Math.min(from.y, to.y) - pad,
      width: Math.abs(to.x - from.x) + pad * 2,
      height: Math.abs(to.y - from.y) + pad * 2,
    });
  }

  /** The box around what is left of the photo, or null when nothing is left. */
  contentBounds(): Box | null {
    const scale = Math.min(1, 256 / Math.max(this.width, this.height));
    const small = newCanvas(Math.max(1, Math.round(this.width * scale)), Math.max(1, Math.round(this.height * scale)));
    const ctx = small.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(this.mask, 0, 0, small.width, small.height);
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

  photoJpeg(): Promise<Blob> {
    return new Promise((resolve, reject) =>
      this.photo.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not read the photo.'))), 'image/jpeg', 0.92),
    );
  }

  dispose(): void {
    for (const c of this.undoStack) c.width = 0;
    this.undoStack = [];
    this.photo.width = 0;
    this.mask.width = 0;
    this.view.width = 0;
  }

  private fillMask(): void {
    const m = ctx2d(this.mask);
    m.save();
    m.globalCompositeOperation = 'copy';
    m.fillStyle = '#fff';
    m.fillRect(0, 0, this.width, this.height);
    m.restore();
  }

  private hasTransparency(): boolean {
    const box = this.contentBounds();
    // Cheap test: if the content box is smaller than the photo, something is removed.
    // A hole in the middle is missed, which only affects the Reset button state.
    return !box || box.width < this.width - 2 || box.height < this.height - 2;
  }

  /** Redraws `view` inside one rectangle, or everywhere. */
  private compose(rect?: Box): void {
    const v = ctx2d(this.view);
    const x = Math.max(0, Math.floor(rect?.x ?? 0));
    const y = Math.max(0, Math.floor(rect?.y ?? 0));
    const right = Math.min(this.width, Math.ceil(rect ? rect.x + rect.width : this.width));
    const bottom = Math.min(this.height, Math.ceil(rect ? rect.y + rect.height : this.height));
    if (right <= x || bottom <= y) return;
    v.save();
    v.beginPath();
    v.rect(x, y, right - x, bottom - y);
    v.clip();
    v.clearRect(x, y, right - x, bottom - y);
    v.drawImage(this.photo, 0, 0);
    v.globalCompositeOperation = 'destination-in';
    v.drawImage(this.mask, 0, 0);
    v.restore();
  }
}
