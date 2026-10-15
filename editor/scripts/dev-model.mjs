// Downloads the Magic Touch model (EdgeSAM, S-Lab License 1.0) for testing in a desktop browser.
// The app downloads it on the phone instead, so this folder stays out of the build.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'https://huggingface.co/chongzhou/EdgeSAM/resolve/e0564124628944e1622973d4e0f68158b46f035a/';
const FILES = ['edge_sam_3x_encoder.onnx', 'edge_sam_3x_decoder.onnx'];
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dev-models');
mkdirSync(dir, { recursive: true });
for (const name of FILES) {
  const file = join(dir, name);
  if (existsSync(file)) {
    console.log(`${name} is already in dev-models/`);
    continue;
  }
  const res = await fetch(BASE + name);
  if (!res.ok) throw new Error(`Download of ${name} failed: ${res.status}`);
  writeFileSync(file, new Uint8Array(await res.arrayBuffer()));
  console.log(`${name} is in dev-models/`);
}
