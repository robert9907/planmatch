import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
  },
  build: {
    // Production source maps — Vite equivalent of Next.js's
    // productionBrowserSourceMaps. Lets Sentry / browser DevTools map
    // minified frames back to TS/TSX source. The dist/.map files ship
    // alongside the JS bundle; Vercel serves them on demand only when
    // DevTools requests them, so users never pay for the download.
    sourcemap: true,
  },
});
