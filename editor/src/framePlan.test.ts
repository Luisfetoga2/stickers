import { describe, expect, it } from 'vitest';
import { FramePlanner, changedBox, snapBox } from './framePlan';

const SIZE = 16;

/** A SIZE x SIZE image filled with one RGBA color. */
function image(rgba: [number, number, number, number]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  return data;
}

function paint(data: Uint8ClampedArray, x: number, y: number, rgba: [number, number, number, number]) {
  data.set(rgba, (y * SIZE + x) * 4);
}

describe('changedBox', () => {
  it('finds the box around changed pixels', () => {
    const a = image([0, 0, 0, 255]);
    const b = image([0, 0, 0, 255]);
    paint(b, 3, 4, [200, 0, 0, 255]);
    paint(b, 6, 9, [200, 0, 0, 255]);
    expect(changedBox(a, b, SIZE, SIZE)).toEqual({ x: 3, y: 4, width: 4, height: 6 });
  });

  it('ignores small changes below the threshold', () => {
    const a = image([100, 100, 100, 255]);
    const b = image([105, 95, 108, 255]);
    expect(changedBox(a, b, SIZE, SIZE)).toBeNull();
  });

  it('ignores color changes in see-through pixels', () => {
    const a = image([0, 0, 0, 0]);
    const b = image([255, 0, 0, 0]);
    expect(changedBox(a, b, SIZE, SIZE)).toBeNull();
  });

  it('counts a pixel that appears', () => {
    const a = image([0, 0, 0, 0]);
    const b = image([0, 0, 0, 0]);
    paint(b, 1, 1, [0, 0, 0, 255]);
    expect(changedBox(a, b, SIZE, SIZE)).toEqual({ x: 1, y: 1, width: 1, height: 1 });
  });
});

describe('snapBox', () => {
  it('adds a margin, makes x and y even, and stays on the canvas', () => {
    expect(snapBox({ x: 5, y: 3, width: 4, height: 4 }, SIZE)).toEqual({ x: 2, y: 0, width: 9, height: 9 });
    expect(snapBox({ x: 14, y: 14, width: 2, height: 2 }, SIZE)).toEqual({ x: 12, y: 12, width: 4, height: 4 });
  });
});

describe('FramePlanner', () => {
  it('stores the first frame whole', () => {
    expect(new FramePlanner(SIZE).next(image([0, 0, 0, 255]))).toEqual({ x: 0, y: 0, width: SIZE, height: SIZE });
  });

  it('returns null for a frame that did not change', () => {
    const planner = new FramePlanner(SIZE);
    planner.next(image([0, 0, 0, 255]));
    expect(planner.next(image([0, 0, 0, 255]))).toBeNull();
  });

  it('stores only the changed area', () => {
    const planner = new FramePlanner(SIZE);
    planner.next(image([0, 0, 0, 255]));
    const next = image([0, 0, 0, 255]);
    paint(next, 8, 8, [255, 255, 255, 255]);
    expect(planner.next(next)).toEqual({ x: 6, y: 6, width: 5, height: 5 });
  });

  it('stores the whole frame when most of it changed', () => {
    const planner = new FramePlanner(SIZE);
    planner.next(image([0, 0, 0, 255]));
    expect(planner.next(image([255, 255, 255, 255]))).toEqual({ x: 0, y: 0, width: SIZE, height: SIZE });
  });

  it('catches slow changes once they add up', () => {
    const planner = new FramePlanner(SIZE);
    planner.next(image([100, 100, 100, 255]));
    // Each step is below the threshold, but the third is 12 away from what the viewer sees.
    expect(planner.next(image([104, 104, 104, 255]))).toBeNull();
    expect(planner.next(image([108, 108, 108, 255]))).toBeNull();
    expect(planner.next(image([112, 112, 112, 255]))).not.toBeNull();
  });
});
