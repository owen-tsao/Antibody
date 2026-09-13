import path from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  server: {
    // FastAPI adapter (Slice 1) runs on :8000; the UI only ever talks to /api/*. Override with
    // API_PORT to point a second Vite at a scratch API while a real loop owns :8000.
    proxy: { '/api': `http://127.0.0.1:${process.env.API_PORT ?? 8000}` },
  },
})
