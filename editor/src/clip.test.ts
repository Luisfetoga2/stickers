import { describe, expect, it } from 'vitest';
import { nextDue } from './clip';

describe('nextDue', () => {
  // Sticker frames at 10 fps, from a 30 fps video.
  const times = [0, 0.1, 0.2, 0.3];
  const step = 1 / 30;

  it('takes a time when the shown frame is its nearest frame', () => {
    expect(nextDue(times, 1, 0.1, step)).toBe(2);
  });

  it('waits when the next time is still ahead', () => {
    expect(nextDue(times, 1, 0.0667, step)).toBe(1);
  });

  it('takes a time when the shown frame is within half a frame before it', () => {
    expect(nextDue(times, 1, 0.09, step)).toBe(2);
  });

  it('takes several times when frames were skipped', () => {
    expect(nextDue(times, 1, 0.31, step)).toBe(4);
  });
});
