/**
 * Magic Touch in a desktop browser, for testing only. On the phone, the app runs Magic Touch natively on the GPU.
 * Run `npm run dev-model` once to get the model into dev-models/.
 */
import type { BrushMode, InteractiveSegmenter } from '@mediapipe/tasks-vision';
import { strokePoints } from './tapTrack';
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

const DEV_MODEL = '/dev-models/interactive_segmentation.task';

/** Loads the engine and the model once. The GPU runs it when it can, and the CPU otherwise. */
export function getSegmenter(modelUrl = DEV_MODEL): Promise<InteractiveSegmenter> {
  instance ??= (async () => {
    const { InteractiveSegmenter } = await import('@mediapipe/tasks-vision');
    // The dev server serves the engine straight from node_modules. It never goes into the app.
    const base = new URL('/node_modules/@mediapipe/tasks-vision/wasm/', document.baseURI).href;
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
