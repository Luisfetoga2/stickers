/**
 * Magic Touch (MediaPipe interactive segmentation): tap an object, get that object's mask.
 * The engine ships with the app in mediapipe/. The model is about 30 MB, so the app downloads it once.
 */
import type { BrushMode, InteractiveSegmenter } from '@mediapipe/tasks-vision';
import type { Point } from './transform';

export interface ObjectMask {
  /** 0 to 255 per pixel, 255 inside the object. */
  data: Uint8Array;
  width: number;
  height: number;
}

/**
 * BrushMode.POSITIVE: the stroke marks what to select. The library declares BrushMode only as a type,
 * so the value is written out here.
 */
const POSITIVE = 1 as BrushMode;

let instance: Promise<InteractiveSegmenter> | null = null;

/** Loads the engine and the model once. The GPU runs it when it can, and the CPU otherwise. */
export function getSegmenter(modelUrl: string): Promise<InteractiveSegmenter> {
  instance ??= (async () => {
    const { InteractiveSegmenter } = await import('@mediapipe/tasks-vision');
    const base = new URL('mediapipe/', document.baseURI).href;
    const fileset = {
      wasmLoaderPath: `${base}vision_wasm_internal.js`,
      wasmBinaryPath: `${base}vision_wasm_internal.wasm`,
    };
    const res = await fetch(modelUrl);
    if (!res.ok) throw new Error(`Could not read the Magic Touch model (${res.status}).`);
    const model = new Uint8Array(await res.arrayBuffer());
    try {
      return await InteractiveSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetBuffer: model, delegate: 'GPU' },
      });
    } catch {
      return await InteractiveSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetBuffer: model, delegate: 'CPU' },
      });
    }
  })().catch((err) => {
    instance = null;
    throw err;
  });
  return instance;
}

/** Strokes need a few points. A single point is too little for the model, so a tap becomes a short stroke. */
const TAP_SPREAD = 0.01;

/** Points inside the image, in 0 to 1. Points outside it crash the engine. */
function clampPoint(p: Point): Point {
  return { x: Math.min(0.999, Math.max(0.001, p.x)), y: Math.min(0.999, Math.max(0.001, p.y)) };
}

/** Turns one or more normalized points into the stroke the model expects. */
export function strokePoints(points: Point[]): Point[] {
  if (points.length >= 3) return points.map(clampPoint);
  const p = points[0];
  return [
    { x: p.x - TAP_SPREAD, y: p.y - TAP_SPREAD },
    { x: p.x, y: p.y },
    { x: p.x + TAP_SPREAD, y: p.y + TAP_SPREAD },
  ].map(clampPoint);
}

/** The mask of the object under the points (normalized, 0 to 1), the same size as the image. */
export function objectAt(segmenter: InteractiveSegmenter, image: TexImageSource, points: Point[]): ObjectMask {
  segmenter.setImage(image);
  const mask = segmenter.segment([{ brushMode: POSITIVE, point: strokePoints(points), isCompleted: true }]);
  try {
    const { width, height } = mask;
    let data: Uint8Array;
    if (mask.hasFloat32Array()) {
      const conf = mask.getAsFloat32Array();
      data = new Uint8Array(conf.length);
      for (let i = 0; i < conf.length; i++) data[i] = conf[i] >= 0.5 ? 255 : 0;
    } else {
      const raw = mask.getAsUint8Array();
      data = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) data[i] = raw[i] > 0 ? 255 : 0;
    }
    return { data, width, height };
  } finally {
    mask.close();
  }
}
