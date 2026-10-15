/**
 * Follows one object through a clip for Keep and Remove.
 * The user marks the object in one frame. For each next frame, the model gets a box around the object's last
 * outline and the point deepest inside it, which stays on the object when it moves a little.
 */
import type { Point } from './transform';

/** Grid cell size, in pixels, for finding the deepest point. Coarse is fast and steady. */
const CELL = 8;
/**
 * The object counts as lost when its area grows or shrinks more than this between two frames.
 * A real object rarely doubles in one frame. A bigger jump means the model took something else too.
 */
const MAX_AREA_CHANGE = 2;

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

/**
 * What the model gets for one frame, in pixels. Labels: 1 marks the object, 2 and 3 are a box's
 * top-left and bottom-right corners.
 * pick: the model answers with 4 guesses, from a small part to the whole object. "largest" takes the largest
 * confident one, which suits a single tap. "first" takes the model's one answer for several marks or a box.
 */
export interface Prompt {
  points: Point[];
  labels: number[];
  pick: 'largest' | 'first';
  /** Return all 4 guesses, so the user can pick a smaller or larger one. */
  all?: boolean;
}

/** Marks no farther apart than this share of the frame count as one tap. */
const TAP_SIZE = 0.03;
/** A stroke goes to the model as at most this many points, spread along it. */
const STROKE_POINTS = 12;
/** The box around the object in the last frame grows by this share on each side, so the object can move. */
const BOX_MARGIN = 0.05;

/** The prompt for the user's own marks: one tap, or points along a stroke. */
export function marksPrompt(points: Point[], width: number, height: number): Prompt {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const size = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  if (size <= TAP_SIZE * Math.max(width, height)) {
    const center = { x: xs.reduce((a, b) => a + b, 0) / xs.length, y: ys.reduce((a, b) => a + b, 0) / ys.length };
    return { points: [center], labels: [1], pick: 'largest' };
  }
  const n = Math.min(STROKE_POINTS, points.length);
  const spread = Array.from({ length: n }, (_, i) => points[Math.round((i * (points.length - 1)) / Math.max(1, n - 1))]);
  return { points: spread, labels: spread.map(() => 1), pick: 'first' };
}

/** The smallest box around the mask's pixels, or null for an empty mask. */
export function maskBox(mask: Uint8Array, width: number, height: number) {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] > 127) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

/**
 * The prompt for the next frame: a point deep inside the object in the last frame, and a box a little larger
 * than it was. The box keeps the whole object, and the point says which object is meant.
 */
export function followPrompt(previous: Uint8Array, width: number, height: number): Prompt | null {
  const point = innerPoint(previous, width, height);
  const box = maskBox(previous, width, height);
  if (!point || !box) return null;
  const mx = (box.x1 - box.x0) * BOX_MARGIN;
  const my = (box.y1 - box.y0) * BOX_MARGIN;
  return {
    points: [
      point,
      { x: Math.max(0, box.x0 - mx), y: Math.max(0, box.y0 - my) },
      { x: Math.min(width, box.x1 + mx), y: Math.min(height, box.y1 + my) },
    ],
    labels: [1, 2, 3],
    pick: 'first',
  };
}

/**
 * Splits a mask into components: groups of object pixels that touch, side by side or corner to corner.
 * Returns a component number per pixel (0 outside the object, then 1, 2, …) and the count.
 */
export function components(mask: Uint8Array, width: number, height: number): { labels: Int32Array; count: number } {
  const labels = new Int32Array(width * height);
  const stack: number[] = [];
  let count = 0;
  for (let i = 0; i < labels.length; i++) {
    if (mask[i] <= 127 || labels[i] !== 0) continue;
    count++;
    labels[i] = count;
    stack.push(i);
    while (stack.length > 0) {
      const j = stack.pop()!;
      const x = j % width;
      const y = (j - x) / width;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const k = ny * width + nx;
          if (mask[k] > 127 && labels[k] === 0) {
            labels[k] = count;
            stack.push(k);
          }
        }
      }
    }
  }
  return { labels, count };
}

/** A new mask with only the chosen components of labels. */
function only(labels: Int32Array, keep: Set<number>): Uint8Array {
  const out = new Uint8Array(labels.length);
  for (let i = 0; i < labels.length; i++) if (keep.has(labels[i])) out[i] = 255;
  return out;
}

/** How far around a mark point a component still counts as touched, in pixels. */
const TOUCH_RADIUS = 6;

/**
 * Keeps the parts of a mask that the user's marks touch. The model sometimes adds things elsewhere in the
 * frame that look alike, and the user never marked those. When no part is touched, such as a tap in a hole,
 * the part nearest to the first mark stays.
 */
export function keepTouched(mask: Uint8Array, width: number, height: number, points: Point[]): Uint8Array {
  const { labels, count } = components(mask, width, height);
  if (count <= 1) return mask;
  const keep = new Set<number>();
  for (const p of points) {
    const px = Math.floor(p.x);
    const py = Math.floor(p.y);
    for (let y = Math.max(0, py - TOUCH_RADIUS); y <= Math.min(height - 1, py + TOUCH_RADIUS); y++) {
      for (let x = Math.max(0, px - TOUCH_RADIUS); x <= Math.min(width - 1, px + TOUCH_RADIUS); x++) {
        const label = labels[y * width + x];
        if (label !== 0) keep.add(label);
      }
    }
  }
  if (keep.size === 0) {
    let best = 0;
    let bestDistance = Infinity;
    const p = points[0];
    for (let i = 0; i < labels.length; i++) {
      if (labels[i] === 0) continue;
      const d = Math.hypot((i % width) - p.x, Math.floor(i / width) - p.y);
      if (d < bestDistance) {
        bestDistance = d;
        best = labels[i];
      }
    }
    keep.add(best);
  }
  return only(labels, keep);
}

/** The box around the object in the last frame grows by this share on each side for keepNear. */
const NEAR_MARGIN = 0.25;

/**
 * Keeps the parts of a new frame's mask that belong to the object followed from the last frame:
 * parts that overlap its last mask, or whose middle lies in its last box, grown by a margin.
 * A part far away is something else that looks alike, so it goes.
 */
export function keepNear(mask: Uint8Array, previous: Uint8Array, width: number, height: number): Uint8Array {
  const { labels, count } = components(mask, width, height);
  const box = maskBox(previous, width, height);
  if (count === 0 || !box) return mask;
  const mx = (box.x1 - box.x0) * NEAR_MARGIN;
  const my = (box.y1 - box.y0) * NEAR_MARGIN;
  const sx = new Float64Array(count + 1);
  const sy = new Float64Array(count + 1);
  const n = new Float64Array(count + 1);
  const keep = new Set<number>();
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    if (label === 0) continue;
    if (previous[i] > 127) keep.add(label);
    sx[label] += i % width;
    sy[label] += Math.floor(i / width);
    n[label]++;
  }
  for (let label = 1; label <= count; label++) {
    const cx = sx[label] / n[label];
    const cy = sy[label] / n[label];
    if (cx >= box.x0 - mx && cx <= box.x1 + mx && cy >= box.y0 - my && cy <= box.y1 + my) keep.add(label);
  }
  return keep.size === count ? mask : only(labels, keep);
}

/** Two guesses this alike (shared pixels over all their pixels) count as the same, so only one is offered. */
const SAME_GUESS = 0.92;

function overlap(a: Uint8Array, b: Uint8Array): number {
  let both = 0;
  let either = 0;
  for (let i = 0; i < a.length; i++) {
    const inA = a[i] > 127;
    const inB = b[i] > 127;
    if (inA && inB) both++;
    if (inA || inB) either++;
  }
  return either === 0 ? 1 : both / either;
}

/**
 * The model's guesses as choices for the user, smallest first: cleaned by keepTouched, without empty ones
 * and without near copies. index is the choice that matches the guess the pick rule took.
 */
export function guessOptions(
  guesses: Uint8Array[],
  chosen: number,
  width: number,
  height: number,
  points: Point[],
): { options: Uint8Array[]; index: number } {
  const cleaned = guesses
    .map((mask, i) => ({ mask: keepTouched(mask, width, height, points), chosen: i === chosen }))
    .map((g) => ({ ...g, area: maskArea(g.mask) }))
    .filter((g) => g.area > 0)
    .sort((a, b) => a.area - b.area);
  const options: Array<{ mask: Uint8Array; chosen: boolean }> = [];
  for (const g of cleaned) {
    const same = options.find((o) => overlap(o.mask, g.mask) >= SAME_GUESS);
    if (same) same.chosen ||= g.chosen;
    else options.push({ mask: g.mask, chosen: g.chosen });
  }
  return { options: options.map((o) => o.mask), index: Math.max(0, options.findIndex((o) => o.chosen)) };
}

/** Finds the object in one frame from a prompt. With prompt.all it returns the model's 4 guesses, otherwise one. */
export type SegmentFrame = (index: number, prompt: Prompt) => Promise<Uint8Array[]>;

export interface TrackResult {
  /** One mask per frame, or null where the object was lost. */
  masks: Array<Uint8Array | null>;
  found: number;
}

/**
 * Follows the object the user picked in the start frame forward and backward through the clip.
 * Following stops in a direction when the object leaves the picture or changes too much,
 * so one wrong frame does not spread through the rest of the clip.
 */
export async function followObject(
  count: number,
  start: number,
  first: Uint8Array,
  width: number,
  height: number,
  segment: SegmentFrame,
  onStep: (done: number) => void,
  signal?: AbortSignal,
): Promise<TrackResult> {
  const masks: Array<Uint8Array | null> = new Array(count).fill(null);
  masks[start] = first;
  let done = 1;
  onStep(done);

  for (const step of [1, -1]) {
    let previous = first;
    for (let i = start + step; i >= 0 && i < count; i += step) {
      signal?.throwIfAborted();
      const prompt = followPrompt(previous, width, height);
      if (!prompt) break;
      // Of the model's guesses, the one most like the last frame keeps the size the user picked.
      let mask: Uint8Array | null = null;
      let best = -1;
      for (const guess of await segment(i, { ...prompt, all: true })) {
        const near = keepNear(guess, previous, width, height);
        const score = overlap(near, previous);
        if (score > best) {
          best = score;
          mask = near;
        }
      }
      onStep(++done);
      if (!mask) break;
      if (!sameObject(maskArea(previous), mask, width, prompt.points[0])) break;
      masks[i] = mask;
      previous = mask;
    }
  }
  return { masks, found: masks.filter((m) => m !== null).length };
}
