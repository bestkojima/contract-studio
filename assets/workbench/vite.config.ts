import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { api } from './server/api.mjs';
export default defineConfig({
  plugins: [react(), { name:'contract-studio-api', configureServer(server){server.middlewares.use(api)}, configurePreviewServer(server){server.middlewares.use(api)} }],
  server: { port:5173, strictPort:true },
  preview: { port:4173 }
});
