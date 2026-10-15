/**
 * Magic Touch in a desktop browser, for testing only. On the phone, the app runs the same EdgeSAM model natively.
 * Run `npm run dev-model` once to get the model into dev-models/.
 */
import type { InferenceSession } from 'onnxruntime-web';
import { LOW, SIDE, samInput, samMask, samPick, samScale } from './samMath';
import type { Prompt } from './tapTrack';

export interface ObjectMask {
  /** 0 or 255 per pixel, 255 inside the object. */
  data: Uint8Array;
  width: number;
  height: number;
}

interface Sam {
  ort: typeof import('onnxruntime-web');
  encoder: InferenceSession;
  decoder: InferenceSession;
}

let instance: Promise<Sam> | null = null;

/** Loads the engine and both model parts once. */
export function getSegmenter(): Promise<Sam> {
  instance ??= (async () => {
    const ort = await import('onnxruntime-web');
    // The dev server serves the engine straight from node_modules. It never goes into the app.
    ort.env.wasm.wasmPaths = new URL('/node_modules/onnxruntime-web/dist/', document.baseURI).href;
    const encoder = await ort.InferenceSession.create('/dev-models/edge_sam_3x_encoder.onnx');
    const decoder = await ort.InferenceSession.create('/dev-models/edge_sam_3x_decoder.onnx');
    return { ort, encoder, decoder };
  })().catch((err) => {
    instance = null;
    throw err;
  });
  return instance;
}

/** The mask of the object the prompt points at. Prompt points are normalized, 0 to 1. */
export async function objectAt(sam: Sam, image: ImageBitmap, prompt: Prompt): Promise<ObjectMask> {
  const { width, height } = image;
  const scale = samScale(width, height);
  const rw = Math.round(width * scale);
  const rh = Math.round(height * scale);
  const canvas = new OffscreenCanvas(rw, rh);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(image, 0, 0, rw, rh);
  const input = samInput(ctx.getImageData(0, 0, rw, rh).data, rw, rh);

  const { ort, encoder, decoder } = sam;
  const encoded = await encoder.run({ image: new ort.Tensor('float32', input, [1, 3, SIDE, SIDE]) });
  const coords = new Float32Array(prompt.points.flatMap((p) => [p.x * width * scale, p.y * height * scale]));
  const decoded = await decoder.run({
    image_embeddings: encoded.image_embeddings,
    point_coords: new ort.Tensor('float32', coords, [1, prompt.points.length, 2]),
    point_labels: new ort.Tensor('float32', Float32Array.from(prompt.labels), [1, prompt.labels.length]),
  });
  const scores = decoded.scores.data as Float32Array;
  const masks = decoded.masks.data as Float32Array;
  if (masks.length !== 4 * LOW * LOW) throw new Error(`Unexpected mask size ${masks.length}.`);
  const index = samPick(scores, masks, prompt.pick);
  return { data: samMask(masks, index, width, height), width, height };
}
