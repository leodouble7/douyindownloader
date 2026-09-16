import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { createRequire } from 'node:module';

const copyOutputWorkers = createRequire(import.meta.url)('./scripts/copy-output-worker.cjs') as () => void;

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), { name: 'copy-output-workers', writeBundle: copyOutputWorkers }]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [react()]
  }
});
