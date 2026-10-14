/** Finds a start and end where a clip loops without a visible jump. */

export interface LoopResult {
  start: number;
  end: number;
  /** How different the two ends look, from 0 (same) to 1. */
  difference: number;
}

/** Longest side of the thumbnails compared. Small is fast, and a jump shows at any size. */
export const THUMB_SIDE = 48;
/** Frames read per second while looking for a loop. */
export const LOOP_SCAN_FPS = 15;
/** How far around the current trim to look, in seconds. */
export const LOOP_SEARCH_MARGIN = 5;
export const MIN_LOOP_SECONDS = 0.6;

/** Grayscale values of a thumbnail. See-through pixels count as black, so a cutout compares by its shape too. */
export function toGray(rgba: Uint8ClampedArray): Uint8Array {
  const gray = new Uint8Array(rgba.length / 4);
  for (let i = 0, j = 0; j < gray.length; i += 4, j++) {
    gray[j] = ((0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]) * rgba[i + 3]) / 255;
  }
  return gray;
}

/** Mean absolute difference of two grayscale thumbnails, from 0 (same) to 1. */
export function thumbDiff(a: Uint8Array, b: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length / 255;
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
      const difference = thumbDiff(thumbs[i], thumbs[j]);
      // A small extra cost per share of length change. It breaks ties without beating a clearly better match.
      const cost = difference + (0.02 * Math.abs(length - targetLength)) / Math.max(targetLength, 0.1);
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
  if (difference < 0.02) return 'The ends match, so the loop is smooth.';
  if (difference < 0.05) return 'The ends are close, so the jump is small.';
  return 'This is the closest match, but the jump will still show.';
}
