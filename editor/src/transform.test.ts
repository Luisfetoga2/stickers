import { describe, expect, it } from 'vitest';
import { SIZE, centered, drag, fillScale, fitScale, normalizeAngle, pinch, zoomAround } from './transform';

const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);

describe('fit and fill', () => {
  it('fits a wide image by its width', () => {
    expect(fitScale(1024, 512)).toBe(0.5);
  });

  it('fills a wide image by its height', () => {
    expect(fillScale(1024, 512)).toBe(1);
  });

  it('centers the image', () => {
    expect(centered(100, 200)).toEqual({ x: SIZE / 2, y: SIZE / 2, scale: 2.56, rotation: 0 });
  });
});

describe('drag', () => {
  it('moves the image by the finger movement', () => {
    const t = drag({ x: 100, y: 100, scale: 1, rotation: 0 }, { x: 10, y: 10 }, { x: 40, y: -20 });
    expect(t).toMatchObject({ x: 130, y: 70 });
  });
});

describe('pinch', () => {
  const start = { x: 256, y: 256, scale: 1, rotation: 0 };

  it('doubles the scale when the fingers move twice as far apart', () => {
    const t = pinch(start, { x: 206, y: 256 }, { x: 306, y: 256 }, { x: 156, y: 256 }, { x: 356, y: 256 });
    close(t.scale, 2);
    close(t.x, 256);
    close(t.y, 256);
  });

  it('rotates around the finger midpoint', () => {
    // Fingers turn 90 degrees clockwise around (0, 0). The image center at (100, 0) moves to (0, 100).
    const t = pinch(
      { x: 100, y: 0, scale: 1, rotation: 0 },
      { x: -10, y: 0 },
      { x: 10, y: 0 },
      { x: 0, y: -10 },
      { x: 0, y: 10 },
    );
    close(t.rotation, Math.PI / 2);
    close(t.x, 0);
    close(t.y, 100);
  });

  it('follows the midpoint when both fingers move together', () => {
    const t = pinch(start, { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 20 }, { x: 150, y: 20 });
    close(t.x, 306);
    close(t.y, 276);
    close(t.scale, 1);
  });

  it('ignores fingers that start on the same spot', () => {
    expect(pinch(start, { x: 5, y: 5 }, { x: 5, y: 5 }, { x: 0, y: 0 }, { x: 50, y: 0 })).toBe(start);
  });
});

describe('zoomAround', () => {
  it('keeps the point under the cursor still', () => {
    const t = zoomAround({ x: 256, y: 256, scale: 1, rotation: 0 }, 2, { x: 0, y: 0 });
    expect(t).toMatchObject({ x: 512, y: 512, scale: 2 });
  });
});

describe('normalizeAngle', () => {
  it('wraps angles into one turn', () => {
    close(normalizeAngle(3 * Math.PI), Math.PI);
    close(normalizeAngle(-3 * Math.PI / 2), Math.PI / 2);
  });
});
