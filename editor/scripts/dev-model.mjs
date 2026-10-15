// Downloads the Magic Touch model for testing in a desktop browser. The app downloads it on the phone instead,
// so this folder stays out of the build.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const URL =
  'https://storage.googleapis.com/mediapipe-models/interactive_segmenter_v2/magic_touch/int8/1/interactive_segmentation.task';
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dev-models');
const file = join(dir, 'interactive_segmentation.task');
if (existsSync(file)) {
  console.log('The model is already in dev-models/');
} else {
  mkdirSync(dir, { recursive: true });
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  writeFileSync(file, new Uint8Array(await res.arrayBuffer()));
  console.log('The model is in dev-models/');
}
