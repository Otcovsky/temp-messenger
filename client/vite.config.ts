import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// В разработке WebSocket проксируется на локальный Python-сервер.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:8100', ws: true },
    },
  },
  build: { target: 'es2022', sourcemap: true },
})
