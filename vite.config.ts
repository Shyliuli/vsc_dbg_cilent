import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dev server proxies API and the DAP websocket to the Node backend so
// that the browser talks to a single origin in both dev and production.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '/ws': { target: 'ws://127.0.0.1:3000', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 5000,
  },
});
