import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

// Vite SPA → talks to the per-client Fastify engine (packages/api). Static build, no SSR
// (deliberate: the engine is the backend; a static SPA keeps "one build, N runtimes" — tech-stack §1).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    proxy: {
      // dev: proxy API calls to the local engine
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
    },
  },
});
