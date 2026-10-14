import { describe, expect, it } from 'vitest';
import { DEFAULT_CHROMA, chromaKey, detectKeyColor, toHex, type RGB } from './chroma';

const GREEN: RGB = [0, 177, 64];

function pixels(...colors: RGB[]): Uint8ClampedArray {
  return Uint8ClampedArray.from(colors.flatMap((c) => [...c, 255]));
}

describe('chromaKey', () => {
  const settings = { ...DEFAULT_CHROMA, key: GREEN };

  it('removes the key color and keeps other colors', () => {
    const data = pixels(GREEN, [255, 255, 255], [200, 40, 40]);
    chromaKey(data, settings);
    expect([data[3], data[7], data[11]]).toEqual([0, 255, 255]);
  });

  it('also removes a darker shade of the screen', () => {
    const data = pixels([0, 90, 32]);
    chromaKey(data, settings);
    expect(data[3]).toBe(0);
  });

  it('fades pixels between tolerance and tolerance plus softness', () => {
    const data = pixels([70, 160, 90]);
    chromaKey(data, { ...settings, despill: false });
    expect(data[3]).toBeGreaterThan(0);
    expect(data[3]).toBeLessThan(255);
  });

  it('removes the green tint from edges', () => {
    const data = pixels([180, 220, 150]);
    chromaKey(data, settings);
    expect(data[1]).toBe(180);
  });

  it('does not despill when the key is gray', () => {
    const data = pixels([180, 220, 150]);
    chromaKey(data, { ...settings, key: [128, 128, 128] });
    expect(data[1]).toBe(220);
  });

  it('multiplies existing alpha', () => {
    const data = Uint8ClampedArray.from([255, 255, 255, 100]);
    chromaKey(data, settings);
    expect(data[3]).toBe(100);
  });
});

describe('detectKeyColor', () => {
  it('finds the screen color around a subject', () => {
    const width = 20;
    const height = 10;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const inside = x > 5 && x < 14 && y > 2 && y < 7;
        data.set(inside ? [220, 30, 30, 255] : [...GREEN, 255], (y * width + x) * 4);
      }
    }
    expect(detectKeyColor(data, width, height)).toEqual(GREEN);
  });

  it('ignores dark corners', () => {
    const width = 20;
    const height = 10;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const corner = (x < 6 || x > 13) && (y < 3 || y > 6);
        data.set(corner ? [0, 30, 10, 255] : [...GREEN, 255], (y * width + x) * 4);
      }
    }
    expect(detectKeyColor(data, width, height)).toEqual(GREEN);
  });
});

describe('toHex', () => {
  it('formats a color', () => {
    expect(toHex([0, 177, 64])).toBe('#00b140');
  });
});
