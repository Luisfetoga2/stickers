/** Finds a start and end where a clip loops without a visible jump. */

export interface LoopResult {
  start: number;
  end: number;
  /** The share of pixels that visibly differ between the two ends, from 0 (none) to 1 (all). */
  difference: number;
}

/** Longest side of the thumbnails compared. Small is fast, and a jump shows at any size. */
export const THUMB_SIDE = 48;
/** Frames read per second while looking for a loop. */
export const LOOP_SCAN_FPS = 15;
/** How far around the current trim to look, in seconds. */
export const LOOP_SEARCH_MARGIN = 5;
export const MIN_LOOP_SECONDS = 0.6;

/** A channel difference above this is visible. Below it are video noise and compression. */
const VISIBLE_CHANGE = 24;

/**
 * The RGB values of a thumbnail. See-through pixels count as black, so a cutout compares by its shape too.
 * Color matters: a red object on green can have the same brightness as the green.
 */
export function toThumb(rgba: Uint8ClampedArray): Uint8Array {
  const rgb = new Uint8Array((rgba.length / 4) * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    const a = rgba[i + 3] / 255;
    rgb[j] = rgba[i] * a;
    rgb[j + 1] = rgba[i + 1] * a;
    rgb[j + 2] = rgba[i + 2] * a;
  }
  return rgb;
}

/**
 * The share of pixels that visibly differ between two thumbnails, from 0 to 1.
 * A share, not an average, so a small object that jumps counts fully instead of fading into the background.
 */
export function thumbDiff(a: Uint8Array, b: Uint8Array): number {
  let changed = 0;
  for (let i = 0; i < a.length; i += 3) {
    if (
      Math.abs(a[i] - b[i]) > VISIBLE_CHANGE ||
      Math.abs(a[i + 1] - b[i + 1]) > VISIBLE_CHANGE ||
      Math.abs(a[i + 2] - b[i + 2]) > VISIBLE_CHANGE
    ) {
      changed++;
    }
  }
  return changed / (a.length / 3);
}

/**
 * Picks the pair of frames that look most alike. The second frame becomes the end, so the sticker
 * jumps from the frame before it back to the start, which looks like the second frame.
 * Lengths close to the current one score a little better, so the loop does not change length for nothing.
 */
export function findLoop(
  thumbs: Uint8Array[],
  times: number[],
  minLength: number,
  maxLength: number,
  targetLength: number,
): LoopResult | null {
  let best: LoopResult | null = null;
  let bestCost = Infinity;
  for (let i = 0; i < thumbs.length; i++) {
    for (let j = i + 1; j < thumbs.length; j++) {
      const length = times[j] - times[i];
      if (length < minLength) continue;
      if (length > maxLength) break;
      // Compare the next frames too, so the motion matches and not only the picture.
      // A ball at the same spot but moving the other way would bounce at the loop point.
      const difference =
        j + 1 < thumbs.length
          ? (thumbDiff(thumbs[i], thumbs[j]) + thumbDiff(thumbs[i + 1], thumbs[j + 1])) / 2
          : thumbDiff(thumbs[i], thumbs[j]);
      // A small extra cost per share of length change. It breaks ties without beating a better match.
      const cost = difference + (0.003 * Math.abs(length - targetLength)) / Math.max(targetLength, 0.1);
      if (cost < bestCost) {
        bestCost = cost;
        best = { start: times[i], end: times[j], difference };
      }
    }
  }
  return best;
}

/** Plain words for how well the two ends match. */
export function describeLoop(difference: number): string {
  if (difference < 0.005) return 'The ends match, so the loop is smooth.';
  if (difference < 0.03) return 'The ends are close, so the jump is small.';
  return 'This is the closest match, but the jump will still show.';
}
