import { useEffect, useRef } from 'react';
import { SIZE, drag, draw, pinch, zoomAround, type Point, type Transform } from './transform';

interface Props {
  image: CanvasImageSource;
  width: number;
  height: number;
  transform: Transform;
  onChange(t: Transform): void;
}

/** The 512x512 sticker preview. One finger moves the image. Two fingers zoom and rotate it. */
export function Stage({ image, width, height, transform, onChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<{ start: Transform; points: Point[] } | null>(null);
  const latest = useRef(transform);
  latest.current = transform;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, SIZE, SIZE);
    draw(ctx, image, width, height, transform);
  }, [image, width, height, transform]);

  // React wheel listeners are passive, so the page would scroll too. Desktop testing only.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      onChangeRef.current(zoomAround(latest.current, Math.exp(-e.deltaY * 0.0015), toSticker(canvas, e)));
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  const firstTwo = () => [...pointers.current.values()].slice(0, 2);

  const restart = () => {
    const points = firstTwo();
    gesture.current = points.length ? { start: latest.current, points } : null;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, toSticker(e.currentTarget, e));
    restart();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, toSticker(e.currentTarget, e));
    const g = gesture.current;
    const now = firstTwo();
    if (!g || g.points.length !== now.length) return;
    if (now.length === 1) onChange(drag(g.start, g.points[0], now[0]));
    else onChange(pinch(g.start, g.points[0], g.points[1], now[0], now[1]));
  };

  const onPointerEnd = (e: React.PointerEvent<HTMLCanvasElement>) => {
    pointers.current.delete(e.pointerId);
    restart();
  };

  return (
    <div className="stage">
      <canvas
        ref={canvasRef}
        width={SIZE}
        height={SIZE}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      />
    </div>
  );
}

function toSticker(canvas: HTMLCanvasElement, e: { clientX: number; clientY: number }): Point {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((e.clientX - rect.left) * SIZE) / rect.width,
    y: ((e.clientY - rect.top) * SIZE) / rect.height,
  };
}
