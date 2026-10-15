import { useEffect, useRef, useState } from 'react';
import { SIZE, drag, draw, pinch, zoomAround, type Point, type Transform } from './transform';

export type Tool = 'move' | 'erase' | 'restore' | 'pick' | 'keep' | 'remove';

interface Props {
  image: CanvasImageSource;
  width: number;
  height: number;
  /** Changes when the image pixels change, so the stage redraws. */
  version: number;
  transform: Transform;
  onChange(t: Transform): void;
  tool: Tool;
  /** Brush radius in sticker pixels. */
  brushSize: number;
  onBrushStart(p: Point): void;
  onBrushMove(from: Point, to: Point): void;
  /** The finger lifted. completed is false when a second finger turned the stroke into a move. */
  onBrushEnd?(completed: boolean): void;
  /** A highlighted line over the image, in sticker pixels, such as the Keep or Remove mark. */
  mark?: { points: Point[]; color: string } | null;
  /** A tinted picture over the image, scaled like the image, such as the part a Keep or Remove mark found. */
  highlight?: CanvasImageSource | null;
}

/** Width of the Keep and Remove mark, in sticker pixels. */
const MARK_WIDTH = 16;

type Gesture =
  | { kind: 'brush'; last: Point }
  | { kind: 'move'; start: Transform; points: Point[] };

/**
 * The 512x512 sticker preview.
 * Move tool: one finger moves the image. Brush tools: one finger paints.
 * Two fingers always move, zoom, and rotate.
 */
export function Stage(props: Props) {
  const { image, width, height, version, transform, onChange, tool, brushSize, mark, highlight } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | null>(null);
  const [cursor, setCursor] = useState<Point | null>(null);

  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, SIZE, SIZE);
    draw(ctx, image, width, height, transform);
    if (highlight) draw(ctx, highlight, width, height, transform);
    if (mark && mark.points.length > 0) {
      // A white outline first, so a red mark shows on red and a green mark on green.
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const trace = () => {
        ctx.beginPath();
        ctx.moveTo(mark.points[0].x, mark.points[0].y);
        for (const p of mark.points.slice(1)) ctx.lineTo(p.x, p.y);
        // A tap has one point, so a zero-length line with round caps draws a dot.
        if (mark.points.length === 1) ctx.lineTo(mark.points[0].x + 0.01, mark.points[0].y);
        ctx.stroke();
      };
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
      ctx.lineWidth = MARK_WIDTH + 6;
      trace();
      ctx.strokeStyle = mark.color;
      ctx.lineWidth = MARK_WIDTH;
      trace();
      ctx.restore();
    }
    if (cursor && tool !== 'move') {
      ctx.save();
      ctx.beginPath();
      ctx.arc(cursor.x, cursor.y, brushSize, 0, Math.PI * 2);
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
      ctx.stroke();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
      ctx.stroke();
      ctx.restore();
    }
  }, [image, width, height, version, transform, cursor, tool, brushSize, mark, highlight]);

  // React wheel listeners are passive, so the page would scroll too. Desktop testing only.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = latest.current;
      p.onChange(zoomAround(p.transform, Math.exp(-e.deltaY * 0.0015), toSticker(canvas, e)));
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  const firstTwo = () => [...pointers.current.values()].slice(0, 2);

  const startMove = () => {
    const points = firstTwo();
    gesture.current = points.length ? { kind: 'move', start: latest.current.transform, points } : null;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = toSticker(e.currentTarget, e);
    pointers.current.set(e.pointerId, p);
    if (pointers.current.size === 1 && tool !== 'move') {
      gesture.current = { kind: 'brush', last: p };
      setCursor(p);
      props.onBrushStart(p);
    } else {
      // A second finger ends painting and starts a two-finger move.
      if (gesture.current?.kind === 'brush') props.onBrushEnd?.(false);
      setCursor(null);
      startMove();
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    const p = toSticker(e.currentTarget, e);
    pointers.current.set(e.pointerId, p);
    const g = gesture.current;
    if (!g) return;
    if (g.kind === 'brush') {
      props.onBrushMove(g.last, p);
      g.last = p;
      setCursor(p);
      return;
    }
    const now = firstTwo();
    if (g.points.length !== now.length) return;
    if (now.length === 1) onChange(drag(g.start, g.points[0], now[0]));
    else onChange(pinch(g.start, g.points[0], g.points[1], now[0], now[1]));
  };

  const onPointerEnd = (e: React.PointerEvent<HTMLCanvasElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size === 0) {
      if (gesture.current?.kind === 'brush') props.onBrushEnd?.(true);
      gesture.current = null;
      setCursor(null);
    } else {
      // After two fingers, the last finger moves the image instead of painting by accident.
      startMove();
    }
  };

  return (
    <div className="stage">
      <canvas
        ref={canvasRef}
        width={SIZE}
        height={SIZE}
        className={tool === 'move' ? 'tool-move' : 'tool-brush'}
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
