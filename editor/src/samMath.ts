/**
 * The steps around EdgeSAM (a small Segment Anything model): the frame goes in as a 1024 px square,
 * and 4 low-resolution guesses come out. The app does the same steps in Java (Sam.java).
 */
export const SIDE = 1024;
export const LOW = 256;
const MEAN = [123.675, 116.28, 103.53];
const STD = [58.395, 57.12, 57.375];
/** A tap takes the largest guess that the model is at least this sure of. */
const SURE = 0.8;

/** Frame pixels times this give model pixels: the longest side becomes 1024. */
export function samScale(width: number, height: number): number {
  return SIDE / Math.max(width, height);
}

/**
 * The model's input from RGBA pixels already resized by samScale: channels first, normalized,
 * and padded with zeros on the right and bottom to 1024 x 1024.
 */
export function samInput(rgba: Uint8ClampedArray, width: number, height: number): Float32Array {
  const plane = SIDE * SIDE;
  const out = new Float32Array(3 * plane);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const o = y * SIDE + x;
      for (let c = 0; c < 3; c++) out[c * plane + o] = (rgba[i + c] - MEAN[c]) / STD[c];
    }
  }
  return out;
}

/** Which of the 4 guesses to use. masks holds 4 low-resolution masks, one after another. */
export function samPick(scores: ArrayLike<number>, masks: Float32Array, pick: 'largest' | 'first'): number {
  if (pick === 'first') return 0;
  let best = 0;
  for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
  let chosen = -1;
  let chosenArea = -1;
  for (let i = 0; i < scores.length; i++) {
    if (scores[i] < SURE) continue;
    let area = 0;
    for (let k = i * LOW * LOW; k < (i + 1) * LOW * LOW; k++) if (masks[k] > 0) area++;
    if (area > chosenArea) {
      chosen = i;
      chosenArea = area;
    }
  }
  return chosen < 0 ? best : chosen;
}

/** One low-resolution guess, scaled back to the frame: 255 inside the object, 0 outside. */
export function samMask(masks: Float32Array, index: number, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  const step = samScale(width, height) / (SIDE / LOW);
  const base = index * LOW * LOW;
  for (let y = 0; y < height; y++) {
    const fy = Math.min(LOW - 1, Math.max(0, (y + 0.5) * step - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(LOW - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(LOW - 1, Math.max(0, (x + 0.5) * step - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(LOW - 1, x0 + 1);
      const wx = fx - x0;
      const top = masks[base + y0 * LOW + x0] * (1 - wx) + masks[base + y0 * LOW + x1] * wx;
      const bottom = masks[base + y1 * LOW + x0] * (1 - wx) + masks[base + y1 * LOW + x1] * wx;
      out[y * width + x] = top * (1 - wy) + bottom * wy > 0 ? 255 : 0;
    }
  }
  return out;
}

/** The reverse of Sam.pack in the app: count masks of size pixels from bits, as 0 or 255 per pixel. */
export function unpackBits(bits: Uint8Array, count: number, size: number): Uint8Array[] {
  const masks: Uint8Array[] = [];
  for (let m = 0; m < count; m++) {
    const mask = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      const bit = m * size + i;
      if (bits[bit >> 3] & (1 << (bit & 7))) mask[i] = 255;
    }
    masks.push(mask);
  }
  return masks;
}
