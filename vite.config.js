// MultimediaMX — GPL-3.0-or-later
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022', chunkSizeWarningLimit: 1500 },
  server: { port: 5173, strictPort: true }
});
