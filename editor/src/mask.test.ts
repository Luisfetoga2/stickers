import { describe, expect, it } from 'vitest';
import { alphaBounds } from './mask';

/** RGBA data where only the listed pixels are opaque. */
function pixels(width: number, height: number, opaque: Array<[number, number]>): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (const [x, y] of opaque) data[(y * width + x) * 4 + 3] = 255;
  return data;
}

describe('alphaBounds', () => {
  it('finds the box around opaque pixels', () => {
    expect(alphaBounds(pixels(10, 8, [[2, 3], [6, 5]]), 10, 8)).toEqual({ x: 2, y: 3, width: 5, height: 3 });
  });

  it('returns null when everything is transparent', () => {
    expect(alphaBounds(pixels(4, 4, []), 4, 4)).toBeNull();
  });

  it('ignores nearly transparent pixels', () => {
    const data = pixels(4, 4, [[1, 1]]);
    data[(3 * 4 + 3) * 4 + 3] = 10;
    expect(alphaBounds(data, 4, 4)).toEqual({ x: 1, y: 1, width: 1, height: 1 });
  });
});
