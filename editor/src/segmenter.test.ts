import { describe, expect, it } from 'vitest';
import { strokePoints } from './segmenter';

describe('strokePoints', () => {
  it('turns a tap into a short stroke around it', () => {
    const points = strokePoints([{ x: 0.5, y: 0.5 }]);
    expect(points).toHaveLength(3);
    expect(points[1]).toEqual({ x: 0.5, y: 0.5 });
  });

  it('keeps every point inside the image', () => {
    for (const p of strokePoints([{ x: 0, y: 1 }])) {
      expect(p.x).toBeGreaterThan(0);
      expect(p.y).toBeLessThan(1);
    }
  });

  it('passes a scribble through, clamped', () => {
    expect(strokePoints([{ x: -1, y: 0.2 }, { x: 0.3, y: 0.3 }, { x: 0.4, y: 2 }])).toEqual([
      { x: 0.001, y: 0.2 },
      { x: 0.3, y: 0.3 },
      { x: 0.4, y: 0.999 },
    ]);
  });
});
