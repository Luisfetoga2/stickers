import { describe, expect, it } from 'vitest';
import { fallbackFps, frameTimes, pickQuality } from './animate';

describe('frameTimes', () => {
  it('spaces frames evenly from the start', () => {
    expect(frameTimes(1, 2, 4)).toEqual([1, 1.25, 1.5, 1.75]);
  });

  it('always returns at least one frame', () => {
    expect(frameTimes(3, 3.01, 8)).toEqual([3]);
  });
});

describe('fallbackFps', () => {
  it('tries lower frame rates after the chosen one', () => {
    expect(fallbackFps(12)).toEqual([12, 10, 8, 6, 5]);
    expect(fallbackFps(8)).toEqual([8, 6, 5]);
  });
});

describe('pickQuality', () => {
  it('picks the best quality whose estimate fits under 90% of the limit', () => {
    // 2 sample frames, 20 frames in total, limit 1000. A quality fits when the sample sum is 90 or less.
    const sizes = new Map([
      [0.85, 200],
      [0.75, 120],
      [0.65, 90],
      [0.55, 60],
    ]);
    expect(pickQuality(sizes, 2, 20, 1000)).toBe(0.65);
  });

  it('falls back to the lowest quality', () => {
    expect(pickQuality(new Map([[0.85, 999]]), 1, 10, 100)).toBe(0.25);
  });
});
