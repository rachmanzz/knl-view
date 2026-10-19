import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const apiPort = process.env.KNL_API_PORT || '8085'

export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': `http://127.0.0.1:${apiPort}`
    }
  },
  build: {
    outDir: 'dist',
    sourcemap: false
  }
})
