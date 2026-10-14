/**
 * Decides which part of each animation frame to store.
 * Animated WebP frames can cover only part of the canvas, and they can last any time.
 * So a frame that does not change merges into the one before, and a frame that changes in one area stores only
 * that area. The saved bytes go into a higher quality.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A channel that moved by more than this counts as changed. Below it, video noise and dither would count. */
export const CHANGE_THRESHOLD = 10;
/** Pixels with less alpha than this are see-through, so their color does not matter. */
const INVISIBLE_ALPHA = 4;
/** When the changed area is bigger than this share of the frame, the whole frame is stored. */
const FULL_FRAME_SHARE = 0.8;

/** The smallest box around pixels that differ between two RGBA images of the same size, or null. */
export function changedBox(
  before: Uint8ClampedArray,
  after: Uint8ClampedArray,
  width: number,
  height: number,
  threshold = CHANGE_THRESHOLD,
): Rect | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    let i = y * width * 4;
    for (let x = 0; x < width; x++, i += 4) {
      const a0 = before[i + 3];
      const a1 = after[i + 3];
      if (a0 < INVISIBLE_ALPHA && a1 < INVISIBLE_ALPHA) continue;
      if (
        Math.abs(a0 - a1) > threshold ||
        Math.abs(before[i] - after[i]) > threshold ||
        Math.abs(before[i + 1] - after[i + 1]) > threshold ||
        Math.abs(before[i + 2] - after[i + 2]) > threshold
      ) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * Grows a box by a margin and keeps it on the canvas. The WebP format stores frame offsets halved,
 * so x and y become even.
 */
export function snapBox(box: Rect, size: number, margin = 2): Rect {
  const x = Math.max(0, box.x - margin) & ~1;
  const y = Math.max(0, box.y - margin) & ~1;
  const right = Math.min(size, box.x + box.width + margin);
  const bottom = Math.min(size, box.y + box.height + margin);
  return { x, y, width: right - x, height: bottom - y };
}

/** Feed it the frames in order. It remembers what the viewer sees and returns the area each frame must store. */
export class FramePlanner {
  private seen: Uint8ClampedArray | null = null;

  constructor(
    private readonly size: number,
    private readonly threshold = CHANGE_THRESHOLD,
  ) {}

  /** The area to store for this frame, or null when nothing visible changed. */
  next(pixels: Uint8ClampedArray): Rect | null {
    const full = { x: 0, y: 0, width: this.size, height: this.size };
    if (!this.seen) {
      this.seen = new Uint8ClampedArray(pixels);
      return full;
    }
    const box = changedBox(this.seen, pixels, this.size, this.size, this.threshold);
    if (!box) return null;
    let rect = snapBox(box, this.size);
    if (rect.width * rect.height > FULL_FRAME_SHARE * this.size * this.size) rect = full;
    // Compare later frames with what the viewer sees, not with the frame before.
    // Slow changes then add up until they pass the threshold, instead of drifting away unnoticed.
    for (let y = rect.y; y < rect.y + rect.height; y++) {
      const start = (y * this.size + rect.x) * 4;
      this.seen.set(pixels.subarray(start, start + rect.width * 4), start);
    }
    return rect;
  }
}
