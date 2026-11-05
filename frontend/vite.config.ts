import { defineConfig, type Plugin } from 'vite'
import { thmanyahFonts } from './scripts/thmanyahFonts.mjs'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
/** The production page may only load its own scripts, and talk to its own origin (set at build time, so the dev server's hot reload is untouched). */
export const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; media-src 'self' blob: data:; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'"
const contentSecurityPolicy = (): Plugin => ({
 name: 'lifeos-csp',
 apply: 'build',
 transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' }],
})
export default defineConfig({
 plugins: [react(), tailwindcss(), thmanyahFonts(), contentSecurityPolicy()],
 define: { __BUILD_ID__: JSON.stringify(process.env.LIFEOS_BUILD_ID || Date.now().toString(36)) },
 server: { proxy: { '/api': { target: 'http://127.0.0.1:8000', changeOrigin: true }, '/sanctum': { target: 'http://127.0.0.1:8000', changeOrigin: true } } },
})
