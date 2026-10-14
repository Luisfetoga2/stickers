import { describe, expect, it } from 'vitest';
import { describeLoop, findLoop, thumbDiff, toThumb } from './loop';

/** A thumbnail of n pixels, all one RGB color. */
const solid = (n: number, rgb: [number, number, number]) => Uint8Array.from({ length: n * 3 }, (_, i) => rgb[i % 3]);

describe('toThumb', () => {
  it('keeps RGB, with see-through pixels as black', () => {
    expect([...toThumb(Uint8ClampedArray.from([200, 100, 50, 255, 200, 100, 50, 0]))]).toEqual([200, 100, 50, 0, 0, 0]);
  });
});

describe('thumbDiff', () => {
  it('is 0 for the same thumbnail and 1 when every pixel changed', () => {
    expect(thumbDiff(solid(4, [10, 20, 30]), solid(4, [10, 20, 30]))).toBe(0);
    expect(thumbDiff(solid(4, [0, 0, 0]), solid(4, [255, 255, 255]))).toBe(1);
  });

  it('ignores noise below the visible change', () => {
    expect(thumbDiff(solid(4, [100, 100, 100]), solid(4, [110, 90, 115]))).toBe(0);
  });

  it('counts a red object on green, even when both have the same brightness', () => {
    const green = solid(4, [0, 177, 64]);
    const withRed = Uint8Array.from(green);
    withRed.set([208, 48, 48], 0);
    expect(thumbDiff(green, withRed)).toBe(0.25);
  });
});

describe('findLoop', () => {
  // A clip that cycles through 4 looks: A B C D A B C D ...
  const looks = [solid(2, [0, 0, 0]), solid(2, [80, 80, 80]), solid(2, [160, 160, 160]), solid(2, [240, 240, 240])];
  const thumbs = Array.from({ length: 12 }, (_, i) => looks[i % 4]);
  const times = thumbs.map((_, i) => i * 0.5);

  it('finds a pair of matching frames', () => {
    const loop = findLoop(thumbs, times, 1, 10, 2);
    expect(loop?.difference).toBe(0);
    expect(loop!.end - loop!.start).toBe(2);
  });

  it('prefers the length closest to the current one among equal matches', () => {
    const loop = findLoop(thumbs, times, 1, 10, 4.2);
    expect(loop!.end - loop!.start).toBe(4);
  });

  it('picks an exact match over a close length', () => {
    // The current length is 2.5, but only 2 and 4 loop exactly.
    const loop = findLoop(thumbs, times, 1, 10, 2.5);
    expect(loop?.difference).toBe(0);
  });

  it('skips a match where the motion goes the other way', () => {
    // A ball goes right then left: positions 0 1 2 3 2 1 0 1 2 3 2 1 0. The frames at 1 s and 2.5 s both show
    // position 2, but the ball moves right at 1 s and left at 2.5 s. Only a full period loops without a bounce.
    const at = (p: number) => {
      const t = solid(4, [0, 0, 0]);
      t.set([255, 255, 255], p * 3);
      return t;
    };
    const path = [0, 1, 2, 3, 2, 1, 0, 1, 2, 3, 2, 1, 0];
    const balls = path.map(at);
    const ballTimes = path.map((_, i) => i * 0.5);
    const loop = findLoop(balls, ballTimes, 1, 10, 1.5);
    expect(loop?.difference).toBe(0);
    expect(loop!.end - loop!.start).toBe(3);
  });

  it('respects the shortest and longest length', () => {
    expect(findLoop(thumbs, times, 3, 3.4, 3)).toMatchObject({ difference: expect.any(Number) });
    expect(findLoop(thumbs, times, 20, 30, 25)).toBeNull();
  });
});

describe('describeLoop', () => {
  it('names how well the ends match', () => {
    expect(describeLoop(0.001)).toContain('smooth');
    expect(describeLoop(0.01)).toContain('small');
    expect(describeLoop(0.2)).toContain('still show');
  });
});
