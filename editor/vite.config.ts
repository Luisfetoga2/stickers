import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The app loads the editor from https://appassets.androidplatform.net/assets/editor/,
// so every asset path must be relative.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    target: 'es2022',
    outDir: '../android/app/src/main/assets/editor',
    emptyOutDir: true,
  },
});
