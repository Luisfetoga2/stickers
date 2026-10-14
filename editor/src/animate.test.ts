import { describe, expect, it } from 'vitest';
import { ANIMATED_LIMIT, QUALITIES, bestQuality, estimateSizes, fits, frameTimes } from './animate';

describe('frameTimes', () => {
  it('spaces frames evenly from the start', () => {
    expect(frameTimes(1, 2, 4)).toEqual([1, 1.25, 1.5, 1.75]);
  });

  it('always returns at least one frame', () => {
    expect(frameTimes(3, 3.01, 8)).toEqual([3]);
  });
});

describe('estimateSizes', () => {
  it('scales sample sizes by area and adds the container bytes', () => {
    const estimates = estimateSizes(new Map([[0.9, 1000]]), 10, 40);
    expect(estimates.get(0.9)).toBe(10040);
  });
});

describe('bestQuality', () => {
  const sizes = (bytes: number[]) => new Map(QUALITIES.map((q, i) => [q, bytes[i]]));

  it('picks the sharpest level that fits under 90% of the limit', () => {
    const kb = 1024;
    const estimates = sizes([700, 600, 500, 440, 400, 300, 200, 150, 100].map((k) => k * kb));
    expect(bestQuality(estimates)).toBe(QUALITIES[3]);
  });

  it('returns null when even the lowest level is too big', () => {
    expect(bestQuality(sizes(QUALITIES.map(() => ANIMATED_LIMIT)))).toBeNull();
  });
});

describe('fits', () => {
  it('keeps a 10% margin under the limit', () => {
    expect(fits(ANIMATED_LIMIT * 0.9)).toBe(true);
    expect(fits(ANIMATED_LIMIT * 0.95)).toBe(false);
  });
});
