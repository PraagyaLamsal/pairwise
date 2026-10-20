import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

const shared = resolve(__dirname, 'src/shared');

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': shared } },
    build: {
      outDir: 'out/main',
      externalizeDeps: true,
      rolldownOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
        // Native modules and ESM-only libraries are loaded at runtime from node_modules.
        external: ['uiohook-napi', '@jitsi/robotjs', 'get-windows', 'pdfjs-dist', 'electron'],
      },
    },
  },
  preload: {
    resolve: { alias: { '@shared': shared } },
    build: {
      outDir: 'out/preload',
      rolldownOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias: { '@shared': shared, '@ui': resolve(__dirname, 'src/renderer/ui') } },
    plugins: [react()],
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      emptyOutDir: true,
      rolldownOptions: {
        input: {
          hub: resolve(__dirname, 'src/renderer/hub/index.html'),
          hud: resolve(__dirname, 'src/renderer/hud/index.html'),
          overlay: resolve(__dirname, 'src/renderer/overlay/index.html'),
          engine: resolve(__dirname, 'src/renderer/engine/index.html'),
          whiteboard: resolve(__dirname, 'src/renderer/whiteboard/index.html'),
        },
      },
    },
  },
});
