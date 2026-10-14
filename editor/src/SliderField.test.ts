import { describe, expect, it } from 'vitest';
import { clamp, parseNumber } from './SliderField';

describe('parseNumber', () => {
  it('reads a dot or a comma as the decimal mark', () => {
    expect(parseNumber('1.25')).toBe(1.25);
    expect(parseNumber(' 0,3 ')).toBe(0.3);
  });

  it('returns NaN for text that is not a number', () => {
    expect(parseNumber('abc')).toBeNaN();
    expect(parseNumber('')).toBeNaN();
  });
});

describe('clamp', () => {
  it('keeps values inside the range', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-1, 0, 1)).toBe(0);
    expect(clamp(0.4, 0, 1)).toBe(0.4);
  });
});
