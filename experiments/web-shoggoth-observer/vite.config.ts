import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/events': {
        target: 'http://127.0.0.1:8559',
        changeOrigin: true,
      },
      '/ingest': {
        target: 'http://127.0.0.1:8559',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
