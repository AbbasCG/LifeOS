import { createReadStream, existsSync, readdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Where the stylesheet asks for the fonts, and the exact file names it asks for (kept in step with `fonts.css` by a test). */
export const FONT_URL_PREFIX = '/fonts/thmanyah/'
export const FONT_FILES = /** @type {string[]} */ ([
  'thmanyahsans-Light.woff2', 'thmanyahsans-Regular.woff2', 'thmanyahsans-Medium.woff2', 'thmanyahsans-Bold.woff2', 'thmanyahsans-Black.woff2',
  'thmanyahserifdisplay-Bold.woff2', 'thmanyahserifdisplay-Black.woff2',
])

const same = (a, b) => a.toLowerCase() === b.toLowerCase()

/** The folder holding the licensed fonts, whatever its capitalisation (`thmanyah`, `Thmanyah`, ...), or null. */
export function fontFolder(fontsRoot) {
  if (!existsSync(fontsRoot)) return null
  const dir = readdirSync(fontsRoot, { withFileTypes: true }).find(e => e.isDirectory() && same(e.name, 'thmanyah'))
  return dir ? join(fontsRoot, dir.name) : null
}

/** One font file by name, ignoring upper/lower case in the file name too; null when it is not installed. */
export function findFont(fontsRoot, fileName) {
  const folder = fontFolder(fontsRoot)
  if (!folder || fileName.includes('/') || fileName.includes('\\') || fileName.includes('..')) return null
  const file = readdirSync(folder).find(f => same(f, fileName))
  return file ? join(folder, file) : null
}

/** The font files the app asks for, and which of them are installed (for `npm run check:fonts`). */
export function fontReport(fontsRoot, wanted) {
  const folder = fontFolder(fontsRoot)
  const found = [], missing = []
  for (const name of wanted) (findFont(fontsRoot, name) ? found : missing).push(name)
  return { folder, found, missing }
}

/**
 * Serves and builds the Thmanyah fonts from `public/fonts/<any capitalisation of thmanyah>/`, matching file names without regard
 * to case. A Windows or macOS folder named `Thmanyah` works on the dev server, and the build always writes them to
 * `fonts/thmanyah/` in lower case, which is what the stylesheet asks for and what a Linux web server needs.
 */
export function thmanyahFonts(publicDir = 'public') {
  const root = join(publicDir, 'fonts')
  let outDir = 'dist'
  return {
    name: 'lifeos-thmanyah-fonts',
    configResolved(config) { outDir = config.build.outDir },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = decodeURIComponent((req.url ?? '').split('?')[0])
        if (!path.startsWith(FONT_URL_PREFIX)) return next()
        const file = findFont(root, path.slice(FONT_URL_PREFIX.length))
        if (!file) return next()
        res.setHeader('Content-Type', 'font/woff2')
        res.setHeader('Content-Length', String(statSync(file).size))
        createReadStream(file).pipe(res)
      })
    },
    closeBundle: {
      order: 'post',
      handler() {
        const builtRoot = join(outDir, 'fonts')
        const folder = fontFolder(builtRoot)
        if (!folder) return
        const target = join(builtRoot, 'thmanyah')
        if (folder !== target) renameSync(folder, join(builtRoot, '.thmanyah-tmp')), renameSync(join(builtRoot, '.thmanyah-tmp'), target)
        for (const wanted of FONT_FILES) {
          const have = readdirSync(target).find(f => same(f, wanted))
          if (have && have !== wanted) renameSync(join(target, have), join(target, wanted))
        }
      },
    },
  }
}
