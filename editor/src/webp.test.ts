import { describe, expect, it } from 'vitest';
import { frameDurations, muxAnimatedWebp, webpChunks } from './webp';

function chunk(fourcc: string, payload: number[]): number[] {
  const size = payload.length;
  const out = [...fourcc].map((c) => c.charCodeAt(0));
  out.push(size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff, (size >> 24) & 0xff, ...payload);
  if (size & 1) out.push(0);
  return out;
}

/** A fake single-frame WebP: RIFF header plus the given chunks. */
function fakeWebp(...chunks: number[][]): Uint8Array {
  const body = chunks.flat();
  const size = 4 + body.length;
  return Uint8Array.from([
    ...'RIFF'.split('').map((c) => c.charCodeAt(0)),
    size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff, (size >> 24) & 0xff,
    ...'WEBP'.split('').map((c) => c.charCodeAt(0)),
    ...body,
  ]);
}

const u24 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);

describe('webpChunks', () => {
  it('reads chunks and skips the pad byte after odd sizes', () => {
    const chunks = webpChunks(fakeWebp(chunk('VP8X', [1, 2, 3]), chunk('VP8 ', [9, 9])));
    expect(chunks.map((c) => c.fourcc)).toEqual(['VP8X', 'VP8 ']);
    expect([...chunks[1].data]).toEqual([9, 9]);
  });

  it('rejects files that are not WebP', () => {
    expect(() => webpChunks(new Uint8Array(20))).toThrow('Not a WebP file.');
  });
});

describe('frameDurations', () => {
  it('keeps the total exact at 12 fps', () => {
    const d = frameDurations(12, 12);
    expect(d.reduce((a, b) => a + b, 0)).toBe(1000);
    expect(Math.min(...d)).toBeGreaterThanOrEqual(83);
  });
});

describe('muxAnimatedWebp', () => {
  const frameA = fakeWebp(chunk('VP8X', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), chunk('ALPH', [1, 2, 3]), chunk('VP8 ', [4, 5]));
  const frameB = fakeWebp(chunk('VP8 ', [6, 7, 8]), chunk('EXIF', [0]));
  const out = muxAnimatedWebp(
    [
      { webp: frameA, durationMs: 83 },
      { webp: frameB, durationMs: 4 },
    ],
    512,
    512,
  );
  const chunks = webpChunks(out);

  it('writes a RIFF size that matches the file', () => {
    expect(out[4] | (out[5] << 8) | (out[6] << 16) | (out[7] << 24)).toBe(out.length - 8);
  });

  it('starts with VP8X and ANIM, then one ANMF per frame', () => {
    expect(chunks.map((c) => c.fourcc)).toEqual(['VP8X', 'ANIM', 'ANMF', 'ANMF']);
  });

  it('marks the file as animated with alpha at 512x512', () => {
    const vp8x = chunks[0].data;
    expect(vp8x[0]).toBe(0x12);
    expect(u24(vp8x, 4) + 1).toBe(512);
    expect(u24(vp8x, 7) + 1).toBe(512);
  });

  it('loops forever', () => {
    expect([...chunks[1].data]).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('stores durations with an 8 ms minimum and the no-blend flag', () => {
    const [a, b] = [chunks[2].data, chunks[3].data];
    expect(u24(a, 12)).toBe(83);
    expect(u24(b, 12)).toBe(8);
    expect(a[15]).toBe(0x02);
  });

  it('keeps only image chunks inside each frame', () => {
    const inner = (anmf: Uint8Array) => {
      // Wrap the frame payload after its 16-byte header so webpChunks can read it.
      const sub = anmf.subarray(16);
      return webpChunks(fakeWebp(Array.from(sub))).map((c) => c.fourcc);
    };
    expect(inner(chunks[2].data)).toEqual(['ALPH', 'VP8 ']);
    expect(inner(chunks[3].data)).toEqual(['VP8 ']);
  });
});

describe('muxAnimatedWebp with frame areas', () => {
  const frame = fakeWebp(chunk('VP8 ', [1, 2]));

  it('stores the offset halved and the area size minus one', () => {
    const out = muxAnimatedWebp([{ webp: frame, durationMs: 50, x: 10, y: 20, width: 30, height: 40 }], 512, 512);
    const anmf = webpChunks(out)[2].data;
    expect([u24(anmf, 0), u24(anmf, 3), u24(anmf, 6) + 1, u24(anmf, 9) + 1]).toEqual([5, 10, 30, 40]);
  });

  it('rejects odd offsets', () => {
    expect(() => muxAnimatedWebp([{ webp: frame, durationMs: 50, x: 3, y: 0, width: 2, height: 2 }], 512, 512)).toThrow(
      'Frame offsets must be even.',
    );
  });
});
