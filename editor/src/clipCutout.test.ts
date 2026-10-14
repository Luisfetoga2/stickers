import { describe, expect, it } from 'vitest';
import { hardenAlpha, workSize } from './clipCutout';

describe('hardenAlpha', () => {
  it('removes unsure pixels, keeps sure ones, and fades between', () => {
    const data = Uint8ClampedArray.from([0, 0, 0, 50, 0, 0, 0, 128, 0, 0, 0, 200]);
    hardenAlpha(data);
    expect(data[3]).toBe(0);
    expect(data[7]).toBeGreaterThan(100);
    expect(data[7]).toBeLessThan(160);
    expect(data[11]).toBe(255);
  });

  it('leaves color channels alone', () => {
    const data = Uint8ClampedArray.from([1, 2, 3, 200]);
    hardenAlpha(data);
    expect([...data.slice(0, 3)]).toEqual([1, 2, 3]);
  });
});

describe('workSize', () => {
  it('scales a 1080p frame to 640 px wide', () => {
    expect(workSize(1920, 1080)).toEqual({ width: 640, height: 360 });
  });

  it('keeps small frames as they are', () => {
    expect(workSize(320, 240)).toEqual({ width: 320, height: 240 });
  });
});
