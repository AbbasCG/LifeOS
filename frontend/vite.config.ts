import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
export default defineConfig({
 plugins: [react(), tailwindcss()],
 define: { __BUILD_ID__: JSON.stringify(process.env.LIFEOS_BUILD_ID || Date.now().toString(36)) },
 server: { proxy: { '/api': { target: 'http://127.0.0.1:8000', changeOrigin: true }, '/sanctum': { target: 'http://127.0.0.1:8000', changeOrigin: true } } },
})
