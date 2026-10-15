/**
 * Follows one object through a clip for Keep and Remove.
 * The user marks the object in one frame. For each next frame, the app marks the point deepest inside the
 * object's last outline, which stays on the object when it moves a little.
 */
import type { Point } from './transform';

/** Grid cell size, in pixels, for finding the deepest point. Coarse is fast and steady. */
const CELL = 8;
/** The object counts as lost when its area grows or shrinks more than this between two frames. */
const MAX_AREA_CHANGE = 3;

export function maskArea(mask: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] > 127) n++;
  return n;
}

/**
 * The point deepest inside a mask, in pixels: the cell farthest from the edge on a coarse grid.
 * Returns null for an empty mask. For a thin object that fills no whole cell, it returns a pixel of the object.
 */
export function innerPoint(mask: Uint8Array, width: number, height: number): Point | null {
  const gw = Math.ceil(width / CELL);
  const gh = Math.ceil(height / CELL);
  const grid = new Float64Array(gw * gh);
  let anyPixel = -1;
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      let inside = 0;
      let total = 0;
      for (let y = gy * CELL; y < Math.min(height, (gy + 1) * CELL); y++) {
        for (let x = gx * CELL; x < Math.min(width, (gx + 1) * CELL); x++) {
          total++;
          if (mask[y * width + x] > 127) {
            inside++;
            if (anyPixel < 0) anyPixel = y * width + x;
          }
        }
      }
      // Cells at least half inside count. Others get distance 0, as edges.
      grid[gy * gw + gx] = inside * 2 >= total ? Infinity : 0;
    }
  }
  if (anyPixel < 0) return null;

  // Two-pass chamfer distance: each inside cell gets its distance to the nearest outside cell.
  // Cells past the frame border count as outside, so an object cut by the border is measured from it too.
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= gw || y >= gh ? 0 : grid[y * gw + x]);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const i = y * gw + x;
      if (grid[i] === 0) continue;
      grid[i] = Math.min(grid[i], at(x - 1, y) + 1, at(x, y - 1) + 1, at(x - 1, y - 1) + 1.4, at(x + 1, y - 1) + 1.4);
    }
  }
  for (let y = gh - 1; y >= 0; y--) {
    for (let x = gw - 1; x >= 0; x--) {
      const i = y * gw + x;
      if (grid[i] === 0) continue;
      grid[i] = Math.min(grid[i], at(x + 1, y) + 1, at(x, y + 1) + 1, at(x + 1, y + 1) + 1.4, at(x - 1, y + 1) + 1.4);
    }
  }

  // Among the deepest cells, take the one closest to the object's center, so the point sits in the middle
  // and stays on the object whichever way it moves.
  let mx = 0;
  let my = 0;
  let mn = 0;
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] > 0) {
      mx += i % gw;
      my += Math.floor(i / gw);
      mn++;
    }
  }
  let best = -1;
  let bestDepth = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] === 0) continue;
    const distance = Math.hypot((i % gw) - mx / mn, Math.floor(i / gw) - my / mn);
    if (grid[i] > bestDepth + 1e-9 || (Math.abs(grid[i] - bestDepth) < 1e-9 && distance < bestDistance)) {
      best = i;
      bestDepth = grid[i];
      bestDistance = distance;
    }
  }
  if (best < 0) return { x: (anyPixel % width) + 0.5, y: Math.floor(anyPixel / width) + 0.5 };

  // The cell can be only half covered, so its center can miss the object. Use the object's pixels in it instead.
  const cx = (best % gw) * CELL;
  const cy = Math.floor(best / gw) * CELL;
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let y = cy; y < Math.min(height, cy + CELL); y++) {
    for (let x = cx; x < Math.min(width, cx + CELL); x++) {
      if (mask[y * width + x] > 127) {
        sx += x;
        sy += y;
        n++;
      }
    }
  }
  return { x: sx / n + 0.5, y: sy / n + 0.5 };
}

/** True when the new mask is still the same object: it covers the marked point and its size did not jump. */
export function sameObject(previousArea: number, mask: Uint8Array, width: number, point: Point): boolean {
  const area = maskArea(mask);
  if (area === 0) return false;
  if (area > previousArea * MAX_AREA_CHANGE || area * MAX_AREA_CHANGE < previousArea) return false;
  return mask[Math.floor(point.y) * width + Math.floor(point.x)] > 127;
}

/** Marks pixels in one frame and returns that frame's object mask. Points are in pixels. */
export type SegmentFrame = (index: number, points: Point[]) => Promise<Uint8Array>;

export interface TrackResult {
  /** One mask per frame, or null where the object was lost. */
  masks: Array<Uint8Array | null>;
  found: number;
}

/**
 * Finds the object in the start frame from the user's points, then follows it forward and backward.
 * Following stops in a direction when the object leaves the picture or changes too much,
 * so one wrong frame does not spread through the rest of the clip.
 */
export async function trackObject(
  count: number,
  start: number,
  points: Point[],
  width: number,
  height: number,
  segment: SegmentFrame,
  onStep: (done: number) => void,
  signal?: AbortSignal,
): Promise<TrackResult> {
  const masks: Array<Uint8Array | null> = new Array(count).fill(null);
  const first = await segment(start, points);
  if (maskArea(first) === 0) throw new Error('Nothing was found there. Tap or scribble on the middle of the object.');
  masks[start] = first;
  let done = 1;
  onStep(done);

  for (const step of [1, -1]) {
    let previous = first;
    for (let i = start + step; i >= 0 && i < count; i += step) {
      signal?.throwIfAborted();
      const point = innerPoint(previous, width, height);
      if (!point) break;
      const mask = await segment(i, [point]);
      onStep(++done);
      if (!sameObject(maskArea(previous), mask, width, point)) break;
      masks[i] = mask;
      previous = mask;
    }
  }
  return { masks, found: masks.filter((m) => m !== null).length };
}
