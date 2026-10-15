import { describe, expect, it } from 'vitest';
import { followPrompt, innerPoint, marksPrompt, maskArea, maskBox, sameObject, trackObject, type SegmentFrame } from './tapTrack';

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
  const fake: SegmentFrame = async (i, prompt) => {
    const square = squareAt(i);
    const hit = prompt.points.some((p, k) => prompt.labels[k] === 1 && square[Math.floor(p.y) * W + Math.floor(p.x)] > 0);
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
    const vanishes: SegmentFrame = async (i, prompt) => (i >= 5 ? new Uint8Array(W * H) : fake(i, prompt));
    const result = await trackObject(8, 2, [{ x: 4 + 8 + 8, y: 24 }], W, H, vanishes, () => {});
    expect(result.masks.map((m) => m !== null)).toEqual([true, true, true, true, true, false, false, false]);
  });

  it('fails when the tap finds nothing', async () => {
    await expect(trackObject(4, 0, [{ x: 60, y: 2 }], W, H, fake, () => {})).rejects.toThrow('Nothing was found there');
  });
});

describe('marksPrompt', () => {
  it('turns a tap into one point that takes the largest guess', () => {
    const prompt = marksPrompt([{ x: 10, y: 10 }, { x: 11, y: 10 }, { x: 10, y: 11 }], W, H);
    expect(prompt.points).toHaveLength(1);
    expect(prompt.pick).toBe('largest');
  });

  it('keeps a stroke as at most 12 points that take the first guess', () => {
    const stroke = Array.from({ length: 40 }, (_, i) => ({ x: i, y: 20 }));
    const prompt = marksPrompt(stroke, W, H);
    expect(prompt.points).toHaveLength(12);
    expect(prompt.points[0]).toEqual({ x: 0, y: 20 });
    expect(prompt.points[11]).toEqual({ x: 39, y: 20 });
    expect(prompt.labels.every((l) => l === 1)).toBe(true);
    expect(prompt.pick).toBe('first');
  });
});

describe('followPrompt', () => {
  it('gives a point inside the object and a slightly larger box', () => {
    const prompt = followPrompt(rect(10, 10, 20, 20), W, H)!;
    expect(prompt.labels).toEqual([1, 2, 3]);
    expect(prompt.points[1]).toEqual({ x: 9, y: 9 });
    expect(prompt.points[2]).toEqual({ x: 31, y: 31 });
    const [p] = prompt.points;
    expect(p.x > 10 && p.x < 30 && p.y > 10 && p.y < 30).toBe(true);
  });

  it('keeps the box inside the frame', () => {
    const prompt = followPrompt(rect(0, 0, 64, 48), W, H)!;
    expect(prompt.points[1]).toEqual({ x: 0, y: 0 });
    expect(prompt.points[2]).toEqual({ x: 64, y: 48 });
  });

  it('returns null for an empty mask', () => {
    expect(maskBox(new Uint8Array(W * H), W, H)).toBeNull();
    expect(followPrompt(new Uint8Array(W * H), W, H)).toBeNull();
  });
});
