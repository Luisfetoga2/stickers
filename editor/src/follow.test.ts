import { describe, expect, it } from 'vitest';
import { alphaCenter, fillGaps, followOffsets, smoothPath } from './follow';

describe('alphaCenter', () => {
  it('finds the center of the visible pixels', () => {
    const width = 4;
    const data = new Uint8ClampedArray(width * 2 * 4);
    data[(0 * width + 2) * 4 + 3] = 255;
    data[(1 * width + 2) * 4 + 3] = 255;
    expect(alphaCenter(data, width, 2)).toEqual({ x: 2.5, y: 1 });
  });

  it('returns null when everything is see-through', () => {
    expect(alphaCenter(new Uint8ClampedArray(16), 2, 2)).toBeNull();
  });
});

describe('fillGaps', () => {
  it('repeats the last known center over frames with no subject', () => {
    const a = { x: 1, y: 1 };
    const b = { x: 5, y: 5 };
    expect(fillGaps([null, a, null, b], { x: 0, y: 0 })).toEqual([a, a, a, b]);
  });

  it('uses the fallback when no frame has a subject', () => {
    expect(fillGaps([null, null], { x: 9, y: 9 })).toEqual([
      { x: 9, y: 9 },
      { x: 9, y: 9 },
    ]);
  });
});

describe('smoothPath', () => {
  it('averages each point with its neighbors', () => {
    const path = smoothPath([{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 0, y: 0 }], 1);
    expect(path[1]).toEqual({ x: 1, y: 0 });
  });

  it('keeps steady motion exact, also at the ends', () => {
    const line = Array.from({ length: 10 }, (_, i) => ({ x: i * 5, y: 0 }));
    expect(smoothPath(line, 3)).toEqual(line);
  });
});

describe('followOffsets', () => {
  it('moves each frame so the subject sits at its average position', () => {
    const centers = Array.from({ length: 20 }, (_, i) => ({ x: i < 10 ? 10 : 30, y: 50 }));
    const offsets = followOffsets(centers);
    // The subject jumps from x 10 to x 30, so the first frames move right and the last frames move left.
    expect(offsets[0].x).toBeCloseTo(10, 5);
    expect(offsets[19].x).toBeCloseTo(-10, 5);
    expect(offsets[0].x).toBeGreaterThan(offsets[9].x);
    expect(offsets.every((o) => Math.abs(o.y) < 1e-9)).toBe(true);
  });

  it('keeps a still subject still', () => {
    expect(followOffsets([{ x: 5, y: 5 }, { x: 5, y: 5 }])).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ]);
  });
});
