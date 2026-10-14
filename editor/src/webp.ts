/**
 * Builds an animated WebP from single-frame WebP files, as the browser's canvas encoder makes them.
 * Container format: https://developers.google.com/speed/webp/docs/riff_container
 */

export interface Chunk {
  fourcc: string;
  data: Uint8Array;
}

export interface Frame {
  /** A complete single-image WebP file. */
  webp: Uint8Array;
  durationMs: number;
}

const ascii = (bytes: Uint8Array, at: number) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);

const u32 = (bytes: Uint8Array, at: number) =>
  (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;

/** Splits a WebP file into its chunks. */
export function webpChunks(file: Uint8Array): Chunk[] {
  if (file.length < 12 || ascii(file, 0) !== 'RIFF' || ascii(file, 8) !== 'WEBP') {
    throw new Error('Not a WebP file.');
  }
  const chunks: Chunk[] = [];
  let at = 12;
  while (at + 8 <= file.length) {
    const size = u32(file, at + 4);
    const end = at + 8 + size;
    if (end > file.length) throw new Error('The WebP file is cut short.');
    chunks.push({ fourcc: ascii(file, at), data: file.subarray(at + 8, end) });
    at = end + (size & 1);
  }
  return chunks;
}

/** Splits a total time into whole milliseconds per frame without losing the remainder. */
export function frameDurations(count: number, fps: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    out.push(Math.round(((i + 1) * 1000) / fps) - Math.round((i * 1000) / fps));
  }
  return out;
}

class Writer {
  private parts: Uint8Array[] = [];
  length = 0;

  bytes(b: Uint8Array): void {
    this.parts.push(b);
    this.length += b.length;
  }

  text(s: string): void {
    this.bytes(Uint8Array.from(s, (c) => c.charCodeAt(0)));
  }

  uint(value: number, size: number): void {
    const b = new Uint8Array(size);
    for (let i = 0; i < size; i++) b[i] = (value >>> (8 * i)) & 0xff;
    this.bytes(b);
  }

  chunk(fourcc: string, data: Uint8Array): void {
    this.text(fourcc);
    this.uint(data.length, 4);
    this.bytes(data);
    if (data.length & 1) this.uint(0, 1);
  }

  result(): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const p of this.parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
}

/** Joins full-canvas frames into one looping animated WebP. */
export function muxAnimatedWebp(frames: Frame[], width: number, height: number): Uint8Array<ArrayBuffer> {
  if (frames.length === 0) throw new Error('No frames to join.');

  const body = new Writer();

  // VP8X: flags (alpha 0x10, animation 0x02), 3 reserved bytes, canvas width - 1, canvas height - 1.
  const vp8x = new Writer();
  vp8x.uint(0x10 | 0x02, 1);
  vp8x.uint(0, 3);
  vp8x.uint(width - 1, 3);
  vp8x.uint(height - 1, 3);
  body.chunk('VP8X', vp8x.result());

  // ANIM: transparent background color (BGRA), loop forever.
  const anim = new Writer();
  anim.uint(0, 4);
  anim.uint(0, 2);
  body.chunk('ANIM', anim.result());

  for (const frame of frames) {
    const image = webpChunks(frame.webp).filter((c) => c.fourcc === 'ALPH' || c.fourcc === 'VP8 ' || c.fourcc === 'VP8L');
    if (!image.some((c) => c.fourcc !== 'ALPH')) throw new Error('A frame has no image data.');

    const anmf = new Writer();
    anmf.uint(0, 3); // x offset / 2
    anmf.uint(0, 3); // y offset / 2
    anmf.uint(width - 1, 3);
    anmf.uint(height - 1, 3);
    anmf.uint(Math.max(8, Math.round(frame.durationMs)), 3);
    // Do not blend with the previous frame (0x02), so transparent areas stay transparent. Do not dispose.
    anmf.uint(0x02, 1);
    for (const c of image) anmf.chunk(c.fourcc, c.data);
    body.chunk('ANMF', anmf.result());
  }

  const file = new Writer();
  file.text('RIFF');
  file.uint(4 + body.length, 4);
  file.text('WEBP');
  file.bytes(body.result());
  return file.result();
}
