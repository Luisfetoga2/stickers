/** WhatsApp stickers are always 512x512. */
export const SIZE = 512;

/** Where the source image sits in the sticker. x and y are the image center, in sticker pixels. */
export interface Transform {
  x: number;
  y: number;
  /** Sticker pixels per source pixel. */
  scale: number;
  /** Radians, clockwise. */
  rotation: number;
}

export interface Point {
  x: number;
  y: number;
}

const MIN_SCALE = 0.005;
const MAX_SCALE = 40;

export function fitScale(width: number, height: number): number {
  return Math.min(SIZE / width, SIZE / height);
}

export function fillScale(width: number, height: number): number {
  return Math.max(SIZE / width, SIZE / height);
}

export function centered(width: number, height: number, mode: 'fit' | 'fill' = 'fit'): Transform {
  const scale = mode === 'fit' ? fitScale(width, height) : fillScale(width, height);
  return { x: SIZE / 2, y: SIZE / 2, scale, rotation: 0 };
}

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** Keeps an angle in (-PI, PI]. */
export function normalizeAngle(angle: number): number {
  let a = angle % (2 * Math.PI);
  if (a <= -Math.PI) a += 2 * Math.PI;
  if (a > Math.PI) a -= 2 * Math.PI;
  return a;
}

export function drag(start: Transform, from: Point, to: Point): Transform {
  return { ...start, x: start.x + to.x - from.x, y: start.y + to.y - from.y };
}

/**
 * Two-finger gesture. The image follows both fingers: the midpoint moves it,
 * the finger distance scales it, and the finger angle rotates it.
 */
export function pinch(start: Transform, a0: Point, b0: Point, a1: Point, b1: Point): Transform {
  const d0 = Math.hypot(b0.x - a0.x, b0.y - a0.y);
  const d1 = Math.hypot(b1.x - a1.x, b1.y - a1.y);
  if (d0 < 1) return start;

  const scale = clampScale(start.scale * (d1 / d0));
  const s = scale / start.scale;
  const turn = Math.atan2(b1.y - a1.y, b1.x - a1.x) - Math.atan2(b0.y - a0.y, b0.x - a0.x);
  const m0 = { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 };
  const m1 = { x: (a1.x + b1.x) / 2, y: (a1.y + b1.y) / 2 };

  const vx = start.x - m0.x;
  const vy = start.y - m0.y;
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  return {
    x: m1.x + s * (vx * cos - vy * sin),
    y: m1.y + s * (vx * sin + vy * cos),
    scale,
    rotation: normalizeAngle(start.rotation + turn),
  };
}

/** Scales by a factor while the point under the cursor stays still. */
export function zoomAround(start: Transform, factor: number, at: Point): Transform {
  const scale = clampScale(start.scale * factor);
  const s = scale / start.scale;
  return { ...start, scale, x: at.x + (start.x - at.x) * s, y: at.y + (start.y - at.y) * s };
}

export function draw(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  width: number,
  height: number,
  t: Transform,
): void {
  ctx.save();
  ctx.translate(t.x, t.y);
  ctx.rotate(t.rotation);
  ctx.scale(t.scale, t.scale);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, -width / 2, -height / 2, width, height);
  ctx.restore();
}
