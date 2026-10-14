import { describe, expect, it } from 'vitest';
import { describeLoop, findLoop, thumbDiff, toGray } from './loop';

const thumb = (...values: number[]) => Uint8Array.from(values);

describe('toGray', () => {
  it('turns RGBA into brightness, with see-through pixels as black', () => {
    expect([...toGray(Uint8ClampedArray.from([255, 255, 255, 255, 255, 255, 255, 0]))]).toEqual([255, 0]);
  });
});

describe('thumbDiff', () => {
  it('is 0 for the same thumbnail and 1 for opposite ones', () => {
    expect(thumbDiff(thumb(10, 20), thumb(10, 20))).toBe(0);
    expect(thumbDiff(thumb(0, 0), thumb(255, 255))).toBe(1);
  });
});

describe('findLoop', () => {
  // A clip that cycles through 4 looks: A B C D A B C D ...
  const looks = [thumb(0, 0), thumb(80, 80), thumb(160, 160), thumb(240, 240)];
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

  it('respects the shortest and longest length', () => {
    expect(findLoop(thumbs, times, 3, 3.4, 3)).toMatchObject({ difference: expect.any(Number) });
    expect(findLoop(thumbs, times, 20, 30, 25)).toBeNull();
  });
});

describe('describeLoop', () => {
  it('names how well the ends match', () => {
    expect(describeLoop(0.01)).toContain('smooth');
    expect(describeLoop(0.03)).toContain('small');
    expect(describeLoop(0.2)).toContain('still show');
  });
});
