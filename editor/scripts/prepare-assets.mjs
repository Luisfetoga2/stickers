// Copies the MediaPipe engine into public/, so the app works offline. Runs before dev and build.
// Only the SIMD build is copied: every WebView that runs this app supports SIMD.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const to = join(root, 'public', 'mediapipe');
mkdirSync(to, { recursive: true });
for (const file of ['vision_wasm_internal.js', 'vision_wasm_internal.wasm']) {
  copyFileSync(join(from, file), join(to, file));
}
console.log('MediaPipe engine copied to public/mediapipe');
