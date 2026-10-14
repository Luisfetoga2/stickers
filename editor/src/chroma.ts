/** Chroma key: removes one background color, such as a green screen. Works on RGBA pixel data in place. */

export type RGB = [number, number, number];

export interface ChromaSettings {
  key: RGB;
  /** Color distance that is fully removed. About 0 to 1. */
  tolerance: number;
  /** Extra distance over which pixels fade from removed to kept. */
  softness: number;
  /** Removes the key color's tint from edges, for example green light on hair. */
  despill: boolean;
}

export const DEFAULT_CHROMA: Omit<ChromaSettings, 'key'> = {
  tolerance: 0.3,
  softness: 0.2,
  despill: true,
};

/** Darker pixels than this get no extra boost, so near-black stays black instead of turning noisy. */
const MIN_LUMA = 0.08;

/**
 * Color without brightness: the blue-difference and red-difference parts of YCbCr, divided by luma.
 * A shadowed and a lit part of the same screen get about the same value.
 */
function chromaticity(r: number, g: number, b: number): [number, number] {
  const y = Math.max(MIN_LUMA, (0.299 * r + 0.587 * g + 0.114 * b) / 255);
  return [
    (-0.168736 * r - 0.331264 * g + 0.5 * b) / 255 / y,
    (0.5 * r - 0.418688 * g - 0.081312 * b) / 255 / y,
  ];
}

/**
 * Sets alpha by color distance from the key, ignoring brightness, so shadows on the screen are removed too.
 * Existing alpha is kept and multiplied.
 */
export function chromaKey(data: Uint8ClampedArray, s: ChromaSettings): void {
  const [kcb, kcr] = chromaticity(...s.key);
  const lo = s.tolerance;
  const span = Math.max(1e-6, s.softness);

  // Despill only works when the key has one clear main channel, as green and blue screens do.
  const k = s.key.indexOf(Math.max(...s.key));
  const [o1, o2] = [0, 1, 2].filter((c) => c !== k);
  const despill = s.despill && s.key[k] - Math.max(s.key[o1], s.key[o2]) > 30;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const y = Math.max(MIN_LUMA, (0.299 * r + 0.587 * g + 0.114 * b) / 255);
    const dcb = (-0.168736 * r - 0.331264 * g + 0.5 * b) / 255 / y - kcb;
    const dcr = (0.5 * r - 0.418688 * g - 0.081312 * b) / 255 / y - kcr;
    const d = Math.sqrt(dcb * dcb + dcr * dcr);
    const a = d <= lo ? 0 : d >= lo + span ? 1 : (d - lo) / span;
    if (a > 0 && despill) {
      const limit = Math.max(data[i + o1], data[i + o2]);
      if (data[i + k] > limit) data[i + k] = limit;
    }
    data[i + 3] = Math.round(data[i + 3] * a);
  }
}

/**
 * Guesses the screen color from the border of a frame.
 * It uses the brighter half of the border pixels, because dark corners and shadows show the color poorly.
 */
export function detectKeyColor(data: Uint8ClampedArray, width: number, height: number): RGB {
  const samples: RGB[] = [];
  const sample = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    samples.push([data[i], data[i + 1], data[i + 2]]);
  };
  const inset = Math.min(2, width - 1, height - 1);
  for (let x = 0; x < width; x += 2) {
    sample(x, inset);
    sample(x, height - 1 - inset);
  }
  for (let y = 0; y < height; y += 2) {
    sample(inset, y);
    sample(width - 1 - inset, y);
  }
  const luma = ([r, g, b]: RGB) => 0.299 * r + 0.587 * g + 0.114 * b;
  const bright = samples.sort((p, q) => luma(q) - luma(p)).slice(0, Math.max(1, Math.ceil(samples.length / 2)));
  const median = (channel: number) => {
    const sorted = bright.map((c) => c[channel]).sort((p, q) => p - q);
    return sorted[Math.floor(sorted.length / 2)];
  };
  return [median(0), median(1), median(2)];
}

export function toHex([r, g, b]: RGB): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}
