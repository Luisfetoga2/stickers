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
  /** Mirrors the image left to right. */
  flip?: boolean;
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
  ctx.scale(t.flip ? -t.scale : t.scale, t.scale);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, -width / 2, -height / 2, width, height);
  ctx.restore();
}

/** A rectangle in source pixels. x and y are the top-left corner. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The inverse of draw(): maps a sticker point to a source pixel. */
export function toSource(t: Transform, p: Point, width: number, height: number): Point {
  const dx = p.x - t.x;
  const dy = p.y - t.y;
  const cos = Math.cos(-t.rotation);
  const sin = Math.sin(-t.rotation);
  const x = (dx * cos - dy * sin) / t.scale;
  return {
    x: (t.flip ? -x : x) + width / 2,
    y: (dx * sin + dy * cos) / t.scale + height / 2,
  };
}

/** How far the image moves on the sticker when its content moves by (dx, dy) source pixels. */
export function sourceDeltaToSticker(t: Transform, dx: number, dy: number): Point {
  const x = (t.flip ? -dx : dx) * t.scale;
  const y = dy * t.scale;
  const cos = Math.cos(t.rotation);
  const sin = Math.sin(t.rotation);
  return { x: x * cos - y * sin, y: x * sin + y * cos };
}

/** Centers a part of the image, for example the subject after background removal. */
export function fitBox(width: number, height: number, box: Box, mode: 'fit' | 'fill' = 'fit'): Transform {
  const scale =
    mode === 'fit'
      ? Math.min(SIZE / box.width, SIZE / box.height) * 0.94
      : Math.max(SIZE / box.width, SIZE / box.height);
  const offsetX = box.x + box.width / 2 - width / 2;
  const offsetY = box.y + box.height / 2 - height / 2;
  return { x: SIZE / 2 - offsetX * scale, y: SIZE / 2 - offsetY * scale, scale: clampScale(scale), rotation: 0 };
}
