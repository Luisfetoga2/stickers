import { describe, expect, it } from 'vitest';
import { applyObject, hardenAlpha, maskCenter, workSize } from './clipCutout';

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

describe('applyObject', () => {
  it('adds an object with Keep', () => {
    const mask = Uint8Array.from([0, 255, 100]);
    applyObject(mask, Uint8Array.from([255, 0, 200]), 'keep');
    expect([...mask]).toEqual([255, 255, 200]);
  });

  it('cuts an object out with Remove', () => {
    const mask = Uint8Array.from([255, 255, 100]);
    applyObject(mask, Uint8Array.from([255, 0, 200]), 'remove');
    expect([...mask]).toEqual([0, 255, 55]);
  });
});

describe('maskCenter', () => {
  it('finds the middle of the kept pixels', () => {
    const mask = new Uint8Array(8 * 4);
    for (const i of [2 * 8 + 4, 2 * 8 + 6]) mask[i] = 255;
    expect(maskCenter(mask, 8, 4)).toEqual({ x: 5.5, y: 2.5 });
  });

  it('returns null for an empty mask', () => {
    expect(maskCenter(new Uint8Array(16), 4, 4)).toBeNull();
  });
});
