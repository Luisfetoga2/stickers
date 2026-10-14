import { describe, expect, it } from 'vitest';
import { QUALITIES, TooBigError, blobToBase64, fitToLimit, kb } from './encode';

/** A fake encoder whose output size grows with quality. */
const fakeEncoder = (bytesPerQuality: number) => async (quality: number) =>
  new Blob([new Uint8Array(Math.round(quality * bytesPerQuality))], { type: 'image/webp' });

describe('fitToLimit', () => {
  it('keeps the best quality when it already fits', async () => {
    const { quality } = await fitToLimit(fakeEncoder(1000), 2000);
    expect(quality).toBe(QUALITIES[0]);
  });

  it('lowers the quality until the file fits', async () => {
    const { blob, quality } = await fitToLimit(fakeEncoder(1000), 650);
    expect(quality).toBe(0.6);
    expect(blob.size).toBeLessThanOrEqual(650);
  });

  it('fails with the smallest size when nothing fits', async () => {
    const err = await fitToLimit(fakeEncoder(1000), 100).catch((e) => e);
    expect(err).toBeInstanceOf(TooBigError);
    expect(err.size).toBe(200);
  });
});

describe('blobToBase64', () => {
  it('encodes bytes', async () => {
    expect(await blobToBase64(new Blob([new Uint8Array([104, 105])]))).toBe('aGk=');
  });
});

describe('kb', () => {
  it('shows one decimal for small files', () => {
    expect(kb(5 * 1024 + 512)).toBe('5.5 KB');
    expect(kb(80 * 1024)).toBe('80 KB');
  });
});
