/** Follow the subject: moves each frame so the cut-out subject stays in one place on the sticker. */

import type { Point } from './transform';

/** Frames on each side that the path averages over. More is steadier but reacts later. */
const SMOOTHING_RADIUS = 3;

/**
 * The alpha-weighted center of an RGBA image, or null when it is all see-through.
 * The weight makes the center follow the body of the subject, not a stray pixel at the edge.
 */
export function alphaCenter(rgba: Uint8ClampedArray, width: number, height: number): Point | null {
  let sum = 0;
  let sx = 0;
  let sy = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = rgba[(y * width + x) * 4 + 3];
      if (a === 0) continue;
      sum += a;
      sx += x * a;
      sy += y * a;
    }
  }
  return sum === 0 ? null : { x: sx / sum + 0.5, y: sy / sum + 0.5 };
}

/** Fills frames with no subject from the nearest frame before them, or after them at the start. */
export function fillGaps(centers: Array<Point | null>, fallback: Point): Point[] {
  const first = centers.find((c): c is Point => c !== null) ?? fallback;
  let last = first;
  return centers.map((c) => (last = c ?? last));
}

/** A moving average, so the sticker does not shake with every small change in the cutout. */
export function smoothPath(points: Point[], radius = SMOOTHING_RADIUS): Point[] {
  return points.map((_, i) => {
    let x = 0;
    let y = 0;
    let n = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(points.length - 1, i + radius); j++) {
      x += points[j].x;
      y += points[j].y;
      n++;
    }
    return { x: x / n, y: y / n };
  });
}

/**
 * How far to move each frame's content, in the same units as the centers.
 * The subject stays at its average position, so the framing the user picked still fits overall.
 */
export function followOffsets(centers: Point[]): Point[] {
  const path = smoothPath(centers);
  const mean = path.reduce((m, p) => ({ x: m.x + p.x / path.length, y: m.y + p.y / path.length }), { x: 0, y: 0 });
  return path.map((p) => ({ x: mean.x - p.x, y: mean.y - p.y }));
}
