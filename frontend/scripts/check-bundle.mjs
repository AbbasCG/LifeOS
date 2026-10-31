// Keeps the first load of the app small on a phone: fails when what every page downloads (the entry script and the
// stylesheet, gzipped) grows past a budget. Run after `npm run build`. Raise a budget only on purpose.
import { readFileSync, readdirSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

const BUDGET_KB = { js: 125, css: 45 }
const dist = new URL('../dist/', import.meta.url)
const html = readFileSync(new URL('index.html', dist), 'utf8')
const entries = { js: html.match(/src="\/(assets\/index-[^"]+\.js)"/)?.[1], css: html.match(/href="\/(assets\/index-[^"]+\.css)"/)?.[1] }
if (!entries.js || !entries.css) { console.error('Could not find the entry script and stylesheet in dist/index.html. Run `npm run build` first.'); process.exit(2) }

let failed = false
for (const [kind, file] of Object.entries(entries)) {
  const kb = gzipSync(readFileSync(new URL(file, dist))).length / 1024
  const ok = kb <= BUDGET_KB[kind]
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${file}: ${kb.toFixed(1)} KB gzipped (budget ${BUDGET_KB[kind]} KB)`)
  if (!ok) failed = true
}
const lazy = readdirSync(new URL('assets/', dist)).filter(f => f.endsWith('.js') && !f.startsWith('index-'))
console.log(`${lazy.length} lazy chunks load only when their page or sheet opens.`)
process.exit(failed ? 1 : 0)
