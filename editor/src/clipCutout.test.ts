import { describe, expect, it } from 'vitest';
import { smoothingWeights } from './clipCutout';

describe('smoothingWeights', () => {
  it('blends a middle frame with both neighbors', () => {
    expect(smoothingWeights(5, 10)).toEqual([
      [4, 0.25],
      [5, 0.5],
      [6, 0.25],
    ]);
  });

  it('shares out the missing neighbor at the first frame', () => {
    const w = smoothingWeights(0, 10);
    expect(w.map(([j]) => j)).toEqual([0, 1]);
    expect(w[0][1]).toBeCloseTo(2 / 3, 6);
    expect(w[1][1]).toBeCloseTo(1 / 3, 6);
  });

  it('uses the frame alone when there is only one', () => {
    expect(smoothingWeights(0, 1)).toEqual([[0, 1]]);
  });
});
