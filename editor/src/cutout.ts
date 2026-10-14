import { Mask, ctx2d, newCanvas, type Brush } from './mask';
import type { Box, Point } from './transform';

export type { Brush } from './mask';

/** Longest side of the working photo. Stickers are 512 px, so this leaves room to zoom in. */
const MAX_SIDE = 1600;

/**
 * A photo plus an editable mask.
 * `view` is the photo with the mask applied, and it is what the editor shows and exports.
 */
export class Cutout {
  readonly photo: HTMLCanvasElement;
  readonly mask: Mask;
  readonly view: HTMLCanvasElement;
  /** True when part of the photo is removed. */
  edited = false;

  private constructor(photo: HTMLCanvasElement) {
    this.photo = photo;
    this.mask = new Mask(photo.width, photo.height);
    this.view = newCanvas(photo.width, photo.height);
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
    return this.mask.canUndo;
  }

  snapshot(): void {
    this.mask.snapshot();
  }

  undo(): boolean {
    if (!this.mask.undo()) return false;
    this.edited = this.mask.hasTransparency();
    this.compose();
    return true;
  }

  /** Replaces the mask with one from background removal. */
  applyMask(source: CanvasImageSource): void {
    this.mask.replace(source);
    this.edited = true;
    this.compose();
  }

  reset(): void {
    this.mask.reset();
    this.edited = false;
    this.compose();
  }

  stroke(from: Point, to: Point, radius: number, brush: Brush): void {
    const area = this.mask.stroke(from, to, radius, brush);
    if (brush === 'erase') this.edited = true;
    this.compose(area);
  }

  contentBounds(): Box | null {
    return this.mask.contentBounds();
  }

  photoJpeg(): Promise<Blob> {
    return new Promise((resolve, reject) =>
      this.photo.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not read the photo.'))), 'image/jpeg', 0.92),
    );
  }

  dispose(): void {
    this.mask.dispose();
    this.photo.width = 0;
    this.view.width = 0;
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
    v.drawImage(this.mask.canvas, 0, 0);
    v.restore();
  }
}
