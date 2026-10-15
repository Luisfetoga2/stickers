import { describe, expect, it } from 'vitest';
import { LOW, SIDE, samInput, samMask, samPick, samScale } from './samMath';

/** 4 low-resolution guesses: each is positive inside a square of the given size at the top left. */
function guesses(sizes: number[]): Float32Array {
  const out = new Float32Array(4 * LOW * LOW).fill(-5);
  sizes.forEach((size, i) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) out[i * LOW * LOW + y * LOW + x] = 5;
  });
  return out;
}

describe('samScale', () => {
  it('makes the longest side 1024 px', () => {
    expect(samScale(640, 360)).toBe(1.6);
    expect(samScale(360, 640)).toBe(1.6);
  });
});

describe('samInput', () => {
  it('normalizes each channel and pads with zeros', () => {
    const rgba = Uint8ClampedArray.from([124, 116, 104, 255, 0, 0, 0, 255]);
    const input = samInput(rgba, 2, 1);
    expect(input[0]).toBeCloseTo(0.0056, 3);
    expect(input[SIDE * SIDE]).toBeCloseTo(-0.0049, 3);
    expect(input[1]).toBeCloseTo(-123.675 / 58.395, 4);
    expect(input[2]).toBe(0);
    expect(input[SIDE]).toBe(0);
  });
});

describe('samPick', () => {
  it('takes the largest sure guess for a tap', () => {
    expect(samPick([0.97, 0.95, 0.6, 0.85], guesses([10, 20, 100, 40]), 'largest')).toBe(3);
  });

  it('takes the best score when no guess is sure', () => {
    expect(samPick([0.5, 0.7, 0.6, 0.2], guesses([10, 20, 30, 40]), 'largest')).toBe(1);
  });

  it('takes the first guess for a stroke or a box', () => {
    expect(samPick([0.5, 0.99, 0.99, 0.99], guesses([10, 20, 30, 40]), 'first')).toBe(0);
  });
});

describe('samMask', () => {
  it('scales the guess back to the frame', () => {
    // A 512 x 256 frame scales by 2, so 1 low-resolution pixel is 2 frame pixels.
    const mask = samMask(guesses([64, 0, 0, 0]), 0, 512, 256);
    expect(mask[10 * 512 + 10]).toBe(255);
    expect(mask[120 * 512 + 120]).toBe(255);
    expect(mask[136 * 512 + 136]).toBe(0);
    expect(mask[10 * 512 + 300]).toBe(0);
  });
});
