import { describe, expect, it } from 'vitest';
import { progressOf } from './progress';

describe('progressOf', () => {
  it('reads a frame count', () => {
    expect(progressOf('Remove: frame 6 of 24, 1.02 s per frame, about 18 s left.')).toBe(0.25);
    expect(progressOf('Reading frames: 24 of 24…')).toBe(1);
  });

  it('reads a percentage', () => {
    expect(progressOf('Downloading the Magic Touch model (38 MB, once), part 1 of 2: 40%')).toBe(0.4);
    expect(progressOf('Downloading: 40%')).toBe(0.4);
  });

  it('returns null without a count', () => {
    expect(progressOf('Starting Magic Touch…')).toBeNull();
    expect(progressOf('0 of 0')).toBeNull();
  });
});
