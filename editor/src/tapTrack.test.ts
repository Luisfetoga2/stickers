import { describe, expect, it } from 'vitest';
import { innerPoint, maskArea, sameObject, trackObject, type SegmentFrame } from './tapTrack';

const W = 64;
const H = 48;

/** A mask with one filled rectangle. */
function rect(x: number, y: number, w: number, h: number): Uint8Array {
  const m = new Uint8Array(W * H);
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) m[yy * W + xx] = 255;
  return m;
}

describe('innerPoint', () => {
  it('finds the middle of a rectangle', () => {
    const p = innerPoint(rect(16, 8, 32, 32), W, H)!;
    expect(Math.abs(p.x - 32)).toBeLessThanOrEqual(8);
    expect(Math.abs(p.y - 24)).toBeLessThanOrEqual(8);
  });

  it('stays inside an L shape', () => {
    const m = rect(0, 0, 16, 48);
    m.set(rect(0, 32, 64, 16).map((v, i) => Math.max(v, m[i])));
    const p = innerPoint(m, W, H)!;
    expect(m[Math.floor(p.y) * W + Math.floor(p.x)]).toBe(255);
  });

  it('returns a pixel of a thin object', () => {
    const p = innerPoint(rect(10, 10, 1, 20), W, H)!;
    expect(Math.floor(p.x)).toBe(10);
  });

  it('returns null for an empty mask', () => {
    expect(innerPoint(new Uint8Array(W * H), W, H)).toBeNull();
  });
});

describe('sameObject', () => {
  it('accepts the object when it moved a little', () => {
    expect(sameObject(400, rect(12, 12, 20, 20), W, { x: 20, y: 20 })).toBe(true);
  });

  it('rejects a mask that misses the marked point', () => {
    expect(sameObject(400, rect(40, 20, 20, 20), W, { x: 20, y: 20 })).toBe(false);
  });

  it('rejects a mask whose size jumped', () => {
    expect(sameObject(400, rect(0, 0, 64, 48), W, { x: 20, y: 20 })).toBe(false);
  });
});

describe('trackObject', () => {
  // A 16x16 square that moves 4 px right per frame, from x = 4.
  const squareAt = (i: number) => rect(4 + i * 4, 16, 16, 16);
  /** A fake model: returns the square when the point is on it, and nothing otherwise. */
  const fake: SegmentFrame = async (i, points) => {
    const square = squareAt(i);
    const hit = points.some((p) => square[Math.floor(p.y) * W + Math.floor(p.x)] > 0);
    return hit ? square : new Uint8Array(W * H);
  };

  it('follows a moving object forward and backward from the tapped frame', async () => {
    const steps: number[] = [];
    const result = await trackObject(8, 3, [{ x: 4 + 12 + 8, y: 24 }], W, H, fake, (d) => steps.push(d));
    expect(result.found).toBe(8);
    expect(maskArea(result.masks[0]!)).toBe(256);
    expect(steps.at(-1)).toBe(8);
  });

  it('stops following when the object is lost', async () => {
    const vanishes: SegmentFrame = async (i, points) => (i >= 5 ? new Uint8Array(W * H) : fake(i, points));
    const result = await trackObject(8, 2, [{ x: 4 + 8 + 8, y: 24 }], W, H, vanishes, () => {});
    expect(result.masks.map((m) => m !== null)).toEqual([true, true, true, true, true, false, false, false]);
  });

  it('fails when the tap finds nothing', async () => {
    await expect(trackObject(4, 0, [{ x: 60, y: 2 }], W, H, fake, () => {})).rejects.toThrow('Nothing was found there');
  });
});
