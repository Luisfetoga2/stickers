import { SIZE, draw, type Transform } from './transform';

/** WhatsApp's size limit for one static sticker. */
export const STATIC_LIMIT = 100 * 1024;

/** Tried from best to worst until the file fits. */
export const QUALITIES = [0.95, 0.9, 0.85, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2];

export class TooBigError extends Error {
  constructor(readonly size: number, readonly limit: number) {
    super(`The sticker is ${kb(size)} even at the lowest quality. The limit is ${kb(limit)}.`);
  }
}

export interface Encoded {
  blob: Blob;
  quality: number;
}

export async function fitToLimit(
  encode: (quality: number) => Promise<Blob>,
  limit: number,
): Promise<Encoded> {
  let smallest = Infinity;
  for (const quality of QUALITIES) {
    const blob = await encode(quality);
    if (blob.size <= limit) return { blob, quality };
    smallest = Math.min(smallest, blob.size);
  }
  throw new TooBigError(smallest, limit);
}

export function webpEncoder(canvas: HTMLCanvasElement): (quality: number) => Promise<Blob> {
  return (quality) =>
    new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (!blob) reject(new Error('The browser could not encode the sticker.'));
          // Browsers that cannot make WebP fall back to PNG without an error.
          else if (blob.type !== 'image/webp') reject(new Error('This browser cannot make WebP files.'));
          else resolve(blob);
        },
        'image/webp',
        quality,
      );
    });
}

export function renderSticker(image: CanvasImageSource, width: number, height: number, t: Transform): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available.');
  draw(ctx, image, width, height, t);
  return canvas;
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
}
